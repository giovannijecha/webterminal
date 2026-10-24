// Dropped files are staged by the server for the controlling view, then
// pasted as quoted local paths, the way native terminals deliver a drop.
export const FILE_LIMIT = 1024 ** 3;
export const DROP_LIMIT = 64;
// Failed uploads keep their File for Retry; the oldest finished ones go first.
export const TRANSFER_LIMIT = 128;
// A finished upload stays listed until the server's copy list includes it.
const DONE_GRACE = 10000;

// Read synchronously inside the drop event; folders are skipped.
export function droppedFiles(transfer) {
  const items = [...(transfer?.items || [])].filter(item => item.kind === 'file');
  if (!items.length) return [...(transfer?.files || [])];
  return items.filter(item => !item.webkitGetAsEntry?.()?.isDirectory).map(item => item.getAsFile()).filter(Boolean);
}

function shellName(shell) {
  const command = shell.trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return (command?.[1] || command?.[2] || command?.[3] || '').split(/[\\/]/).pop().toLowerCase();
}

function isCmd(shell) { return ['cmd', 'cmd.exe'].includes(shellName(shell)); }
const cmdExpansionProblem = 'cmd.exe expands % and may expand ! in paths; rename the file or use PowerShell before dropping it.';
const cmdExpansion = path => /[%!]/.test(path);

