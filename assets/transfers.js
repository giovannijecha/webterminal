// Uploads of dropped files for this view. Paths are pasted only while the
// same view still controls the same terminal epoch; a cancelled upload or a
// late response never pastes or moves focus.
import {UploadQueue, dropProblem, pathList} from './upload.js';
import {queueInput} from './connection.js';
import {canInput, changed, go, state, terminalName} from './model.js';
import {notify, problem, toasts} from './ui.js';
import {plural} from './dom.js';
import {pastePayload} from './input.js';

const queue = new UploadQueue({changed:() => { changed('transfers'); progressNotice(); }});
let notice = null;

const shellOf = id => state.sessions.get(id)?.shell || state.hello?.shell || '';
const current = id => ({id, view:state.view, epoch:state.snapshots.get(id)?.epoch});
const holds = target => state.view === target.view && state.snapshots.get(target.id)?.epoch === target.epoch && canInput(target.id);

// Same encoding as a keyboard paste when the drop pane no longer shows the terminal.
function paste(id, text, pane) {
  if (pane?.id === id) { pane.input.pasteText(text); return ''; }
  return queueInput(id, pastePayload(text, state.snapshots.get(id)?.terminal?.modes));
}

function deliver(record, copy) {
  if (!holds(record.target)) return `control of ${terminalName(record.session) || 'the terminal'} changed, so its path was not pasted.`;
  // Each file arrives as its own paste; a space separates adjacent paths.
  try { return paste(record.session, `${pathList([copy.path], shellOf(record.session))} `, record.pane); }
  catch (error) { return error.message; }
}

// Records for the Dropped files page; finished ones leave once the server lists them.
export function transfers() { return queue.prune(new Set(state.files.files.map(copy => copy.id))); }

export function stageDrop(pane, files) {
  if (!files.length) return;
  if (!canInput(pane.id)) { problem('Take control to drop files', 'Only the view that controls this terminal can paste file paths into it.'); return; }
  const issue = dropProblem(files, shellOf(pane.id), state.hello?.limits);
  if (issue) { problem('Files not dropped', issue); return; }
  const copies = state.hello?.limits?.uploadCopies || state.files.limit;
  if (copies && state.files.files.length + files.length > copies) {
    problem('Staged copy limit', `Webterminal keeps up to ${copies} staged copies. Remove dropped files or drop fewer files.`);
    return;
  }
  return track(queue.add(files, current(pane.id), {deliver, extra:{pane}}));
}

// Retry sends the retained File again; returns a problem or ''.
export async function retryUpload(key) {
  const record = queue.find(key);
  if (!record || record.state !== 'failed') return 'This upload is no longer listed.';
  if (!record.file) return `Drop ${record.name} on the terminal again; the browser no longer holds it.`;
  if (!state.sessions.has(record.session)) return `${record.name} cannot be retried because its terminal was closed.`;
  if (!canInput(record.session)) return `Take control of ${terminalName(record.session)} to retry.`;
  try { await record.file.slice(0, 1).arrayBuffer(); }
  catch {
    record.file = null;
    changed('transfers');
    return `The browser can no longer read ${record.name}. Drop it on the terminal again.`;
  }
  const started = queue.retry(key, current(record.session), {deliver});
  if (!started) return 'This upload cannot be retried.';
  track(started);
  return '';
}

export function cancelUpload(key) { return queue.cancel(key); }
export function dismissUpload(key) { queue.dismiss(key); }
export function forgetCopy(id) { queue.forget(id); }

async function track({records, finished}) {
  const id = records[0].session, name = terminalName(id) || 'the terminal';
  const cancelAll = () => records.forEach(record => queue.cancel(record.key));
  notice = {records, name};
  const title = records.length === 1 ? `Uploading ${records[0].name}` : `Uploading ${records.length} files`;
  notice.node = toasts.show({title, text:progressText(notice), action:{label:'Cancel', run:cancelAll}, key:'upload', sticky:true});
  const result = await finished;
  if (notice?.records === records) notice = null;
  report(result, records, name);
}

function progressText({records, name}) {
  const active = records.find(record => record.state === 'uploading');
  const done = records.filter(record => record.state === 'done').length;
  if (!active) return `To ${name}`;
  const position = records.length > 1 ? ` · ${Math.min(done + 1, records.length)} of ${records.length}` : '';
  return `To ${name}${position} · ${active.percent}%`;
}

// Updates the progress toast in place; a dismissed toast stays dismissed.
function progressNotice() {
  if (!toasts.shown(notice?.node)) return;
  const text = notice.node.querySelector('p');
  if (text) text.textContent = progressText(notice);
}

function report({staged, cancelled, failed, unpasted}, records, name) {
  const review = (filter, label = 'Review') => ({label, run:() => go('files', filter ? {filter} : null)});
  const before = staged.length ? ` ${plural(staged.length, 'file')} staged before it.` : '';
  if (failed) { problem('Upload stopped', `${failed.name}: ${failed.error}${before}`, review('failed'), 'upload'); return; }
  if (unpasted) { problem('Path not pasted', `${unpasted.name} was staged, but ${unpasted.error}`, review(''), 'upload'); return; }
  if (cancelled.length && !staged.length) { notify('Upload cancelled', 'No path was pasted for the cancelled files.', null, 'upload'); return; }
  if (cancelled.length) { notify(`${plural(staged.length, 'file')} added`, `${plural(cancelled.length, 'upload')} cancelled; no path was pasted for them.`, review(''), 'upload'); return; }
  if (staged.length === 1) notify('File added', `${staged[0].name} · path pasted into ${name}.`, review('', 'View files'), 'upload');
  else notify(`${staged.length} files added`, `Paths pasted into ${name}.`, review('', 'View files'), 'upload');
}
