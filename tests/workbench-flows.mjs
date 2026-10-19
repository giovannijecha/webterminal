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
  const context = vm.createContext({TextDecoder, Uint8Array, atob, setTimeout, clearTimeout, ...bindings});
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
    displayPath:value => value, editInline() {}, PANE_LIMIT:4, canInput() {}, changed() {}, currentWorkspace() {}, focusedId() {}, go() {},
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
    displayPath:value => value, editInline() {}, PANE_LIMIT:4, canInput() {}, changed:topic => changes.push(topic), currentWorkspace() {}, focusedId() {}, go() {},
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

test('the launcher asks only for a folder and a workspace, then starts the shell there', async () => {
  const asks = [];
  let shown, showCount = 0;
  const state = {connected:true, sessions:new Map(), workspaces:[{id:'w1', sessions:[], name:null}], selected:'w1', hello:{shell:'powershell.exe', cwd:'C:\\work'}};
  const select = () => ({options:[], append(option) { this.options.push(option); }, addEventListener() {}, value:''});
  const api = moduleUnderTest('launcher', {
    ask:async command => { asks.push(JSON.parse(JSON.stringify(command))); return {id:'s1'}; },
    PANE_LIMIT:4, SESSION_LIMIT:32, WORKSPACE_LIMIT:16, currentWorkspace:() => state.workspaces[0], focusedId:() => null,
    shellLabel:() => 'PowerShell', state, workspaceById:id => state.workspaces.find(item => item.id === id), workspaceLabel:() => 'Workspace 1',
    el:(tag, props = {}, ...children) => tag === 'select' ? select() : node(tag, props, ...children), icon:() => node('svg'),
    storage:() => ({get() { return null; }, set() {}}), displayPath:value => value, DirectoryPicker:class {}, Dialogs:class { static invalid() {} }, choice:() => ({root:node('choice')}),
    dialogs:{show:options => { shown = options; showCount++; return new Promise(() => {}); }}, menu:{}, problem() {}, createWorkspace() {},
    document:{activeElement:null, querySelector:() => null},
  }, ['openLauncher']);
  api.openLauncher();
  api.openLauncher();
  assert.equal(showCount, 1, 'a second click reuses the open dialog');
  assert.match(shown.description, /^Start PowerShell in a folder/);
  const nodes = [];
  const visit = value => { if (Array.isArray(value)) { value.forEach(visit); return; } if (!value || typeof value !== 'object') return; nodes.push(value); (value.children || []).forEach(visit); };
  visit(shown.body);
  assert.ok(nodes.some(item => item.props?.id === 'launch-folder'), 'folder field');
  assert.ok(nodes.some(item => item.props?.id === 'launch-workspace-label'), 'workspace choice');
  assert.ok(nodes.every(item => !item.dataset?.program && !/program/i.test(item.props?.id || '')), 'no program choice');
  shown.initial.value = 'relative\\folder';
  assert.equal(await shown.onSubmit(), false, 'a relative folder stays in the form');
  assert.equal(asks.length, 0);
  shown.initial.value = 'C:\\work\\app';
  assert.equal(await shown.onSubmit(), undefined);
  assert.deepEqual(asks, [{op:'create', cwd:'C:\\work\\app', workspace:'w1', updates:true, cols:120, rows:30}], 'only the shell starts, in the chosen folder');
});

// The close flow with the server's replies scripted: `replies` answers each
// request in order, `answers` each confirmation.
function closeFlow({sessions = ['s1'], workspaces = [{id:'w1', name:null, sessions:[...sessions]}], replies = [], answers = [], during = () => {}} = {}) {
  const log = {asks:[], confirms:[], notices:[], problems:[]};
  const state = {sessions:new Map(sessions.map(id => [id, {id, alive:true}])), workspaces, snapshots:new Map()};
  const words = item => typeof item === 'string' ? item : [item?.props?.text || '', ...(item?.children || []).flatMap(words)].join(' ').trim();
  const api = moduleUnderTest('actions', {
    ask:async command => { log.asks.push(JSON.parse(JSON.stringify(command))); const reply = replies.shift(); if (reply instanceof Error) throw reply; return reply; },
    queueInput() {}, send:() => true, PANE_LIMIT:4, WORKSPACE_LIMIT:16, changed() {}, control:() => ({can:true}), go() {}, showTerminal() {}, state,
    terminalName:id => `Terminal ${id}`, terminalPlace:() => 'PowerShell in C:\\work', workspaceById:id => state.workspaces.find(item => item.id === id),
    workspaceLabel:() => 'Workspace 1', workspaceOf:() => state.workspaces[0], el:node, plural:(count, word) => `${count} ${word}${count === 1 ? '' : 's'}`,
    dialogs:{confirm:async options => { log.confirms.push({title:options.title, description:options.description, action:options.action, targets:options.body.children.map(words)}); during(state, log.confirms.length); return answers.shift(); }},
    menu:{}, notify:title => log.notices.push(title), problem:title => log.problems.push(title),
  }, ['closeTerminals', 'closeWorkspace']);
  return {api, log, state};
}

