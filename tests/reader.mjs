import assert from 'node:assert/strict';
import test from 'node:test';
import {Reader} from '../assets/reader.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

function fixture({follow = true, focused = true} = {}) {
  const reads = [];
  const additions = [], openings = [], notices = [];
  let hasFocus = focused;
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  const previousClipboard = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
  globalThis.document = {hasFocus: () => hasFocus};
  globalThis.localStorage = {setItem() {}};
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: {readText() { const read = deferred(); reads.push(read); return read.promise; }},
  });
  const reader = Object.create(Reader.prototype);
  Object.assign(reader, {
    follow, followGeneration:0, reading:false, seen:'earlier text', ignored:[],
    add:(...args) => additions.push(args),
    toggle:(...args) => openings.push(args),
    notify:(...args) => notices.push(args),
    render() {},
  });
  return {
    reader, reads, additions, openings, notices,
    focus(value) { hasFocus = value; },
    restore() {
      globalThis.document = previousDocument;
      globalThis.localStorage = previousStorage;
      if (previousClipboard) Object.defineProperty(globalThis.navigator, 'clipboard', previousClipboard);
      else delete globalThis.navigator.clipboard;
    },
  };
}

const markdown = '# Private clipboard note\nThis is enough text to be treated as a document.';

test('a pending Follow read does not capture after Follow is turned off', async () => {
  const f = fixture();
  try {
    const pending = f.reader.check();
    await f.reader.setFollow(false);
    f.reads[0].resolve(markdown);
    await pending;
    assert.equal(f.reader.follow, false);
    assert.deepEqual(f.additions, []);
    assert.deepEqual(f.openings, []);
  } finally { f.restore(); }
});

test('a pending Follow read does not capture after the page loses focus', async () => {
  const f = fixture();
  try {
    const pending = f.reader.check();
    f.focus(false);
    f.reads[0].resolve(markdown);
    await pending;
    assert.deepEqual(f.additions, []);
    assert.deepEqual(f.openings, []);
  } finally { f.restore(); }
});

test('turning Follow off cancels pending enablement and its stale permission error', async () => {
  const f = fixture({follow:false});
  try {
    const pending = f.reader.setFollow(true);
    await f.reader.setFollow(false);
    f.reads[0].reject(new Error('permission denied'));
    await pending;
    assert.equal(f.reader.follow, false);
    assert.deepEqual(f.notices, []);
  } finally { f.restore(); }
});

test('an old read stays canceled if Follow is switched off and back on', async () => {
  const f = fixture();
  try {
    const oldRead = f.reader.check();
    await f.reader.setFollow(false);
    const enable = f.reader.setFollow(true);
    f.reads[1].resolve('new current clipboard');
    await enable;
    f.reads[0].resolve(markdown);
    await oldRead;
    assert.equal(f.reader.follow, true);
    assert.deepEqual(f.additions, []);
    assert.deepEqual(f.openings, []);
  } finally { f.restore(); }
});

test('Follow still captures a new document while enabled and focused', async () => {
  const f = fixture({follow:false});
  try {
    const enable = f.reader.setFollow(true);
    f.reads[0].resolve('clipboard at enablement');
    await enable;
    assert.equal(f.reader.follow, true);
    assert.deepEqual(f.additions, []);
    const pending = f.reader.check();
    f.reads[1].resolve(markdown);
    await pending;
    assert.deepEqual(f.additions, [[markdown, 'Clipboard']]);
    assert.deepEqual(f.openings, [[true, false]]);
  } finally { f.restore(); }
});

test('text read after focus loss is primed instead of captured on return', async () => {
  const f = fixture();
  try {
    const pending = f.reader.check();
    f.focus(false);
    f.reads[0].resolve(markdown);
    await pending;
    f.focus(true);
    const next = f.reader.check();
    f.reads[1].resolve(markdown);
    await next;
    assert.deepEqual(f.additions, []);
    assert.deepEqual(f.openings, []);
  } finally { f.restore(); }
});
