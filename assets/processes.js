// Processes: one row per terminal with the programs it started; a row expands
// into the process tree and the terminal's actions. The list polls the server
// only while this page is visible, and every action targets the owning
// terminal, never a process ID.
import {$, ago, avatar, badge, clock, el, icon, patch, plural} from './dom.js';
import {control, orderedSessions, sessionShell, showTerminal, state, subscribe, terminalName, terminalStatus, workspaceIndex, workspaceLabel, workspaceOf} from './model.js';
import {closeTerminals, interrupt} from './actions.js';
import {openLauncher} from './launcher.js';

const POLL = 2000;
const view = {data:null, error:'', request:null, timer:0, query:'', open:new Set(), collapsed:new Set(), nodes:null, rows:new Map()};

const showing = () => state.page === 'processes' && document.visibilityState === 'visible';
const started = ms => Number.isFinite(ms) ? new Date(ms).toLocaleString([], {dateStyle:'medium', timeStyle:'medium'}) : 'Unknown';
const REASONS = {
  Observing:'Another view controls this terminal. Take control opens it and transfers input and size to this view.',
  'No controller':'Take control of this terminal to interrupt it.',
  Exited:'This terminal has exited.',
  Offline:'Reconnecting to the local server.',
};

function stop() {
  clearTimeout(view.timer);
  view.timer = 0;
  const request = view.request;
  view.request = null;
  request?.abort();
}

// One request at a time; the next starts two seconds after this one ends.
async function load() {
  clearTimeout(view.timer);
  view.timer = 0;
  if (!showing() || view.request) return;
  const request = view.request = new AbortController();
  paint();
  try {
    const response = await fetch('/api/processes', {cache:'no-store', signal:request.signal});
    if (!response.ok) throw new Error(`The server answered ${response.status}.`);
    const data = await response.json();
    if (view.request !== request) return;
    view.data = data;
    view.error = '';
  } catch (error) {
    if (view.request !== request) return;
    view.error = error.name === 'TypeError' ? 'The local server did not answer.' : error.message;
  }
  view.request = null;
  paint();
  if (showing()) view.timer = setTimeout(load, POLL);
}

document.addEventListener('visibilitychange', () => { if (showing()) load(); else stop(); });
subscribe(() => { if (state.page !== 'processes' && (view.timer || view.request)) stop(); });

// Start-time order is not tree order: siblings can start before a grandchild.
// Visit each reported process once, including orphans and incomplete ancestry.
function outline(list) {
  const byId = new Map(list.map(process => [process.pid, process])), children = new Map(), seen = new Set(), result = [];
  for (const process of list) {
    if (!children.has(process.parent)) children.set(process.parent, []);
    children.get(process.parent).push(process);
  }
  function visit(process, depth) {
    if (seen.has(process.pid)) return;
    seen.add(process.pid);
    result.push({process, depth});
    for (const child of children.get(process.pid) || []) if (!child.root) visit(child, depth + 1);
  }
  for (const process of list) if (process.root || !byId.has(process.parent)) visit(process, process.root ? 0 : 1);
  for (const process of list) if (!seen.has(process.pid)) visit(process, 1);
  return result;
}
function withAncestors(matches, list) {
  const byId = new Map(list.map(process => [process.pid, process])), keep = new Set();
  for (let process of matches) {
    while (process && !keep.has(process.pid)) {
      keep.add(process.pid);
      process = process.root ? null : byId.get(process.parent);
    }
  }
  return list.filter(process => keep.has(process.pid));
}