test('an idle terminal closes at once, without a confirmation', async () => {
  const {api, log} = closeFlow({replies:[{type:'closed', ids:['s1']}]});
  assert.equal(await api.closeTerminals(['s1']), true);
  assert.deepEqual(log.asks, [{op:'close-sessions', ids:['s1'], force:false}]);
  assert.deepEqual(log.confirms, []);
  assert.deepEqual(log.notices, ['Terminal closed']);
});

test('a busy terminal is confirmed first and Cancel keeps it running', async () => {
  const kept = closeFlow({replies:[{type:'busy', sessions:['s1'], targets:['s1']}], answers:[false]});
  assert.equal(await kept.api.closeTerminals(['s1']), false);
  assert.deepEqual(kept.log.asks, [{op:'close-sessions', ids:['s1'], force:false}], 'Cancel sends nothing more');
  assert.equal(kept.log.confirms[0].title, 'Close terminal?');
  assert.match(kept.log.confirms[0].targets[0], /^Terminal s1 Running a program · /);
  assert.deepEqual(kept.log.notices, []);

  const closed = closeFlow({replies:[{type:'busy', sessions:['s1'], targets:['s1']}, {type:'closed', ids:['s1']}], answers:[true]});
  assert.equal(await closed.api.closeTerminals(['s1']), true);
  assert.deepEqual(closed.log.asks.map(command => command.force), [false, true]);
  assert.deepEqual(closed.log.notices, ['Terminal closed']);
});

test('terminals closed elsewhere during a confirmation drop out and the rest are confirmed again', async () => {
  const {api, log} = closeFlow({
    sessions:['s1', 's2', 's3'], replies:[{type:'busy', sessions:['s2'], targets:['s1', 's2', 's3']}, {type:'closed', ids:['s2', 's3']}], answers:[true, true],
    during:(state, round) => { if (round === 1) state.sessions.delete('s1'); },
  });
  assert.equal(await api.closeTerminals(['s1', 's2', 's3']), true);
  assert.deepEqual(log.confirms.map(confirm => confirm.title), ['Close 3 terminals?', 'Close 2 terminals?']);
  assert.equal(log.confirms[1].targets.length, 2, 'the second confirmation names only the remaining terminals');
  assert.deepEqual(log.asks.at(-1), {op:'close-sessions', ids:['s2', 's3'], force:true}, 'only confirmed terminals are forced');
});

test('a bulk selection is always confirmed before it closes', async () => {
  const {api, log} = closeFlow({sessions:['s1', 's2'], replies:[{type:'closed', ids:['s1', 's2']}], answers:[true]});
  assert.equal(await api.closeTerminals(['s1', 's2'], {confirm:true}), true);
  assert.equal(log.confirms.length, 1);
  assert.deepEqual(log.asks, [{op:'close-sessions', ids:['s1', 's2'], force:true}]);
  assert.deepEqual(log.notices, ['2 terminals closed']);
});

