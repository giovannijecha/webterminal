import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Execute the owned module with its external edges replaced by fixture APIs.
// This exercises the real exported action without starting a browser or server.
function moduleUnderTest(name, bindings, exports) {
  const source = readFileSync(new URL(`../assets/${name}.js`, import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, '');
  const context = vm.createContext({...bindings, TextDecoder, Uint8Array, atob, setTimeout, clearTimeout});
  vm.runInContext(`${source}\nglobalThis.probed = {${exports.join(',')}};`, context, {filename:name});
  return context.probed;
}

function node(tag, props = {}, ...children) {
  return {
    tag, props, children:children.flat(Infinity).filter(Boolean), dataset:props.dataset || {},
    get childNodes() { return this.children; },
    attributes:{}, events:{}, addEventListener(name, run) { this.events[name] = run; }, append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this.children = items.flat(Infinity).filter(Boolean); },
    insertBefore(item, before) { const index = this.children.indexOf(before); this.children.splice(index < 0 ? this.children.length : index, 0, item); item.parent = this; },
    replaceWith(item) { const index = this.parent?.children.indexOf(this); if (index >= 0) { this.parent.children[index] = item; item.parent = this.parent; } },
    remove() { const index = this.parent?.children.indexOf(this); if (index >= 0) this.parent.children.splice(index, 1); },
    contains() { return false; }, querySelectorAll() { return []; }, querySelector() { return null; },
    setAttribute(key, value) { this.attributes[key] = value; },
    getAttribute(key) { return this.attributes[key] ?? this.props[key] ?? null; },
  };
}

test('OSC 52 records terminal provenance only after an approved clipboard write', async () => {
  const calls = [], sockets = {};
  let approved = false, writeFails = false;
  const pane = {id:'s1'};
  const api = moduleUnderTest('workspace', {
    $:() => ({addEventListener() {}}), avatar() {}, el:node, plural:(count, word) => `${count} ${word}s`, storage:() => ({set() {}}),
    displayPath:value => value, editInline() {}, PANE_LIMIT:4, canInput() {}, changed() {}, currentWorkspace() {}, focusedId() {}, go() {}, latestReply() {}, requestsFor() { return []; },
    state:{socket:sockets}, terminalName:() => 'Terminal 1', workspaceIndex() {}, workspaceLabel() {}, createPanes:() => [pane], discardInput() {}, nextRequest() {}, queueInput() {}, send() {}, mergeUpdate() {},
    dialogs:{show:async () => approved}, menu:{}, notify() {}, problem() {}, configureActions() {}, moveTerminal() {}, renameTerminal() {}, renameWorkspace() {}, showTerminalMenu() {}, takeControl() {}, workspaceMenu() {},
    configureLauncher() {}, openLauncher() {}, showSplitMenu() {}, stageDrop() {}, matchMedia:() => ({addEventListener() {}}),
    document:{addEventListener() {}, fonts:{ready:new Promise(() => {})}}, addEventListener() {}, navigator:{clipboard:{writeText:async text => { calls.push(['write', text]); if (writeFails) throw new Error('denied'); }}},
  }, ['configureWorkspace', 'handleTerminal']);
  api.configureWorkspace({clipboard:(text, id) => calls.push(['early', text, id]), copied:(text, id) => calls.push(['copied', text, id])});
  const text = '# Terminal answer\nThis is a meaningful document.';
  const frame = {type:'clipboard', id:'s1', data:Buffer.from(text).toString('base64')};
  api.handleTerminal(frame);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [], 'denied clipboard request records no provenance');
  approved = true;
  api.handleTerminal(frame);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['write', text], ['copied', text, 's1']], 'approved write records its source once');
  writeFails = true;
  api.handleTerminal(frame);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['write', text], ['copied', text, 's1'], ['write', text]], 'failed browser write records no new source');
});

