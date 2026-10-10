// Maintainer checks use the installed Git CLI and Node's standard library only.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const maintainer = 'Giovanni Jecha';
const email = '100841799+giovannijecha@users.noreply.github.com';
const attribution = /co-authored-by\s*:|(?:^|\n)[\s\p{So}\p{M}]*generated\s+(?:with|by)|(?:^|\n)\s*[a-z0-9_-]+-session\s*:/iu;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function checkMessage(message, context) {
  if (attribution.test(message)) throw new Error(`${context} contains attribution or a coauthor.`);
}

function checkIdentity(name, address, context, allowGitHub = false) {
  if (name === maintainer && address === email) return;
  if (allowGitHub && name === 'GitHub' && address === 'noreply@github.com') return;
  throw new Error(`${context} must use ${maintainer} <${email}>.`);
}

function checkPending(messagePath) {
  for (const role of ['AUTHOR', 'COMMITTER']) {
    const identity = git('var', `GIT_${role}_IDENT`).match(/^(.*) <([^<>]+)> \d+ [+-]\d{4}$/);
    if (!identity) throw new Error(`Cannot verify the pending ${role.toLowerCase()}.`);
    checkIdentity(identity[1], identity[2], `Pending ${role.toLowerCase()}`);
  }
  checkMessage(readFileSync(messagePath, 'utf8'), 'Commit message');
}

function checkHistory(revisions, baseline = []) {
  const checked = new Set();
  for (const hash of baseline) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash)) throw new Error('Invalid attribution baseline.');
  }
  for (const revision of revisions) {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(revision)) throw new Error('Invalid commit ID.');
    const hashes = git('rev-list', revision, ...(baseline.length ? ['--not', ...baseline] : []));
    for (const hash of hashes.split(/\r?\n/).filter(Boolean)) {
      if (checked.has(hash)) continue;
      const fields = git('show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', hash).split('\0');
      if (fields.length !== 5) throw new Error(`Cannot verify commit ${hash}.`);
      checkIdentity(fields[0], fields[1], `Author of ${hash}`);
      checkIdentity(fields[2], fields[3], `Committer of ${hash}`, true);
      checkMessage(fields[4], `Commit ${hash}`);
      checked.add(hash);
    }
  }
  console.log(`Commit attribution verified (${checked.size} commits).`);
}

function pushBaseline() {
  let baseline;
  try {
    baseline = git('config', '--get-all', 'attribution.baseline').split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
  return baseline.filter(hash => {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hash)) throw new Error('Invalid attribution baseline.');
    try {
      git('cat-file', '-e', `${hash}^{commit}`);
      return true;
    } catch (error) {
      if (error.status === 1 || error.status === 128) return false;
      throw error;
    }
  });
}

function checkEvent(eventPath) {
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  const pr = event.pull_request;
  if (!pr) return checkHistory([git('rev-parse', 'HEAD')]);
  if (pr.user.login !== 'giovannijecha') throw new Error('Pull requests must be authored by the maintainer.');
  checkMessage(`${pr.title}\n${pr.body ?? ''}`, 'Pull request');
  const head = pr.head.sha;
  if (!/^[a-f0-9]{40}$/i.test(head)) throw new Error('Invalid pull request commit ID.');
  try {
    git('cat-file', '-e', `${head}^{commit}`);
  } catch {
    git('fetch', '--no-tags', 'origin', head);
  }
  checkHistory([head]);
}

try {
  const [mode, argument, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected arguments.');
  if (mode === '--pending' && argument) checkPending(argument);
  else if (mode === '--event' && argument) checkEvent(argument);
  else if (mode === '--history') checkHistory([git('rev-parse', '--verify', `${argument ?? 'HEAD'}^{commit}`)]);
  else if (mode === '--pre-push' && !argument) {
    const revisions = readFileSync(0, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 4) throw new Error('Invalid pre-push input.');
      return fields[1];
    }).filter(hash => !/^0+$/.test(hash));
    checkHistory(revisions, pushBaseline());
  } else throw new Error('Use --pending FILE, --pre-push, --history [REV], or --event FILE.');
} catch (error) {
  console.error(`Attribution check failed: ${error.message}`);
  process.exitCode = 1;
}
