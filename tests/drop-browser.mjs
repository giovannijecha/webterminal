// Optional real Jecode drop acceptance: Chrome drops a file from outside the
// working directory onto an isolated Jecode in the owned Webterminal, then
// optionally presses Alt+V. Jecode reads the clipboard read-only for that
// shortcut and may report either an image or its absence.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeProbe, findChrome, freePort, quote, ready, stopChild} from './cli-browser-support.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = resolve(root, 'target');
const runRoot = resolve(target, `drop-browser-${process.pid}-${Date.now()}`);
assert.ok(runRoot.startsWith(target + sep));
const jecode = process.env.WEBTERMINAL_JECODE_EXE;
if (!jecode) throw new Error('Set WEBTERMINAL_JECODE_EXE to an installed Jecode executable');
const fileOnly = process.env.WEBTERMINAL_DROP_FILE_ONLY === '1';
const viaPowerShell = process.env.WEBTERMINAL_DROP_POWERSHELL === '1';
const binDirectory = resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(target, 'debug'));
const chrome = await findChrome();

// Page steps run through DevTools in the product page; no harness is injected.
const page = {
  create: async cwd => {
    const $ = id => document.getElementById(id), pause = ms => new Promise(done => setTimeout(done, ms));
    const until = async (probe, label) => { for (let i = 0; i < 600; i++) { if (await probe()) return; await pause(50); } throw new Error('Timed out: ' + label); };
    await until(() => $('new') && !$('new').disabled, 'connection');
    $('new').click();
    await until(() => $('directory-dialog').open, 'directory dialog');
    $('directory-address').click();
    $('directory-path').value = cwd;
    $('directory-path').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
    await until(() => !$('directory-create').disabled, 'selected directory');
    $('directory-create').click();
    try { await until(() => ($('terminal-lines').textContent || '').includes('Ask anything'), 'Jecode composer'); }
    catch (error) { throw new Error(error.message + ': ' + ($('terminal-lines').textContent || '').slice(-600)); }
    await until(() => $('pane').dataset.status === 'Controlling', 'controller');
    const sessions = await (await fetch('/api/sessions')).json();
    const id = sessions.sessions[0].id;
    const observer = new WebSocket('ws://' + location.host + '/ws');
    let modes;
    observer.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id === id && message.terminal?.modes) modes = message.terminal.modes;
    });
    await new Promise((done, fail) => { observer.addEventListener('open', done, {once:true}); observer.addEventListener('error', fail, {once:true}); });
    observer.send(JSON.stringify({op:'attach', id, cols:80, rows:24, updates:false}));
    try {
      for (let i = 0; i < 600 && !modes?.bracketedPaste; i++) await pause(50);
      if (!modes?.bracketedPaste) throw new Error('Timed out waiting for bracketed paste; last modes: ' + JSON.stringify(modes));
    }
    finally { observer.close(); }
    window.__dropInput = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(payload) {
      try {
        const message = JSON.parse(payload);
        if (message.op === 'input') window.__dropInput.push({length:message.data.length, bracketed:message.data.startsWith('\x1b[200~') && message.data.endsWith('\x1b[201~')});
      } catch {}
      return send.call(this, payload);
    };
    $('keyboard').focus();
    const box = $('terminal-scroll').getBoundingClientRect();
    return {x:Math.round(box.left + box.width / 2), y:Math.round(box.top + box.height / 2), modes};
  },
  wait: async needles => {
    for (let i = 0; i < 400; i++) {
      const text = document.getElementById('terminal-lines').textContent || '';
      const found = needles.find(needle => text.includes(needle));
      if (found) return found;
      await new Promise(done => setTimeout(done, 50));
    }
    throw new Error('Timed out waiting for ' + needles.join(' | ') + ': ' + (document.getElementById('terminal-lines').textContent || '').slice(-600));
  },
};
const call = (fn, ...args) => `(${fn})(${args.map(arg => JSON.stringify(arg)).join(',')})`;
async function run(protocol, expression) {
  const reply = await protocol('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result?.value;
}

async function find(directory, name) {
  for (const entry of await readdir(directory, {withFileTypes:true, recursive:true})) {
    if (entry.isFile() && entry.name === name) return join(entry.parentPath, entry.name);
  }
  return null;
}

await mkdir(runRoot, {recursive:true});
let child, staging;
try {
  const copied = {webterminal:resolve(runRoot, 'webterminal.exe'), isolated:resolve(runRoot, 'isolated_cli.exe')};
  await copyFile(resolve(binDirectory, 'webterminal.exe'), copied.webterminal);
  await copyFile(resolve(binDirectory, 'isolated_cli.exe'), copied.isolated);
  const cwd = resolve(runRoot, 'work'), outside = resolve(runRoot, 'outside'), profile = resolve(runRoot, 'cli-profile');
  for (const folder of [cwd, outside, resolve(profile, '.jecode')]) await mkdir(folder, {recursive:true});
  await writeFile(resolve(profile, '.jecode', 'config.json'), JSON.stringify({openrouter:{api_key:'webterminal-isolated-fixture-key', model:'fixture/model'}}));
  const name = process.env.WEBTERMINAL_DROP_NAME || "report ' $x ` $(1+2) β.bin";
  const bytes = Buffer.from(Array.from({length:70_000}, (_, i) => i % 256));
  const attachments = [{name, bytes}];
  if (process.env.WEBTERMINAL_DROP_SECOND_NAME) {
    assert.ok(fileOnly, 'The two-file fixture only exercises file-only drops');
    attachments.push({name:process.env.WEBTERMINAL_DROP_SECOND_NAME, bytes:Buffer.from('second file fixture')});
  }
  for (const attachment of attachments) {
    attachment.source = resolve(outside, attachment.name);
    await writeFile(attachment.source, attachment.bytes);
  }

  const port = await freePort();
  const environment = {};
  for (const key of ['SystemRoot','SystemDrive','WINDIR','PATH','PATHEXT','ComSpec','ProgramFiles','ProgramFiles(x86)','ProgramW6432','TEMP','TMP']) if (process.env[key]) environment[key] = process.env[key];
  const direct = [copied.isolated, profile, jecode].map(quote).join(' ');
  const script = '& ' + [copied.isolated, profile, jecode].map(path => `'${path.replaceAll("'", "''")}'`).join(' ');
  const command = viaPowerShell ? `powershell.exe -NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}` : direct;
  child = spawn(copied.webterminal, ['--port', String(port), '--cwd', cwd, '--shell', command], {cwd, env:environment, windowsHide:true, stdio:['ignore','pipe','pipe']});
  staging = join(tmpdir(), 'webterminal-uploads', `${child.pid}-${port}`);
  await ready(port, child);

  const checks = [];
  let started = false;
  const report = await chromeProbe(chrome, `http://127.0.0.1:${port}/`, resolve(runRoot, 'chrome-profile'), 'probeStage', async ({protocol, evaluate}) => {
    if (started) return;
    if (await evaluate('document.readyState === "complete" && Boolean(document.getElementById("new"))').catch(() => false) !== true) return;
    started = true;
    const result = {pass:false, checks};
    let step = 'load';
    try {
      step = 'create';
      const point = await run(protocol, call(page.create, cwd));
      checks.push(`terminal modes before drop: ${JSON.stringify(point.modes)}`);
      await protocol('Input.insertText', {text:'see '});
      await run(protocol, call(page.wait, ['› see ']));
      const data = {items:[], files:attachments.map(attachment => attachment.source), dragOperationsMask:1};
      for (const type of ['dragEnter', 'dragOver', 'drop']) await protocol('Input.dispatchDragEvent', {type, x:point.x, y:point.y, data});
      step = 'drop';
      for (const [index, attachment] of attachments.entries()) {
        let staged;
        for (let i = 0; i < 200 && !staged; i++) {
          staged = await find(staging, attachment.name).catch(() => null);
          if (!staged) await new Promise(done => setTimeout(done, 50));
        }
        assert.ok(staged, `staged copy exists: ${attachment.name}`);
        assert.deepEqual(await readFile(staged), attachment.bytes);
        await run(protocol, call(page.wait, [`[${index + 1}# File: ${attachment.name}]`]));
        const pooled = await find(resolve(profile, '.jecode'), attachment.name);
        assert.ok(pooled, `Jecode stored its own copy: ${attachment.name}`);
        assert.deepEqual(await readFile(pooled), attachment.bytes);
      }
      checks.push(`${attachments.length} file(s) staged with exact bytes and attached in order`);
      if (!fileOnly) {
        step = 'Alt+V';
        for (const type of ['rawKeyDown', 'keyUp']) await protocol('Input.dispatchKeyEvent', {type, modifiers:1, key:'v', code:'KeyV', windowsVirtualKeyCode:86});
        const outcome = await run(protocol, call(page.wait, ['[2# Image]', 'clipboard has no image']));
        checks.push(`Alt+V reached Jecode (${outcome === '[2# Image]' ? 'image attached' : 'no clipboard image'})`);
      }
      result.pass = true;
    } catch (error) {
      const pooled = await find(resolve(profile, '.jecode'), name).catch(() => null);
      result.error = step + ': ' + String(error?.stack || error) + ' input=' + JSON.stringify(await evaluate('window.__dropInput || []')) + ' pooled=' + Boolean(pooled);
    }
    const encoded = Buffer.from(JSON.stringify(result)).toString('base64');
    await evaluate(`document.body.dataset.probeResult=${JSON.stringify(encoded)}`);
  });
  for (const item of report.checks) console.log('PASS ' + item);
  if (!report.pass) console.log('FAIL ' + report.error);
  assert.equal(report.pass, true, 'Drop acceptance failed');
} finally {
  await stopChild(child);
  // A killed server cannot clean up; a later server would sweep this too.
  if (staging) {
    await rm(staging, {recursive:true, force:true, maxRetries:10, retryDelay:100});
    await rm(staging + '.lock', {force:true, maxRetries:10, retryDelay:100});
  }
  await rm(runRoot, {recursive:true, force:true, maxRetries:10, retryDelay:100});
}