test('joining and leaving observers refreshes workspace chrome without repainting unchanged metadata', () => {
  const changes = [];
  const session = {id:'s1', title:'PowerShell', alive:true, controller:'v1', exitCode:null};
  const first = {type:'snapshot', id:'s1', seq:1, epoch:1, viewers:1, alive:true, controller:'v1', exitCode:null, terminal:{title:'PowerShell'}};
  const state = {view:'v1', sessions:new Map([['s1', session]]), snapshots:new Map([['s1', first]]), attachments:new Map()};
  const api = moduleUnderTest('workspace', {
    $:() => ({addEventListener() {}}), avatar() {}, el:node, plural() {}, storage:() => ({set() {}}),
    displayPath:value => value, editInline() {}, PANE_LIMIT:4, canInput() {}, changed:topic => changes.push(topic), currentWorkspace() {}, focusedId() {}, go() {}, latestReply() {}, requestsFor() { return []; },
    state, terminalName() {}, workspaceIndex() {}, workspaceLabel() {}, createPanes:() => [], discardInput() {}, nextRequest() {}, queueInput() {}, send() {}, mergeUpdate() {},
    dialogs:{}, menu:{}, notify() {}, problem() {}, configureActions() {}, moveTerminal() {}, renameTerminal() {}, renameWorkspace() {}, showTerminalMenu() {}, takeControl() {}, workspaceMenu() {},
    configureLauncher() {}, openLauncher() {}, showSplitMenu() {}, stageDrop() {}, matchMedia:() => ({addEventListener() {}}), requestAnimationFrame:() => 1,
    document:{addEventListener() {}, fonts:{ready:new Promise(() => {})}}, addEventListener() {},
  }, ['handleTerminal']);
  api.handleTerminal({...first, seq:2, viewers:2});
  assert.deepEqual(changes, ['focus'], 'observer arrival refreshes the context badge');
  changes.length = 0;
  api.handleTerminal({...first, seq:3, viewers:2});
  assert.deepEqual(changes, [], 'ordinary output does not rebuild workspace chrome');
  api.handleTerminal({...first, seq:4});
  assert.deepEqual(changes, ['focus'], 'observer departure removes the badge');
});

test('an open launcher includes programs from the first pending discovery', async () => {
  let complete;
  let shown, showCount = 0;
  const programs = {hosted:true, programs:[{id:'codex', label:'Codex', available:true}]};
  const state = {connected:true, sessions:new Map(), workspaces:[{id:'w1', sessions:[], name:null}], selected:'w1', programs:null, hello:{shell:'powershell.exe', cwd:'C:\\work'}};
  const fakeSelect = () => ({options:[], append(option) { this.options.push(option); }, addEventListener() {}, value:''});
  const el = (tag, props = {}, ...children) => tag === 'select' ? fakeSelect() : node(tag, props, ...children);
  const api = moduleUnderTest('launcher', {
    ask() {}, PANE_LIMIT:4, SESSION_LIMIT:32, WORKSPACE_LIMIT:16, changed() {}, currentWorkspace:() => state.workspaces[0], focusedId:() => null,
    shellLabel:() => 'PowerShell', state, workspaceById:id => state.workspaces.find(item => item.id === id), workspaceLabel:() => 'Workspace 1',
    el, icon:() => node('svg'), programTile:() => node('tile'), storage:() => ({get() { return null; }, set() {}}), displayPath:value => value,
    DirectoryPicker:class {}, Dialogs:class {}, choice:() => ({root:node('choice')}), dialogs:{show:options => { shown = options; showCount++; return new Promise(() => {}); }}, menu:{}, problem() {}, createWorkspace() {},
    fetch:() => new Promise(resolve => { complete = () => resolve({ok:true, json:async () => programs}); }),
    document:{activeElement:null, querySelector:() => null},
  }, ['openLauncher']);
  api.openLauncher();
  api.openLauncher();
  assert.equal(showCount, 1, 'two clicks during discovery use one dialog');
  complete();
  await new Promise(resolve => setImmediate(resolve));
  const nodes = [];
  const visit = value => { if (Array.isArray(value)) { value.forEach(visit); return; } if (!value || typeof value !== 'object') return; nodes.push(value); for (const child of value.children || []) visit(child); };
  visit(shown?.body);
  assert.ok(nodes.some(item => item.dataset?.program === 'codex'), 'Codex is offered without reopening the dialog');
});

