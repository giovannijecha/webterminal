import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DROP_LIMIT, FILE_LIMIT, UploadQueue, dropProblem, droppedFiles, pathList, sendFile} from '../assets/upload.js';

const file = (name, size = 1) => ({name, size});
const target = {id:'s1', view:'v7', epoch:3};
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

test('drops keep files in order and skip folders', () => {
  const a = file('a.txt'), b = file('b.png');
  const item = (value, directory = false) => ({kind:'file', getAsFile:() => value, webkitGetAsEntry:() => ({isDirectory:directory})});
  const transfer = {items:[item(a), item(file('folder', 0), true), {kind:'string'}, item(b)], files:[]};
  assert.deepEqual(droppedFiles(transfer), [a, b]);
  assert.deepEqual(droppedFiles({items:[], files:[a]}), [a]);
  assert.deepEqual(droppedFiles(null), []);
});

test('staged paths are pasted quoted and space separated', () => {
  assert.equal(pathList(['C:\\Temp\\a b.txt', 'C:\\Temp\\c.pdf']), "'C:\\Temp\\a b.txt' 'C:\\Temp\\c.pdf'");
  assert.equal(pathList(["C:\\Temp\\a'b $x ` $(1+2).txt"]), "'C:\\Temp\\a''b $x ` $(1+2).txt'");
  assert.equal(pathList(['C:\\Temp\\a b.txt'], '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile'), "'C:\\Temp\\a b.txt'");
  assert.equal(pathList(['C:\\Temp\\a b.txt'], 'cmd.exe'), '"C:\\Temp\\a b.txt"');
  assert.equal(pathList(['C:\\Temp\\a b.txt'], 'wsl.exe'), '"C:\\Temp\\a b.txt"');
  assert.throws(() => pathList(['C:\\Temp\\a%PATH%.txt'], 'cmd.exe'), /cmd\.exe.*%/);
  assert.throws(() => pathList(['C:\\Temp\\a!PATH!.txt'], 'cmd.exe /v:on'), /cmd\.exe.*!/);
});

test('staged path round trips through the default PowerShell shell', {skip:process.platform !== 'win32'}, () => {
  const path = "C:\\Temp\\a'b $x ` $(1+2) & [one] ; 日本.txt";
  const command = `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${pathList([path])}))`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'), path);
});

test('drops are bounded before anything is uploaded', () => {
  assert.equal(dropProblem([file('a')]), null);
  assert.match(dropProblem(Array.from({length:DROP_LIMIT + 1}, (_, i) => file(`${i}`))), /at most 64/);
  assert.match(dropProblem([file('huge.iso', FILE_LIMIT + 1)]), /huge\.iso is larger than 1 GiB/);
  assert.match(dropProblem([file('a%PATH%.txt')], 'cmd.exe'), /cmd\.exe.*%/);
  assert.match(dropProblem([file('a!PATH!.txt')], 'cmd.exe /v:on'), /cmd\.exe.*!/);
  assert.equal(dropProblem([file('a%PATH%.txt')], 'powershell.exe'), null);
});

// A scriptable XMLHttpRequest: each instance waits for respond/fail/abort.
class FakeXHR {
  static made = [];
  constructor() { Object.assign(this, {upload:{}, headers:{}}); FakeXHR.made.push(this); }
  open(method, url) { Object.assign(this, {method, url}); }
  setRequestHeader(name, value) { this.headers[name] = value; }
  send(body) { this.body = body; }
  abort() { this.aborted = true; this.onabort?.(); }
  progress(loaded, total) { this.upload.onprogress?.({loaded, total, lengthComputable:true}); }
  respond(status, body) { Object.assign(this, {status, responseText:typeof body === 'string' ? body : JSON.stringify(body)}); this.onload(); }
}

