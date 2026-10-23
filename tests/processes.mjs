import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

function element(tag, props = {}, ...children) {
  return {tag, props, children:children.flat(Infinity).filter(item => item != null),
    style:{values:{}, setProperty(key, value) { this.values[key] = value; }}};
}
function text(node) {
  if (typeof node !== 'object') return String(node);
  return node.props?.text || node.children?.map(text).join('') || '';
}
const process = (pid, parent, name, root = false) => ({pid, parent, name, root, path:`C:\\bin\\${name}`, started:1000 + pid});

function fixture(processes = [], access = {mine:true, can:true, label:'You have control'}) {
  const sessions = new Map([
    ['live', {id:'live', name:'Build service', alive:true}],
    ['done', {id:'done', name:'Finished task', alive:false}],
    ['error', {id:'error', name:'Unavailable task', alive:true}],
  ]);
  const workspace = {id:'w1', name:'Project alpha', sessions:[...sessions.keys()]};
  const shown = [], state = {sessions, connected:true};
  const source = readFileSync(new URL('../assets/processes.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({
    state, el:element, icon:name => element('svg', {name}), avatar:() => element('span'),
    badge:label => element('span', {text:label}), plural:(count, word) => `${count} ${word}`,
    control:() => access, orderedSessions:() => [...sessions.keys()], sessionShell:() => 'PowerShell',
    terminalName:id => sessions.get(id).name, terminalStatus:id => ({label:sessions.get(id).alive ? 'Running' : 'Exited', tone:'neutral'}),
    workspaceOf:() => workspace, workspaceLabel:() => workspace.name, workspaceIndex:() => 0,
    showTerminal:(...args) => shown.push(args), subscribe() {}, closeTerminals() {}, interrupt() {}, openLauncher() {},
    document:{addEventListener() {}, visibilityState:'visible'}, ago:() => 'just now', setTimeout, clearTimeout,
  });
  vm.runInContext(`${source}\nglobalThis.probed = {view, model, tree, rowNode, actions};`, context);
  const api = context.probed;
  api.view.data = {limit:64, sessions:[
    {id:'live', total:processes.length, processes},
    {id:'done', total:0, processes:[]},
    {id:'error', total:0, problem:'Inspection failed', processes:[]},
  ]};
  return {...api, state, shown};
}

test('terminal and workspace searches retain exited and unavailable process rows', () => {
  const api = fixture();
  for (const [query, ids] of [['finished', ['done']], ['unavailable', ['error']], ['project alpha', ['live', 'done', 'error']]]) {
    api.view.query = query;
    assert.deepEqual(Array.from(api.model().filter(row => row.matches), row => row.id), ids);
  }
});

test('a matching child process retains its parent context and opens its terminal tree', () => {
  const api = fixture([process(1, null, 'shell.exe', true), process(2, 1, 'worker.exe'), process(3, 1, 'other.exe'), process(4, 2, 'leaf.exe')]);
  api.view.query = 'leaf.exe';
  const row = api.model().find(item => item.id === 'live');
  assert.deepEqual(Array.from(row.visible, item => item.pid), [1, 2, 4]);
  const first = api.rowNode(row);
  assert.equal(first.children[0].props['aria-expanded'], 'true', 'the matching child is exposed without a second click');
  first.children[0].props.onclick();
  assert.equal(api.rowNode(row).children[0].props['aria-expanded'], 'false', 'the user can collapse a search result');
});

test('the process tree groups descendants beneath their actual parent', () => {
  const api = fixture([process(1, null, 'shell.exe', true), process(2, 1, 'worker.exe'), process(3, 1, 'other.exe'), process(4, 2, 'leaf.exe')]);
  const tree = api.tree(api.model()[0]);
  assert.deepEqual(tree.children.map(node => text(node.children[0])), ['shell.exe', 'worker.exe', 'leaf.exe', 'other.exe']);
  assert.deepEqual(tree.children.map(node => node.style.values['--depth']), [0, 1, 2, 1]);
});

test('deep process chains retain their full depth and incomplete forests remain bounded', () => {
  const chain = Array.from({length:9}, (_, index) => process(index + 1, index || null, `level-${index}.exe`, index === 0));
  const api = fixture(chain);
  assert.deepEqual(api.tree(api.model()[0]).children.map(node => node.style.values['--depth']), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  api.view.data.sessions[0].processes = [process(10, 11, 'cycle-a.exe'), process(11, 10, 'cycle-b.exe'), process(12, 99, 'orphan.exe')];
  assert.equal(api.tree(api.model()[0]).children.length, 3, 'each reported process appears once even with missing or cyclic ancestry');
});

test('an observing process row explicitly opens and claims its owning terminal', () => {
  const api = fixture([process(1, null, 'shell.exe', true)], {mine:false, can:false, label:'Observing'});
  const button = api.actions(api.model()[0]).children.find(node => node.tag === 'button' && text(node) === 'Take control');
  assert.ok(button, 'observers have an explicit control-transfer action');
  button.props.onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(api.shown)), [['live', {claim:true}]]);
});

test('offline and exited process rows cannot request control', () => {
  const api = fixture();
  for (const row of api.model()) {
    api.state.connected = false;
    assert.ok(!api.actions(row).children.some(node => node.tag === 'button' && text(node) === 'Take control'));
  }
});