test('launcher reports a failed program check and retries inside the same dialog', async () => {
  let attempts = 0, shown, showCount = 0;
  const state = {connected:true, sessions:new Map(), workspaces:[{id:'w1', sessions:[], name:null}], selected:'w1', programs:null, hello:{shell:'powershell.exe', cwd:'C:\\work'}};
  const select = () => ({options:[], append(option) { this.options.push(option); }, addEventListener() {}, value:''});
  const api = moduleUnderTest('launcher', {
    ask() {}, PANE_LIMIT:4, SESSION_LIMIT:32, WORKSPACE_LIMIT:16, changed() {}, currentWorkspace:() => state.workspaces[0], focusedId:() => null,
    shellLabel:() => 'PowerShell', state, workspaceById:id => state.workspaces.find(item => item.id === id), workspaceLabel:() => 'Workspace 1',
    el:(tag, props = {}, ...children) => tag === 'select' ? select() : node(tag, props, ...children), icon:() => node('svg'), programTile:() => node('tile'),
    storage:() => ({get() { return null; }, set() {}}), displayPath:value => value, DirectoryPicker:class {}, Dialogs:class {}, choice:() => ({root:node('choice')}),
    dialogs:{show:options => { shown = options; showCount++; return new Promise(() => {}); }}, menu:{}, problem() {}, createWorkspace() {},
    fetch:async () => { if (++attempts === 1) throw new Error('offline'); return {ok:true, json:async () => ({hosted:true, programs:[{id:'codex', label:'Codex', available:true}]})}; },
    document:{activeElement:null, querySelector:() => null},
  }, ['openLauncher']);
  api.openLauncher();
  await new Promise(resolve => setImmediate(resolve));
  const nodes = [];
  const visit = value => { if (Array.isArray(value)) { value.forEach(visit); return; } if (!value || typeof value !== 'object') return; nodes.push(value); (value.children || []).forEach(visit); };
  visit(shown.body);
  const status = nodes.find(item => item.props.role === 'status');
  const retry = nodes.find(item => item.props.text === 'Retry program check');
  assert.match(status.textContent, /Could not check installed programs/);
  assert.equal(retry.hidden, false);
  await retry.events.click();
  assert.equal(showCount, 1);
  const latest = [];
  const collect = value => { if (Array.isArray(value)) { value.forEach(collect); return; } if (!value || typeof value !== 'object') return; latest.push(value); (value.children || []).forEach(collect); };
  collect(shown.body);
  assert.equal(attempts, 2);
  assert.equal(status.textContent, '');
  assert.equal(retry.hidden, true);
  assert.ok(latest.some(item => item.dataset?.program === 'codex'));
});

test('mobile file details track upload failure and successful retry', () => {
  const record = {key:'u1', state:'uploading', name:'notes.txt', size:12, session:'s1', at:1, percent:30, error:'', file:{}};
  let records = [record];
  const state = {connected:true, files:{files:[]}, sessions:new Map([['s1', {id:'s1'}]]), snapshots:new Map([['s1', {epoch:1}]])};
  const api = moduleUnderTest('files', {
    $:() => node('host'), ago:() => 'just now', bytes:value => `${value} B`, clock:() => '10:00', el:node, icon:() => node('svg'),
    pathText:value => node('path', {text:value}), plural:(count, word) => `${count} ${word}s`, changed() {},
    control:() => ({mine:true, label:'You have control'}), noteCopied() {}, showTerminal() {}, state,
    terminalName:() => 'Terminal 1', workspaceLabel:() => 'Workspace 1', workspaceOf:() => ({id:'w1'}),
    ask() {}, dialogs:{show:() => new Promise(() => {})}, menu:{}, notify() {}, problem() {},
    cancelUpload() {}, dismissUpload() {}, forgetCopy() {}, retryUpload() {}, transfers:() => records,
    matchMedia:() => ({matches:false, addEventListener() {}}), document:{activeElement:null},
  }, ['paint', 'openDialog', 'view']);
  api.view.nodes = {
    filters:node('filters'), list:node('list'), inspector:node('inspector'), frame:node('frame'),
    empty:node('empty'), summary:node('summary'), layout:node('layout'), search:node('search'),
  };
  api.paint();
  api.openDialog(api.view.rows.get('t:u1'));
  const caption = {textContent:'Uploading'};
  api.view.dialog.body.closest = () => ({querySelector:() => caption});
  const words = item => typeof item === 'string' ? item : [item?.props?.text || '', ...(item?.children || []).flatMap(words)].join(' ');
  assert.match(words(api.view.dialog.body), /Uploading/);

  record.state = 'failed';
  record.error = 'Disk unavailable';
  api.paint();
  assert.match(words(api.view.dialog.body), /Disk unavailable/);
  assert.match(words(api.view.dialog.body), /Retry/);
  assert.equal(caption.textContent, 'Not uploaded');

  record.state = 'done';
  record.copy = {id:'c1', session:'s1', original:'notes.txt', name:'notes.txt', path:'C:\\staged\\notes.txt', created:2, size:12};
  state.files.files = [record.copy];
  api.paint();
  assert.equal(api.view.dialog.key, 'c:c1');
  assert.match(words(api.view.dialog.body), /Staged path/);
  assert.equal(caption.textContent, 'Staged');
  records = [];
  state.files.files = [];
  api.paint();
  assert.match(words(api.view.dialog.body), /no longer available/);
  assert.equal(caption.textContent, 'No longer available');
});