test('sendFile posts the raw file to the controlling view and reports real progress', async () => {
  FakeXHR.made = [];
  const seen = [], body = file('report 日本 a&b=c.pdf', 200);
  const {promise} = sendFile(body, target, {XHR:FakeXHR, progress:(loaded, total) => seen.push([loaded, total])});
  const xhr = FakeXHR.made[0];
  assert.equal(xhr.method, 'POST');
  assert.equal(xhr.url, `/api/upload?id=s1&view=v7&epoch=3&name=${encodeURIComponent(body.name)}`);
  assert.equal(xhr.headers['Content-Type'], 'application/octet-stream');
  assert.equal(xhr.body, body);
  xhr.progress(50, 200);
  xhr.progress(200, 200);
  xhr.respond(200, {path:'C:\\staged\\report.pdf', id:'f1', name:'report.pdf', size:200});
  assert.deepEqual(await promise, {path:'C:\\staged\\report.pdf', id:'f1', name:'report.pdf', size:200});
  assert.deepEqual(seen, [[50, 200], [200, 200]]);
});

test('sendFile reports server refusals, network failures and cancellation', async () => {
  FakeXHR.made = [];
  const refused = sendFile(file('a'), target, {XHR:FakeXHR});
  FakeXHR.made[0].respond(409, {error:'Control changed during upload; the copy was discarded'});
  await assert.rejects(refused.promise, error => /Control changed/.test(error.message) && !error.cancelled);
  const broken = sendFile(file('b'), target, {XHR:FakeXHR});
  FakeXHR.made[1].onerror();
  await assert.rejects(broken.promise, /stopped before the server answered/);
  const garbled = sendFile(file('c'), target, {XHR:FakeXHR});
  FakeXHR.made[2].respond(502, 'Bad gateway');
  await assert.rejects(garbled.promise, /status 502/);
  const cancelled = sendFile(file('d'), target, {XHR:FakeXHR});
  cancelled.abort();
  assert.equal(FakeXHR.made[3].aborted, true);
  await assert.rejects(cancelled.promise, error => error.cancelled === true);
});

// A queue over FakeXHR, so cancellation goes through a real abort().
function harness() {
  FakeXHR.made = [];
  let changes = 0;
  const delivered = [];
  const queue = new UploadQueue({send:(body, to, options) => sendFile(body, to, {...options, XHR:FakeXHR}), changed:() => changes++});
  const deliver = (record, copy) => { delivered.push([record.name, copy.path]); return ''; };
  return {queue, deliver, delivered, changes:() => changes};
}

test('files upload one at a time and each path is delivered before the next starts', async () => {
  const {queue, deliver, delivered} = harness();
  const {records, finished} = queue.add([file('a', 10), file('b', 10)], target, {deliver});
  await settle();
  assert.equal(FakeXHR.made.length, 1);
  assert.deepEqual(records.map(record => record.state), ['uploading', 'queued']);
  FakeXHR.made[0].respond(200, {path:'C:\\staged\\a', id:'f1'});
  await settle();
  assert.deepEqual(delivered, [['a', 'C:\\staged\\a']]);
  assert.equal(FakeXHR.made.length, 2);
  FakeXHR.made[1].respond(200, {path:'C:\\staged\\b', id:'f2'});
  const result = await finished;
  assert.deepEqual(result.staged.map(record => record.name), ['a', 'b']);
  assert.deepEqual(delivered.map(([name]) => name), ['a', 'b']);
  assert.equal(records[0].file, null, 'a staged file is released');
});

test('progress notifies only when the whole percentage changes', async () => {
  const {queue, deliver, changes} = harness();
  const {records} = queue.add([file('a', 1000)], target, {deliver});
  await settle();
  const before = changes(), xhr = FakeXHR.made[0];
  xhr.progress(1, 1000);
  xhr.progress(5, 1000);
  assert.equal(changes(), before);
  xhr.progress(500, 1000);
  assert.equal(records[0].percent, 50);
  assert.equal(changes(), before + 1);
});

test('a failure stops its batch, keeps the files, and Retry resends the same bytes', async () => {
  const {queue, deliver, delivered} = harness();
  const a = file('a'), b = file('b'), c = file('c');
  const {records, finished} = queue.add([a, b, c], target, {deliver});
  await settle();
  FakeXHR.made[0].respond(200, {path:'C:\\staged\\a', id:'f1'});
  await settle();
  FakeXHR.made[1].respond(413, {error:'The disk quota was exceeded'});
  const result = await finished;
  assert.equal(result.failed, records[1]);
  assert.deepEqual(delivered.map(([name]) => name), ['a']);
  assert.deepEqual(records.map(record => record.state), ['done', 'failed', 'failed']);
  assert.match(records[1].error, /quota/);
  assert.match(records[2].error, /Not uploaded because b failed/);
  assert.equal(records[1].file, b);
  assert.equal(FakeXHR.made.length, 2, 'the skipped file was never sent');
  const retry = queue.retry(records[2].key, {...target, epoch:4}, {deliver});
  await settle();
  assert.equal(FakeXHR.made[2].body, c);
  assert.match(FakeXHR.made[2].url, /epoch=4/);
  FakeXHR.made[2].respond(200, {path:'C:\\staged\\c', id:'f3'});
  assert.deepEqual((await retry.finished).staged, [records[2]]);
  assert.deepEqual(delivered.map(([name]) => name), ['a', 'c']);
});