test('an empty or idle workspace closes at once; a busy one confirms its exact terminals', async () => {
  const idle = closeFlow({replies:[{type:'sessions', workspaces:[]}]});
  assert.equal(await idle.api.closeWorkspace('w1'), true);
  assert.deepEqual(idle.log.asks, [{op:'close-workspace', id:'w1', targets:['s1']}]);
  assert.deepEqual(idle.log.confirms, []);

  const busy = closeFlow({sessions:['s1', 's2'], replies:[{type:'busy', op:'close-workspace', id:'w1', sessions:['s2'], targets:['s1', 's2']}, {type:'sessions', workspaces:[]}], answers:[true]});
  assert.equal(await busy.api.closeWorkspace('w1'), true);
  assert.equal(busy.log.confirms[0].targets.length, 2);
  assert.deepEqual(busy.log.asks[0], {op:'close-workspace', id:'w1', targets:['s1', 's2']});
  assert.deepEqual(busy.log.asks.at(-1), {op:'close-workspace', id:'w1', targets:['s1', 's2'], force:true});
  assert.deepEqual(busy.log.notices, ['Workspace closed']);

  const kept = closeFlow({sessions:['s1'], replies:[{type:'busy', op:'close-workspace', id:'w1', sessions:['s1'], targets:['s1']}], answers:[false]});
  assert.equal(await kept.api.closeWorkspace('w1'), false);
  assert.equal(kept.log.asks.length, 1, 'Cancel leaves the workspace running');
});

test('an empty workspace that gained an idle terminal asks before closing it', async () => {
  const added = closeFlow({sessions:[], workspaces:[{id:'w1', name:null, sessions:[]}],
    replies:[{type:'busy', op:'close-workspace', id:'w1', sessions:[], targets:['s1']}], answers:[false],
    during:state => { state.sessions.set('s1', {id:'s1', alive:true}); state.workspaces[0].sessions.push('s1'); }});
  assert.equal(await added.api.closeWorkspace('w1'), false);
  assert.deepEqual(added.log.asks, [{op:'close-workspace', id:'w1', targets:[]}]);
  assert.equal(added.log.confirms[0].title, 'Workspace changed');
  assert.match(added.log.confirms[0].description, /Its terminals changed/);
  assert.doesNotMatch(added.log.confirms[0].description, /still running/);
});

test('a workspace that gains terminals during its confirmation is never closed silently', async () => {
  const local = closeFlow({
    sessions:['s1'], replies:[{type:'busy', op:'close-workspace', id:'w1', sessions:['s1'], targets:['s1']}], answers:[true],
    during:state => state.workspaces[0].sessions.push('s9'),
  });
  assert.equal(await local.api.closeWorkspace('w1'), false);
  assert.equal(local.log.asks.length, 1, 'a changed workspace sends no forced close');
  assert.deepEqual(local.log.problems, ['Workspace changed']);

  const remote = closeFlow({
    sessions:['s1'], answers:[true, false],
    replies:[{type:'busy', op:'close-workspace', id:'w1', sessions:['s1'], targets:['s1']}, {type:'busy', op:'close-workspace', id:'w1', sessions:['s1'], targets:['s1', 's9']}],
  });
  assert.equal(await remote.api.closeWorkspace('w1'), false);
  assert.deepEqual(remote.log.confirms.map(confirm => confirm.title), ['Close workspace?', 'Workspace changed']);
  assert.equal(remote.log.confirms[1].targets.length, 2, 'the server-reported set is confirmed again');
});

// Toasts over a minimal DOM and a manual clock.
function toastBench() {
  const doc = {activeElement:null};
  class FakeNode {
    constructor(tag, props = {}) { Object.assign(this, {tag, props, children:[], parent:null, events:{}, isConnected:true, hidden:false, textContent:props.text || ''}); }
    append(...items) { for (const item of items.flat(Infinity)) if (item) { item.parent = this; this.children.push(item); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); this.parent = null; }
    contains(target) { for (let item = target; item; item = item.parent) if (item === this) return true; return false; }
    addEventListener(name, run) { (this.events[name] ||= []).push(run); }
    fire(name, event = {}) { for (const run of this.events[name] || []) run({preventDefault() {}, stopPropagation() {}, ...event}); }
    focus() { doc.activeElement = this; }
    find(test) { if (test(this)) return this; for (const child of this.children) { const found = child.find?.(test); if (found) return found; } return null; }
  }
  let now = 0, next = 0;
  const timers = new Map();
  const clock = {
    setTimeout:(run, ms) => { timers.set(++next, {at:now + ms, run}); return next; },
    clearTimeout:id => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = end;
    },
  };
  const el = (tag, props = {}, ...children) => { const item = new FakeNode(tag, props); item.append(...children); return item; };
  const {Toasts} = moduleUnderTest('toasts', {el, icon:() => el('svg'), Node:FakeNode, document:doc, setTimeout:clock.setTimeout, clearTimeout:clock.clearTimeout}, ['Toasts']);
  const root = el('div'), live = el('div'), home = el('h1');
  const toasts = new Toasts(root, live, {home:() => home});
  const titles = () => root.children.map(item => item.props['aria-label']);
  return {toasts, root, live, home, doc, el, clock, titles};
}