export function pathList(paths, shell = 'powershell.exe') {
  const executable = shellName(shell);
  if (isCmd(shell) && paths.some(cmdExpansion)) throw new Error(cmdExpansionProblem);
  const powerShell = ['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(executable);
  return paths.map(path => powerShell ? `'${path.replaceAll("'", "''")}'` : `"${path}"`).join(' ');
}

export function dropProblem(files, shell = 'powershell.exe', limits = {}) {
  const count = Number.isSafeInteger(limits.uploadFiles) && limits.uploadFiles > 0 ? limits.uploadFiles : DROP_LIMIT;
  const size = Number.isSafeInteger(limits.uploadBytes) && limits.uploadBytes > 0 ? limits.uploadBytes : FILE_LIMIT;
  if (files.length > count) return `Drop at most ${count} ${count === 1 ? 'file' : 'files'} at once.`;
  const large = files.find(file => file.size > size);
  if (large) return `${large.name} is larger than ${size === FILE_LIMIT ? '1 GiB' : `${size} bytes`}.`;
  return isCmd(shell) && files.some(file => cmdExpansion(file.name)) ? cmdExpansionProblem : null;
}

export function uploadUrl(file, {id, view, epoch}) {
  return `/api/upload?id=${encodeURIComponent(id)}&view=${encodeURIComponent(view)}&epoch=${epoch}&name=${encodeURIComponent(file.name)}`;
}

// One file over XMLHttpRequest, which reports real upload progress and can be
// aborted. Resolves with the staged copy {path, id, name, size}; rejects with
// an Error whose `cancelled` is true after abort().
export function sendFile(file, target, {XHR = globalThis.XMLHttpRequest, progress} = {}) {
  const xhr = new XHR();
  const promise = new Promise((resolve, reject) => {
    const fail = (message, cancelled = false) => reject(Object.assign(new Error(message), {cancelled}));
    xhr.open('POST', uploadUrl(file, target));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (xhr.upload) xhr.upload.onprogress = event => progress?.(event.loaded, event.lengthComputable ? event.total : file.size);
    xhr.onload = () => {
      let reply = null;
      try { reply = JSON.parse(xhr.responseText); } catch { /* reported below */ }
      if (xhr.status >= 200 && xhr.status < 300 && typeof reply?.path === 'string') resolve(reply);
      else fail(reply?.error || `The server answered with status ${xhr.status}.`);
    };
    // A network error also covers a dropped file the browser can no longer read.
    xhr.onerror = () => fail('The upload stopped before the server answered. The connection was lost or the file can no longer be read.');
    xhr.onabort = () => fail('Upload cancelled.', true);
    xhr.send(file);
  });
  return {promise, abort:() => xhr.abort()};
}

// Uploads in this view, one file at a time across every drop, so pasted
// paths never interleave. A file's path is delivered before the next file
// starts, so a later failure cannot hide copies already made. A failure stops
// its batch; failed and skipped files keep their File so Retry resends them.
// Records: {key, name, size, session, target, state: queued | uploading |
// failed | done, loaded, total, error, copy, at, file, ...extra}.
export class UploadQueue {
  constructor({send = sendFile, changed = () => {}, now = Date.now} = {}) {
    Object.assign(this, {send, changed, now, records:[], next:0, tail:Promise.resolve()});
  }
  find(key) { return this.records.find(record => record.key === key) || null; }
  // `deliver(record, copy)` pastes a staged path and returns '' or a problem.
  add(files, target, {deliver, extra = {}} = {}) {
    const records = files.map(file => ({key:`u${++this.next}`, file, name:file.name, size:file.size, session:target.id, target, state:'queued', loaded:0, total:file.size, percent:0, error:'', copy:null, request:null, at:this.now(), ...extra}));
    this.records.push(...records);
    this.trim();
    this.changed();
    return {records, finished:this.serial(records, deliver)};
  }
  retry(key, target, {deliver} = {}) {
    const record = this.find(key);
    if (!record || record.state !== 'failed' || !record.file) return null;
    Object.assign(record, {target, session:target.id, state:'queued', error:'', loaded:0, percent:0, at:this.now()});
    this.changed();
    return {records:[record], finished:this.serial([record], deliver)};
  }
  serial(records, deliver) {
    const finished = this.tail.then(() => this.run(records, deliver));
    this.tail = finished.catch(() => {});
    return finished;
  }
  async run(records, deliver) {
    const result = {staged:[], cancelled:[], failed:null, unpasted:null};
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      const outcome = record.state === 'cancelled' ? 'cancelled' : await this.upload(record, deliver);
      if (outcome === 'staged') { result.staged.push(record); continue; }
      if (outcome === 'cancelled') { result.cancelled.push(record); continue; }
      result[outcome] = record;
      const reason = outcome === 'failed' ? `Not uploaded because ${record.name} failed.` : 'Not uploaded because the previous path could not be pasted.';
      for (const rest of records.slice(index + 1)) if (rest.state === 'queued') this.fail(rest, reason);
      break;
    }
    return result;
  }
  async upload(record, deliver) {
    Object.assign(record, {state:'uploading', loaded:0, percent:0, error:''});
    this.changed();
    const request = this.send(record.file, record.target, {progress:(loaded, total) => this.progress(record, loaded, total)});
    record.request = request;
    let copy;
    try { copy = await request.promise; }
    catch (error) {
      record.request = null;
      if (record.state === 'cancelled' || error.cancelled) { this.drop(record); return 'cancelled'; }
      this.fail(record, error.message);
      return 'failed';
    }
    record.request = null;
    // A response that arrives after Cancel never pastes; its copy stays listed.
    if (record.state === 'cancelled') { this.drop(record); return 'cancelled'; }
    Object.assign(record, {state:'done', copy, file:null, loaded:record.total, percent:100, at:this.now()});
    this.changed();
    const problem = deliver?.(record, copy) || '';
    if (problem) { record.error = problem; return 'unpasted'; }
    return 'staged';
  }
  progress(record, loaded, total) {
    if (record.state !== 'uploading') return;
    record.loaded = loaded;
    if (total > 0) record.total = total;
    const percent = record.total ? Math.min(100, Math.floor((loaded / record.total) * 100)) : 0;
    if (percent === record.percent) return;
    record.percent = percent;
    this.changed();
  }
  fail(record, error) {
    Object.assign(record, {state:'failed', error, request:null});
    this.changed();
  }
  // Cancels a queued or uploading file; returns false when nothing was active.
  cancel(key) {
    const record = this.find(key);
    if (!record || !['queued', 'uploading'].includes(record.state)) return false;
    const request = record.request;
    record.state = 'cancelled';
    if (request) request.abort();
    else this.drop(record);
    return true;
  }
  dismiss(key) {
    const record = this.find(key);
    if (record?.state === 'failed') this.drop(record);
  }
  drop(record) {
    const index = this.records.indexOf(record);
    if (index < 0) return;
    this.records.splice(index, 1);
    this.changed();
  }
  // Finished uploads leave once the server lists their copy, or after a grace period.
  prune(copies) {
    const now = this.now();
    const keep = this.records.filter(record => record.state !== 'done' || (!copies.has(record.copy?.id) && now - record.at < DONE_GRACE));
    if (keep.length !== this.records.length) this.records = keep;
    return this.records;
  }
  forget(copyId) {
    const before = this.records.length;
    this.records = this.records.filter(record => record.copy?.id !== copyId);
    if (this.records.length !== before) this.changed();
  }
  trim() {
    while (this.records.length > TRANSFER_LIMIT) {
      const index = this.records.findIndex(record => ['done', 'failed'].includes(record.state));
      if (index < 0) return;
      this.records.splice(index, 1);
    }
  }
}