test('Cancel aborts the upload, pastes nothing and the batch continues', async () => {
  const {queue, deliver, delivered} = harness();
  const {records, finished} = queue.add([file('a'), file('b')], target, {deliver});
  await settle();
  assert.equal(queue.cancel(records[0].key), true);
  assert.equal(FakeXHR.made[0].aborted, true);
  await settle();
  FakeXHR.made[1].respond(200, {path:'C:\\staged\\b', id:'f2'});
  const result = await finished;
  assert.deepEqual(result.cancelled, [records[0]]);
  assert.deepEqual(delivered.map(([name]) => name), ['b']);
  assert.equal(queue.find(records[0].key), null);
});

test('a response that arrives after Cancel is never pasted', async () => {
  let respond;
  const delivered = [];
  const queue = new UploadQueue({send:() => ({promise:new Promise(resolve => { respond = resolve; }), abort() {}})});
  const {records, finished} = queue.add([file('late')], target, {deliver:record => { delivered.push(record.name); return ''; }});
  await settle();
  queue.cancel(records[0].key);
  respond({path:'C:\\staged\\late', id:'f9'});
  const result = await finished;
  assert.deepEqual(result.cancelled, [records[0]]);
  assert.deepEqual(delivered, []);
});

test('a queued file can be cancelled before it is sent', async () => {
  const {queue, deliver} = harness();
  const {records, finished} = queue.add([file('a'), file('b')], target, {deliver});
  await settle();
  queue.cancel(records[1].key);
  FakeXHR.made[0].respond(200, {path:'C:\\staged\\a', id:'f1'});
  const result = await finished;
  assert.equal(FakeXHR.made.length, 1);
  assert.deepEqual(result.cancelled, [records[1]]);
});

test('a path that cannot be pasted stops the batch', async () => {
  const {queue} = harness();
  const {records, finished} = queue.add([file('a'), file('b')], target, {deliver:() => 'control changed'});
  await settle();
  FakeXHR.made[0].respond(200, {path:'C:\\staged\\a', id:'f1'});
  const result = await finished;
  assert.equal(result.unpasted, records[0]);
  assert.equal(records[0].state, 'done');
  assert.equal(records[1].state, 'failed');
  assert.equal(FakeXHR.made.length, 1);
});

test('separate drops wait for each other so pasted paths never interleave', async () => {
  const {queue, deliver, delivered} = harness();
  const first = queue.add([file('a')], target, {deliver});
  const second = queue.add([file('b')], target, {deliver});
  await settle();
  assert.equal(FakeXHR.made.length, 1);
  assert.equal(second.records[0].state, 'queued');
  FakeXHR.made[0].respond(200, {path:'C:\\staged\\a', id:'f1'});
  await first.finished;
  await settle();
  FakeXHR.made[1].respond(200, {path:'C:\\staged\\b', id:'f2'});
  await second.finished;
  assert.deepEqual(delivered.map(([name]) => name), ['a', 'b']);
});

test('finished uploads leave once the server lists their copy', async () => {
  let now = 1000;
  FakeXHR.made = [];
  const queue = new UploadQueue({send:(body, to, options) => sendFile(body, to, {...options, XHR:FakeXHR}), now:() => now});
  const {finished} = queue.add([file('a'), file('b')], target, {deliver:() => ''});
  await settle();
  FakeXHR.made[0].respond(200, {path:'C:\\a', id:'f1'});
  await settle();
  FakeXHR.made[1].respond(200, {path:'C:\\b', id:'f2'});
  await finished;
  assert.equal(queue.prune(new Set(['f1'])).length, 1);
  now += 60000;
  assert.equal(queue.prune(new Set()).length, 0);
});