test('successful toasts expire after about four seconds; errors stay until dismissed', () => {
  const {toasts, clock, titles, live, root} = toastBench();
  toasts.show({title:'Saved'});
  toasts.show({title:'Could not save', kind:'error'});
  toasts.show({title:'Moved', action:{label:'Undo', run() {}}});
  clock.advance(30);
  assert.equal(live.textContent, 'Moved', 'the newest toast is announced');
  clock.advance(3990);
  assert.deepEqual(titles(), ['Could not save', 'Moved']);
  clock.advance(4000);
  assert.deepEqual(titles(), ['Could not save'], 'a toast with an action lingers longer');
  clock.advance(60000);
  assert.deepEqual(titles(), ['Could not save']);
  root.children[0].children[1].fire('click');
  assert.deepEqual(titles(), []);
  assert.equal(root.hidden, true, 'an empty region is hidden');
});

test('pointer or focus on a toast holds it; leaving starts a full delay again', () => {
  const {toasts, clock, titles, root} = toastBench();
  const node = toasts.show({title:'Saved'});
  clock.advance(3000);
  node.fire('pointerenter');
  clock.advance(10000);
  assert.deepEqual(titles(), ['Saved'], 'hover pauses expiry');
  node.fire('focusin', {relatedTarget:null});
  node.fire('pointerleave');
  clock.advance(10000);
  assert.deepEqual(titles(), ['Saved'], 'focus still holds it');
  node.fire('focusout', {relatedTarget:null});
  clock.advance(3999);
  assert.deepEqual(titles(), ['Saved']);
  clock.advance(1);
  assert.equal(root.children.length, 0);
});

test('a replaced toast cannot dismiss its successor with a stale timer', () => {
  const {toasts, clock, titles} = toastBench();
  toasts.show({title:'Saved once', key:'settings'});
  clock.advance(3000);
  toasts.show({title:'Saved twice', key:'settings'});
  assert.deepEqual(titles(), ['Saved twice'], 'the same key replaces the older toast');
  clock.advance(1500);
  assert.deepEqual(titles(), ['Saved twice'], 'the first timer is gone');
  clock.advance(2500);
  assert.deepEqual(titles(), []);
});

test('at most three toasts show, and errors are evicted last', () => {
  const {toasts, titles} = toastBench();
  toasts.show({title:'Error', kind:'error'});
  toasts.show({title:'One'});
  toasts.show({title:'Two'});
  toasts.show({title:'Three'});
  assert.deepEqual(titles(), ['Error', 'Two', 'Three']);
});

test('dismissing a focused toast returns focus without stealing it on show', () => {
  const {toasts, doc, el, home} = toastBench();
  const terminal = el('textarea');
  terminal.focus();
  const node = toasts.show({title:'Interrupt sent'});
  assert.equal(doc.activeElement, terminal, 'showing a toast keeps focus where it was');
  const dismiss = node.children[1];
  node.fire('focusin', {relatedTarget:terminal});
  dismiss.focus();
  node.fire('keydown', {key:'Escape'});
  assert.equal(doc.activeElement, terminal, 'Escape returns focus to the previous control');
  const second = toasts.show({title:'Saved'});
  second.fire('focusin', {relatedTarget:terminal});
  second.children[1].focus();
  terminal.isConnected = false;
  second.children[1].fire('click');
  assert.equal(doc.activeElement, home, 'without a previous control focus goes to the page heading');
});

test('a toast action runs once and closes its toast', () => {
  const {toasts, titles} = toastBench();
  let runs = 0;
  const node = toasts.show({title:'Moved', action:{label:'Undo', run:() => runs++}});
  node.find(item => item.props.text === 'Undo').fire('click');
  assert.equal(runs, 1);
  assert.deepEqual(titles(), []);
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
