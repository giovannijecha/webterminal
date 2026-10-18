import assert from 'node:assert/strict';
import test from 'node:test';
import {ClipboardFollower, DOCUMENT_LIMIT, Documents, TEXT_LIMIT, clipboardSource, filterDocuments, meaningful, normalize} from '../assets/documents.js';

const markdown = '# Private clipboard note\nThis is enough text to be treated as a document.';
const reply = (seq, text, extra = {}) => ({seq, id:'s1', program:'codex', label:'Codex', text, at:1000 + seq, replayed:false, read:false, ...extra});

test('only prose-like text counts as a captured document', () => {
  assert.equal(meaningful('C:\\Temp\\file.txt'), false);
  assert.equal(meaningful('git status --short'), false);
  assert.equal(meaningful(markdown), true);
  assert.equal(meaningful('one two three four five six seven eight nine ten eleven twelve'), true);
});

test('text is normalized and bounded', () => {
  assert.equal(normalize('a\r\nb\rc'), 'a\nb\nc');
  const long = normalize('x'.repeat(TEXT_LIMIT + 10));
  assert.ok(long.startsWith('x'.repeat(TEXT_LIMIT)));
  assert.match(long, /Truncated at 512 KiB/);
});

test('clipboard provenance names a terminal only for its own recorded copy', () => {
  const copies = [{text:'from osc', id:'s4', at:1}, {text:'from webterminal', id:null, at:2}];
  assert.deepEqual(clipboardSource('from osc', copies), {kind:'copy', id:'s4'});
  assert.equal(clipboardSource('from webterminal', copies), null);
  assert.deepEqual(clipboardSource('anything else', copies), {kind:'clipboard', id:null});
  // The newest record wins when the same text was copied twice.
  assert.equal(clipboardSource('from osc', [...copies, {text:'from osc', id:null, at:3}]), null);
  // The system clipboard may return CRLF for text recorded with LF.
  assert.deepEqual(clipboardSource('line one\r\nline two', [{text:'line one\nline two', id:'s2'}]), {kind:'copy', id:'s2'});
});

test('replies and local documents form one newest-first collection', () => {
  let now = 5000;
  const docs = new Documents({now:() => now});
  const replies = [reply(1, '# First reply\nBody'), reply(2, 'Second reply body', {read:true})];
  const {doc:pasted, added} = docs.add('# Pasted\n\nText', {kind:'pasted'}, replies);
  assert.equal(added, true);
  const list = docs.list(replies);
  assert.deepEqual(list.map(doc => doc.key), [pasted.key, 'r:2', 'r:1']);
  assert.deepEqual(list.map(doc => doc.title), ['Pasted', 'Second reply body', 'First reply']);
  assert.equal(list[1].read, true);
  assert.equal(list[2].program, 'Codex');
  assert.equal(list[0].id, null, 'pasted text is never assigned to a terminal');
  now++;
  assert.equal(docs.add('# First reply\nBody', {kind:'clipboard'}, replies).added, false, 'identical text is not added twice');
  assert.equal(docs.add('   ', {kind:'pasted'}, replies).doc, null);
});

test('local documents are bounded and removal can be undone', () => {
  let now = 0;
  const docs = new Documents({now:() => ++now});
  for (let i = 0; i < DOCUMENT_LIMIT + 3; i++) docs.add(`Document ${i}`, {kind:'pasted'});
  const list = docs.list([]);
  assert.equal(list.length, DOCUMENT_LIMIT);
  assert.equal(list.at(-1).text, 'Document 3');
  const undo = docs.remove(list[5]);
  assert.equal(docs.list([]).length, DOCUMENT_LIMIT - 1);
  docs.restore(undo);
  assert.deepEqual(docs.list([]).map(doc => doc.key), list.map(doc => doc.key));
  const replies = [reply(7, 'A reply')];
  const hidden = docs.remove(docs.find('r:7', replies));
  assert.equal(docs.find('r:7', replies), null);
  docs.restore(hidden);
  assert.equal(docs.find('r:7', replies).text, 'A reply');
});

test('a closed terminal keeps the name and workspace it last had', () => {
  const docs = new Documents();
  docs.remember('s1', {name:'Codex', workspace:'webterminal', program:'Codex'});
  docs.remember('s1', {name:'Codex review', workspace:'webterminal', program:'Codex'});
  assert.deepEqual(docs.place('s1'), {name:'Codex review', workspace:'webterminal', program:'Codex'});
  assert.equal(docs.place('missing'), null);
});