// The programs below the shell, by name and count, in the server's order.
// Only names are reported, so nothing here guesses arguments or focus.
function programs(list) {
  const counts = new Map();
  for (const process of list) if (!process.root) counts.set(process.name, (counts.get(process.name) || 0) + 1);
  return [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(' · ');
}

// Terminals in sidebar order; each keeps the server's order (root first).
function model() {
  const order = orderedSessions(), rank = id => (order.indexOf(id) + order.length + 1) % (order.length + 1);
  const query = view.query.trim().toLowerCase(), has = value => String(value ?? '').toLowerCase().includes(query);
  return (view.data?.sessions || []).filter(entry => state.sessions.has(entry.id)).sort((a, b) => rank(a.id) - rank(b.id)).map(entry => {
    const session = state.sessions.get(entry.id), workspace = workspaceOf(entry.id), processes = entry.processes || [];
    const row = {id:entry.id, name:terminalName(entry.id), workspace:workspaceLabel(workspace), family:workspace ? workspaceIndex(workspace) : 0,
      shell:sessionShell(session), status:terminalStatus(entry.id), access:control(entry.id), total:entry.total, truncated:entry.truncated, problem:entry.problem, processes};
    const metadata = !query || has(row.name) || has(row.workspace) || has(row.shell);
    const matches = metadata ? [] : processes.filter(process => has(process.name) || has(process.pid) || has(process.path));
    row.processMatch = !metadata && matches.length > 0;
    row.visible = metadata ? processes : withAncestors(matches, processes);
    row.matches = metadata || matches.length > 0;
    return row;
  });
}

function summary(row) {
  if (row.problem) return el('span', {class:'process-summary-text', text:'Process list unavailable'});
  if (!row.processes.length) return el('span', {class:'process-summary-text', text:'No running processes'});
  const names = programs(row.visible);
  if (!names) return el('span', {class:'process-summary-text', text:view.query.trim() && row.visible.length ? row.visible[0].name : 'Only the shell'});
  return el('span', {class:'process-programs', title:names, text:row.truncated ? `${names} …` : names});
}

function tree(row) {
  return el('ul', {class:'process-tree', 'aria-label':`Processes in ${row.name}`}, outline(row.visible).map(({process, depth}) => {
    const node = el('li', {class:'process-node', 'data-root':String(Boolean(process.root))},
      el('b', {class:'process-name', text:process.name}),
      el('span', {class:'process-path', title:process.path || 'Path not available', text:process.path || '—'}),
      el('span', {class:'process-pid', title:process.parent == null ? 'No parent reported' : `Parent ${process.parent}`}, el('span', {class:'sr-only', text:'PID '}), String(process.pid)),
      el('span', {class:'process-age', title:`Started ${started(process.started)}`, text:Number.isFinite(process.started) ? ago(process.started) : '—'}));
    node.style.setProperty('--depth', depth);
    return node;
  }));
}

function actions(row) {
  const access = row.access;
  const claim = state.connected && state.sessions.get(row.id)?.alive && !access.mine;
  const reason = access.can ? '' : REASONS[access.label] || access.label;
  const note = access.can ? `${access.label} · Interrupt sends Ctrl+C to this terminal` : reason;
  return el('div', {class:'process-actions'},
    claim ? el('button', {class:'btn sm', type:'button', text:'Take control', 'aria-describedby':`process-note-${row.id}`, dataset:{focus:`claim:${row.id}`},
      onclick:() => showTerminal(row.id, {claim:true})}) : el('button', {class:'btn sm', type:'button', 'aria-disabled':String(!access.can), 'aria-describedby':`process-note-${row.id}`, dataset:{focus:`interrupt:${row.id}`},
      onclick:() => { if (control(row.id).can) interrupt(row.id); }}, 'Interrupt', el('kbd', {text:'Ctrl+C'})),
    el('button', {class:'btn sm', type:'button', text:'Open terminal', dataset:{focus:`open:${row.id}`}, onclick:() => showTerminal(row.id)}),
    el('span', {class:'process-note', id:`process-note-${row.id}`, text:note}),
    el('button', {class:'btn danger sm', type:'button', text:'Close terminal', dataset:{focus:`close:${row.id}`}, onclick:() => closeTerminals([row.id])}));
}

function detail(row) {
  const limit = view.data?.limit;
  return el('div', {class:'process-detail', id:`process-detail-${row.id}`},
    row.problem ? el('p', {class:'process-problem', text:`Process list unavailable: ${row.problem}`}) : null,
    row.visible.length ? tree(row) : el('p', {class:'process-none', text:row.problem ? '' : row.processes.length ? 'No process matches the search.' : 'No running processes.'}),
    row.truncated ? el('p', {class:'process-none', text:`Showing ${row.processes.length} of ${plural(row.total, 'process', 'processes')}${limit ? `; the list stops at ${limit}` : ''}.`}) : null,
    actions(row));
}

const expanded = row => view.open.has(row.id) || (row.processMatch && !view.collapsed.has(row.id));
function rowNode(row) {
  const open = expanded(row);
  const count = row.truncated ? `${row.processes.length} of ${row.total}` : String(row.total);
  const toggle = el('button', {class:'process-row', type:'button', 'aria-expanded':String(open), 'aria-controls':`process-detail-${row.id}`, dataset:{focus:`row:${row.id}`},
    onclick:() => {
      if (expanded(row)) { view.open.delete(row.id); view.collapsed.add(row.id); }
      else { view.open.add(row.id); view.collapsed.delete(row.id); }
      paint();
    }},
  el('span', {class:'process-terminal'}, avatar(row.family, row.workspace, 'xs'), el('span', {}, el('b', {text:row.name}), el('span', {text:row.workspace}))),
  summary(row),
  el('span', {class:'process-count', 'aria-label':plural(row.total, 'process', 'processes'), text:count}),
  el('span', {class:'process-status'}, badge(row.status.label, row.status.tone)),
  icon('chevron-down', 'sm'));
  return el('li', {class:'process-item', dataset:{id:row.id}, 'data-open':String(open)}, toggle, open ? detail(row) : null);
}
const rowKey = row => JSON.stringify([row.name, row.workspace, row.family, row.shell, row.status.label, row.access.label, row.access.can, row.total, row.truncated, row.problem,
  expanded(row), expanded(row) ? row.visible : row.visible.map(process => process.name), view.data?.limit]);

// Rows are keyed by terminal and rebuilt only when what they show changed;
// keyboard focus returns to the same control in the rebuilt row.
function renderRows(list, rows) {
  const active = document.activeElement, focused = list.contains(active) ? active.dataset.focus : null;
  const ids = new Set(rows.map(row => row.id));
  for (const [id, node] of view.rows) if (!ids.has(id)) { node.remove(); view.rows.delete(id); }
  const wanted = rows.map(row => {
    const key = rowKey(row), old = view.rows.get(row.id);
    if (old?.dataset.key === key) return old;
    const node = rowNode(row);
    node.dataset.key = key;
    if (old) old.replaceWith(node);
    view.rows.set(row.id, node);
    return node;
  });
  for (const node of [...list.children]) if (!wanted.includes(node)) node.remove();
  if (wanted.some((node, index) => list.children[index] !== node)) list.append(...wanted);
  if (focused && !active.isConnected) list.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus({preventScroll:true});
}

const stateBlock = (title, text, button, tone) => el('div', {class:'state', role:tone === 'error' ? 'alert' : 'status', 'data-tone':tone || null}, el('h2', {text:title}), text ? el('p', {text}) : null, button);
function clearSearch() {
  view.nodes.search.value = '';
  view.query = '';
  view.collapsed.clear();
  paint();
  view.nodes.search.focus();
}
function emptyState(rows, shown) {
  if (!view.data) {
    if (view.error) return ['error', () => stateBlock('Could not load processes', `${view.error} Your search is kept.`, el('button', {class:'btn', type:'button', text:'Retry', onclick:() => load()}), 'error')];
    return ['loading', () => el('div', {class:'state', role:'status'}, el('span', {class:'spinner', 'aria-hidden':'true'}), el('h2', {text:'Loading processes…'}))];
  }
  if (!rows.length) return ['none', () => stateBlock('No terminals are open', 'Processes appear here when a terminal starts a program.', el('button', {class:'btn primary', type:'button', onclick:() => openLauncher()}, icon('plus'), 'New terminal'))];
  if (!shown) return [`none:${view.query.trim()}`, () => stateBlock('No matching terminals or processes', `Nothing matches “${view.query.trim()}”.`, el('button', {class:'btn', type:'button', text:'Clear search', onclick:clearSearch}))];
  return ['', null];
}

function paint() {
  const nodes = view.nodes;
  if (!nodes) return;
  const all = model(), rows = all.filter(row => row.matches), query = view.query.trim();
  const total = all.reduce((sum, row) => sum + row.total, 0);
  nodes.summary.textContent = !view.data || !all.length ? '' : query ? `${rows.length} of ${plural(all.length, 'terminal')} match` : `${plural(total, 'process', 'processes')} in ${plural(all.length, 'terminal')}`;
  nodes.updated.textContent = view.data ? `Updated ${clock(view.data.at)}` : '';
  nodes.refresh.setAttribute('aria-busy', String(Boolean(view.request)));
  nodes.alert.hidden = !(view.error && view.data);
  nodes.alertText.textContent = view.error && view.data ? `Could not refresh: ${view.error} Showing the list from ${clock(view.data.at)}.` : '';
  for (const id of [...view.open]) if (!state.sessions.has(id)) view.open.delete(id);
  for (const id of [...view.collapsed]) if (!state.sessions.has(id)) view.collapsed.delete(id);
  const [key, build] = emptyState(all, rows.length);
  nodes.table.hidden = Boolean(build);
  nodes.empty.hidden = !build;
  if (build) {
    const refocus = nodes.empty.contains(document.activeElement);
    if (patch(nodes.empty, key, build) && refocus) nodes.search.focus({preventScroll:true});
  } else delete nodes.empty.dataset.key;
  renderRows(nodes.list, build ? [] : rows);
}

function build() {
  const search = el('input', {class:'field', id:'process-search', type:'search', placeholder:'Search processes, PIDs or terminals', autocomplete:'off', spellcheck:'false', 'aria-label':'Search processes',
    oninput:() => { view.query = search.value; view.collapsed.clear(); paint(); }});
  const refresh = el('button', {class:'btn', type:'button', text:'Refresh', onclick:() => load()});
  const updated = el('span', {class:'process-updated'});
  const alertText = el('span');
  const alert = el('div', {class:'process-alert', role:'alert', hidden:true}, alertText, el('button', {class:'btn sm', type:'button', text:'Retry', onclick:() => load()}));
  const summaryText = el('p', {class:'process-summary', role:'status'});
  const list = el('ul', {class:'process-list', 'aria-label':'Terminals'});
  const table = el('div', {class:'process-table'},
    el('div', {class:'process-columns', 'aria-hidden':'true'}, el('span', {text:'Terminal'}), el('span', {text:'Programs'}), el('span', {class:'process-count', text:'Processes'}), el('span', {text:'Status'}), el('span')),
    list);
  const empty = el('div', {class:'process-empty', hidden:true});
  $('processes-actions').replaceChildren(updated, refresh);
  $('processes-content').replaceChildren(el('div', {class:'process-root'},
    el('div', {class:'process-tools'}, el('div', {class:'search-field process-search'}, icon('search'), search), summaryText), alert, table, empty,
    el('p', {class:'process-footnote', text:'Only processes Webterminal started, updated every 2 seconds while this page is open. Closing a terminal stops all of its processes.'})));
  view.nodes = {search, refresh, updated, alert, alertText, summary:summaryText, list, table, empty};
}

export function show() {
  if (!view.nodes) build();
  load();
}

export function render() { paint(); }