test('search covers titles and text; Unread hides read documents', () => {
  const docs = [{title:'Build notes', text:'cargo test passed', read:true}, {title:'Plan', text:'Review the uploads', read:false}];
  assert.deepEqual(filterDocuments(docs, {query:'UPLOAD'}).map(doc => doc.title), ['Plan']);
  assert.deepEqual(filterDocuments(docs, {query:'build'}).map(doc => doc.title), ['Build notes']);
  assert.deepEqual(filterDocuments(docs, {filter:'unread'}).map(doc => doc.title), ['Plan']);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function follower() {
  const reads = [], captured = [], denials = [];
  let focused = true;
  const instance = new ClipboardFollower({
    read:() => { const read = deferred(); reads.push(read); return read.promise; },
    focused:() => focused,
    capture:text => captured.push(text),
    denied:error => denials.push(error.message),
  });
  return {instance, reads, captured, denials, focus(value) { focused = value; }};
}

async function enabled(f, text = 'clipboard at enablement') {
  const pending = f.instance.enable();
  f.reads.at(-1).resolve(text);
  assert.equal(await pending, true);
}

test('enabling Follow only records what is already on the clipboard', async () => {
  const f = follower();
  await enabled(f, markdown);
  const pending = f.instance.check();
  f.reads[1].resolve(markdown);
  await pending;
  assert.deepEqual(f.captured, []);
});

test('Follow captures new text while enabled and focused, once', async () => {
  const f = follower();
  await enabled(f);
  let pending = f.instance.check();
  f.reads[1].resolve(markdown);
  await pending;
  pending = f.instance.check();
  f.reads[2].resolve(markdown);
  await pending;
  assert.deepEqual(f.captured, [markdown]);
});

test('an unfocused view is never read', async () => {
  const f = follower();
  await enabled(f);
  f.focus(false);
  await f.instance.check();
  assert.equal(f.reads.length, 1);
});

test('a pending read does not capture after Follow is turned off', async () => {
  const f = follower();
  await enabled(f);
  const pending = f.instance.check();
  f.instance.disable();
  f.reads[1].resolve(markdown);
  await pending;
  assert.equal(f.instance.enabled, false);
  assert.deepEqual(f.captured, []);
});

test('text read after focus loss is primed instead of captured on return', async () => {
  const f = follower();
  await enabled(f);
  let pending = f.instance.check();
  f.focus(false);
  f.reads[1].resolve(markdown);
  await pending;
  f.focus(true);
  pending = f.instance.check();
  f.reads[2].resolve(markdown);
  await pending;
  assert.deepEqual(f.captured, []);
});

test('turning Follow off cancels pending enablement and its stale permission error', async () => {
  const f = follower();
  const pending = f.instance.enable();
  f.instance.disable();
  f.reads[0].reject(new Error('permission denied'));
  assert.equal(await pending, false);
  assert.equal(f.instance.enabled, false);
});

test('a refused enablement is reported to the caller', async () => {
  const f = follower();
  const pending = f.instance.enable();
  f.reads[0].reject(new Error('permission denied'));
  await assert.rejects(pending, /permission denied/);
  assert.equal(f.instance.enabled, false);
});

test('an old read stays cancelled if Follow is switched off and back on', async () => {
  const f = follower();
  await enabled(f);
  const old = f.instance.check();
  f.instance.disable();
  const enable = f.instance.enable();
  f.reads[2].resolve('new current clipboard');
  await enable;
  f.reads[1].resolve(markdown);
  await old;
  assert.equal(f.instance.enabled, true);
  assert.deepEqual(f.captured, []);
});

test('withdrawn permission is reported only while focused', async () => {
  const f = follower();
  await enabled(f);
  let pending = f.instance.check();
  f.reads[1].reject(new Error('NotAllowedError'));
  await pending;
  assert.deepEqual(f.denials, ['NotAllowedError']);
  pending = f.instance.check();
  f.focus(false);
  f.reads[2].reject(new Error('Document is not focused'));
  await pending;
  assert.deepEqual(f.denials, ['NotAllowedError']);
});

test('text the Reader copied itself is not captured again', async () => {
  const f = follower();
  await enabled(f);
  f.instance.saw(markdown);
  const pending = f.instance.check();
  f.reads[1].resolve(markdown.replace(/\n/g, '\r\n'));
  await pending;
  assert.deepEqual(f.captured, []);
});
