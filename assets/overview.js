// Overview: a real summary of this server and the terminal inventory (Stack).
// Search, filter, sort, selection and scroll survive live updates; bulk close
// always targets the exact selected IDs that still exist.
import {$, ago, avatar, badge, el, icon, patch, pathText, plural, programTile} from './dom.js';
import {SESSION_LIMIT, WORKSPACE_LIMIT, failedSessions, go, needsYou, orderedSessions, programLabel, showTerminal, state, terminalName, terminalStatus, unreadReplies, waitingRequests, workspaceIndex, workspaceLabel, workspaceOf} from './model.js';
import {displayPath} from './common.js';
import {closeTerminals, showTerminalMenu} from './actions.js';
import {openLauncher} from './launcher.js';
import {choice} from './overlays.js';

const FILTERS = [
  {id:'all', label:'All', test:() => true},
  {id:'needs', label:'Needs you', test:row => needsYou(row.id)},
  {id:'running', label:'Running', test:row => row.alive},
  {id:'exited', label:'Exited or failed', test:row => !row.alive},
];
const SORTS = [['workspace', 'Workspace order'], ['name', 'Name A–Z'], ['status', 'Status'], ['newest', 'Newest first']];
// Status sort: what needs you first, then live work, then finished terminals.
const RANK = {needs:0, failed:1, active:2, quiet:3, exited:4, unknown:5};

const view = {query:'', filter:'all', sort:'workspace', selected:new Set()};
let ui = null;

// One row of real data per session, in workspace order.
function rows() {
  const order = orderedSessions();
  for (const id of state.sessions.keys()) if (!order.includes(id)) order.push(id);
  return order.map((id, index) => {
    const session = state.sessions.get(id), workspace = workspaceOf(id);
    return {
      id, index, alive:Boolean(session.alive), name:terminalName(id), program:programLabel(session), cwd:displayPath(session.cwd),
      workspace, place:workspace ? workspaceLabel(workspace) : 'No workspace', status:terminalStatus(id), created:session.created || 0,
    };
  });
}
function matching(all) {
  const query = view.query.trim().toLocaleLowerCase();
  if (!query) return all;
  return all.filter(row => `${row.name}\n${row.program}\n${row.cwd}\n${row.place}`.toLocaleLowerCase().includes(query));
}
function sorted(list) {
  const compare = {
    workspace:(a, b) => a.index - b.index,
    name:(a, b) => a.name.localeCompare(b.name, undefined, {numeric:true, sensitivity:'base'}) || a.index - b.index,
    status:(a, b) => (RANK[a.status.key] ?? 9) - (RANK[b.status.key] ?? 9) || a.index - b.index,
    newest:(a, b) => b.created - a.created || a.index - b.index,
  }[view.sort];
  return [...list].sort(compare);
}
const filterOf = id => FILTERS.find(filter => filter.id === id) || FILTERS[0];
function filtered() { return Boolean(view.query.trim()) || view.filter !== 'all'; }
function clearFilters() {
  view.query = '';
  view.filter = 'all';
  ui.search.value = '';
  update();
}

// Built once; later renders patch it in place so focus and drafts survive.
function build() {
  ui = {};
  ui.summary = el('section', {class:'overview-summary', 'aria-label':'Summary'});
  ui.search = el('input', {type:'search', class:'field', id:'inventory-search', placeholder:'Name, program, folder…', autocomplete:'off', spellcheck:'false',
    oninput:event => { view.query = event.target.value; update(); }});
  const select = el('select', {id:'inventory-sort', onchange:event => { view.sort = event.target.value; update(); }},
    SORTS.map(([value, label]) => el('option', {value, text:label})));
  select.value = view.sort;
  ui.filters = el('div', {class:'inventory-filters', role:'group', 'aria-label':'Filter terminals by status'},
    FILTERS.map(filter => el('button', {class:'btn sm', type:'button', 'aria-pressed':'false', dataset:{filter:filter.id},
      onclick:() => { view.filter = filter.id; update(); }}, el('span', {text:filter.label}), el('span', {class:'inventory-filter-count', text:'0'}))));
  ui.all = el('input', {type:'checkbox', class:'check', id:'inventory-select-all', 'aria-label':'Select all visible terminals',
    onchange:event => { for (const id of ui.visible) { if (event.target.checked) view.selected.add(id); else view.selected.delete(id); } update(); }});
  ui.result = el('p', {class:'inventory-result-text', role:'status', 'aria-live':'polite'});
  ui.clear = el('button', {class:'btn ghost sm', type:'button', text:'Clear filters', onclick:() => { clearFilters(); ui.search.focus(); }});
  ui.tools = el('div', {class:'inventory-tools'},
    el('div', {class:'inventory-fields'},
      el('div', {class:'inventory-search'}, el('label', {class:'lbl', for:'inventory-search', text:'Search terminals'}), el('div', {class:'search-field'}, icon('search'), ui.search)),
      el('div', {class:'inventory-sort'}, el('span', {class:'lbl', id:'inventory-sort-label', text:'Sort by'}), select)),
    ui.filters,
    el('div', {class:'inventory-result'}, el('label', {class:'inventory-select-all'}, el('span', {class:'inventory-check'}, ui.all), el('span', {text:'Select visible'})), ui.result, ui.clear));
  ui.body = el('tbody');
  ui.table = el('table', {class:'inventory-table'},
    el('caption', {class:'sr-only', text:'Terminals in every workspace'}),
    el('thead', {}, el('tr', {},
      el('th', {scope:'col', class:'inventory-cell-select'}, el('span', {class:'sr-only', text:'Selected'})),
      el('th', {scope:'col', class:'inventory-cell-identity', text:'Terminal'}),
      el('th', {scope:'col', class:'inventory-cell-workspace', text:'Workspace'}),
      el('th', {scope:'col', class:'inventory-cell-status', text:'Status'}),
      el('th', {scope:'col', class:'inventory-cell-created', text:'Created'}),
      el('th', {scope:'col', class:'inventory-cell-meta', text:'Details'}),
      el('th', {scope:'col', class:'inventory-cell-actions'}, el('span', {class:'sr-only', text:'Actions'})))),
    ui.body);
  ui.empty = el('div', {class:'inventory-empty'});
  ui.bulk = el('div', {class:'inventory-bulk', role:'region', 'aria-label':'Selected terminals', hidden:true});
  ui.count = el('span', {class:'inventory-count'});
  ui.panel = el('section', {class:'inventory', 'aria-labelledby':'inventory-title'},
    el('header', {class:'inventory-head'}, el('h2', {id:'inventory-title', tabindex:'-1', text:'Terminals'}), ui.count),
    ui.tools, ui.table, ui.empty, ui.bulk);
  $('overview-content').replaceChildren(el('div', {class:'overview'}, ui.summary, ui.panel));
  choice(select, 'Sort terminals').trigger.setAttribute('aria-labelledby', 'inventory-sort-label');
  $('overview-actions').replaceChildren(el('button', {class:'btn primary', type:'button', 'aria-label':'Open terminal', onclick:() => openLauncher()}, icon('plus'), el('span', {class:'label', text:'Open terminal'})));
  ui.rows = new Map();
}

// The summary keeps each count separate: requests, failures and replies
// answer different questions and are never added together.
function summary() {
  const total = state.sessions.size, spaces = state.workspaces.length, waiting = waitingRequests(), failures = failedSessions().length, unread = unreadReplies();
  const oldest = waiting.reduce((min, request) => Math.min(min, request.created || Infinity), Infinity);
  const tiles = [
    {value:total, label:total === 1 ? 'Terminal' : 'Terminals', note:`of ${SESSION_LIMIT} · ${Math.max(0, SESSION_LIMIT - total)} free`, action:'Show the list', run:showList},
    {value:spaces, label:spaces === 1 ? 'Workspace' : 'Workspaces', note:`of ${WORKSPACE_LIMIT}`, action:'Open Terminals', run:() => go('workspace')},
    {value:waiting.length, label:waiting.length === 1 ? 'Request waiting' : 'Requests waiting', tone:waiting.length ? 'amber' : null,
      note:waiting.length ? `Oldest ${Number.isFinite(oldest) ? ago(oldest) : 'now'}` : 'No agent is waiting', action:'Open Needs you', run:() => go('attention')},
    {value:failures, label:failures === 1 ? 'Failed terminal' : 'Failed terminals', tone:failures ? 'red' : null,
      note:failures ? 'Exited with an error' : 'No failures', action:'Open Needs you', run:() => go('attention')},
    {value:unread, label:unread === 1 ? 'Unread reply' : 'Unread replies', note:unread ? 'Waiting in Reader' : 'All read', action:'Open Reader', run:() => go('reader')},
  ];
  const focused = [...ui.summary.children].indexOf(document.activeElement);
  patch(ui.summary, JSON.stringify(tiles.map(({value, label, note, tone}) => [value, label, note, tone])), () => tiles.map(tile =>
    el('button', {class:'overview-stat', type:'button', 'data-tone':tile.tone, 'aria-label':`${tile.value} ${tile.label}, ${tile.note}. ${tile.action}`, onclick:tile.run},
      el('b', {text:String(tile.value)}), el('span', {class:'overview-stat-label', text:tile.label}), el('small', {text:tile.note}))));
  if (focused >= 0 && !ui.summary.contains(document.activeElement)) ui.summary.children[focused]?.focus({preventScroll:true});
}
function showList() {
  // Only the page content scrolls, so the top bar stays in place.
  const content = $('overview-content');
  content.scrollTop += ui.panel.getBoundingClientRect().top - content.getBoundingClientRect().top - 16;
  $('inventory-title').focus({preventScroll:true});
}

// Rows are keyed by session ID and rebuilt only when what they show changed.
function rowNode(row) {
  const select = el('input', {type:'checkbox', class:'check', 'aria-label':`Select ${row.name} in ${row.place}`, checked:view.selected.has(row.id), dataset:{focus:'select'},
    onchange:event => { if (event.target.checked) view.selected.add(row.id); else view.selected.delete(row.id); update(); }});
  const status = () => badge(row.status.label, row.status.tone);
  const place = () => el('span', {class:'inventory-workspace'}, row.workspace ? avatar(workspaceIndex(row.workspace), row.place, 'xs') : null, el('span', {text:row.place}));
  const age = () => el('span', {class:'inventory-time', title:row.created ? new Date(row.created).toLocaleString() : undefined, dataset:{created:String(row.created)}, text:row.created ? ago(row.created) : ''});
  const menuButton = el('button', {class:'icon-btn ghost', type:'button', 'aria-label':`Actions for ${row.name}`, 'aria-haspopup':'menu', dataset:{focus:'menu'},
    onclick:event => showTerminalMenu(row.id, event.currentTarget)}, icon('ellipsis'));
  return el('tr', {class:'inventory-row', dataset:{id:row.id}, 'data-selected':String(view.selected.has(row.id)),
    onclick:event => { if (!event.target.closest('button, input, label, a, .inventory-cell-select, .inventory-cell-actions')) showTerminal(row.id); }},
  el('td', {class:'inventory-cell-select'}, el('label', {class:'inventory-check'}, select)),
  el('td', {class:'inventory-cell-identity'}, el('div', {class:'inventory-identity'}, programTile(),
    el('div', {}, el('button', {class:'inventory-name', type:'button', dataset:{focus:'open'}, title:`Open ${row.name}`, text:row.name, onclick:() => showTerminal(row.id)}),
      el('span', {class:'inventory-program', text:row.program}), el('span', {class:'inventory-folder'}, pathText(row.cwd, ''))))),
  el('td', {class:'inventory-cell-workspace'}, place()),
  el('td', {class:'inventory-cell-status'}, status()),
  el('td', {class:'inventory-cell-created'}, age()),
  el('td', {class:'inventory-cell-meta'}, el('div', {}, place(), status(), age())),
  el('td', {class:'inventory-cell-actions'}, menuButton));
}
const rowKey = row => JSON.stringify([row.name, row.program, row.cwd, row.place, row.workspace ? workspaceIndex(row.workspace) : -1, row.status.label, row.status.tone, row.created, view.selected.has(row.id)]);

// Restores keyboard focus to the same control of the same row after a row
// was rebuilt or moved.
function keepFocus(container, run) {
  const active = document.activeElement;
  const was = active && container.contains(active) ? {id:active.closest('[data-id]')?.dataset.id, focus:active.dataset.focus} : null;
  run();
  if (!was || document.activeElement === active && active.isConnected) return;
  const row = was.id ? [...container.querySelectorAll('[data-id]')].find(node => node.dataset.id === was.id) : null;
  (row?.querySelector(`[data-focus="${was.focus}"]`) || row?.querySelector('[data-focus="open"]'))?.focus({preventScroll:true});
}

function renderRows(visible) {
  keepFocus(ui.body, () => {
    const ids = new Set(visible.map(row => row.id));
    for (const [id, node] of ui.rows) if (!ids.has(id)) { node.remove(); ui.rows.delete(id); }
    for (const row of visible) {
      const key = rowKey(row), old = ui.rows.get(row.id);
      if (old?.dataset.key === key) continue;
      const node = rowNode(row);
      node.dataset.key = key;
      if (old) old.replaceWith(node);
      ui.rows.set(row.id, node);
    }
    const wanted = visible.map(row => ui.rows.get(row.id));
    if (wanted.some((node, index) => ui.body.children[index] !== node)) ui.body.append(...wanted);
  });
}

function renderEmpty(all, visible) {
  let key = '', build = null;
  if (!state.listed) {
    key = 'loading';
    build = () => el('div', {class:'state', role:'status'}, el('span', {class:'spinner', 'aria-hidden':'true'}), el('h2', {text:'Loading terminals…'}), el('p', {text:'Waiting for the local server.'}));
  } else if (!all.length) {
    key = 'none';
    build = () => el('div', {class:'state'}, el('span', {class:'tile', 'aria-hidden':'true'}, icon('square-terminal')), el('h2', {text:'No terminals yet'}),
      el('p', {text:'Open a terminal to start working. Terminals keep running when you close the browser.'}),
      el('button', {class:'btn primary', type:'button', onclick:() => openLauncher()}, icon('plus'), 'Open terminal'));
  } else if (!visible.length) {
    key = `none-matching:${view.query}:${view.filter}`;
    const query = view.query.trim();
    build = () => el('div', {class:'state'}, el('h2', {text:'No matching terminals'}),
      el('p', {text:query ? `Nothing matches “${query}” with the ${filterOf(view.filter).label} filter.` : `No terminal is in the ${filterOf(view.filter).label} filter right now.`}),
      el('button', {class:'btn', type:'button', text:'Clear filters', onclick:() => { clearFilters(); ui.search.focus(); }}));
  }
  ui.empty.hidden = !build;
  ui.table.hidden = Boolean(build);
  if (build) patch(ui.empty, key, build); else delete ui.empty.dataset.key;
}

// Selection is an explicit set of IDs: a filter may hide selected terminals,
// but the bar always says how many and closing includes exactly them.
function renderBulk(visible) {
  const ids = [...view.selected], shown = new Set(visible.map(row => row.id)), hidden = ids.filter(id => !shown.has(id)).length;
  ui.bulk.hidden = !ids.length;
  if (!ids.length) { delete ui.bulk.dataset.key; return; }
  const restore = ui.bulk.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  const changed = patch(ui.bulk, `${ids.length}:${hidden}`, () => [
    el('div', {class:'inventory-bulk-text'}, el('b', {text:`${ids.length} selected`}),
      el('p', {text:hidden ? `${hidden} of them ${hidden === 1 ? 'is' : 'are'} hidden by the current filter. Closing includes ${hidden === 1 ? 'it' : 'them'}.` : 'All selected terminals are visible.'})),
    el('div', {class:'inventory-bulk-actions'},
      hidden ? el('button', {class:'btn ghost sm', type:'button', dataset:{focus:'show'}, text:'Show all', onclick:clearFilters}) : null,
      el('button', {class:'btn sm', type:'button', dataset:{focus:'clear'}, text:'Clear', 'aria-label':'Clear selection', onclick:() => { view.selected.clear(); update(); ui.search.focus(); }}),
      el('button', {class:'btn danger sm', type:'button', dataset:{focus:'close'}, onclick:closeSelected}, icon('square-x'), `Close ${plural(ids.length, 'terminal')}`)),
  ]);
  if (changed && restore) ui.bulk.querySelector(`[data-focus="${restore}"]`)?.focus({preventScroll:true});
}
async function closeSelected() {
  const ids = [...view.selected].filter(id => state.sessions.has(id));
  if (await closeTerminals(ids)) {
    for (const id of ids) view.selected.delete(id);
    update();
  }
}

function update() {
  if (!ui) return;
  for (const id of [...view.selected]) if (!state.sessions.has(id)) view.selected.delete(id);
  const all = rows(), found = matching(all), filter = filterOf(view.filter), visible = sorted(found.filter(filter.test));
  ui.visible = visible.map(row => row.id);
  summary();
  const total = state.sessions.size;
  $('overview-subtitle').textContent = state.listed ? `${plural(total, 'terminal')} across ${plural(state.workspaces.length, 'workspace')}` : 'Connecting to the local server…';
  ui.count.textContent = state.listed ? `${total} of ${SESSION_LIMIT}` : '';
  ui.tools.hidden = !all.length;
  for (const button of ui.filters.children) {
    const item = filterOf(button.dataset.filter), count = found.filter(item.test).length;
    button.setAttribute('aria-pressed', String(item.id === view.filter));
    button.setAttribute('aria-label', `${item.label}, ${count}`);
    button.lastChild.textContent = String(count);
  }
  const result = filtered() ? `Showing ${visible.length} of ${plural(all.length, 'terminal')}` : `${plural(all.length, 'terminal')}`;
  if (ui.result.textContent !== result) ui.result.textContent = result;
  ui.clear.hidden = !filtered();
  const chosen = visible.filter(row => view.selected.has(row.id)).length;
  ui.all.checked = Boolean(visible.length) && chosen === visible.length;
  ui.all.indeterminate = chosen > 0 && chosen < visible.length;
  ui.all.disabled = !visible.length;
  renderRows(visible);
  renderEmpty(all, visible);
  renderBulk(visible);
}

// Ages move on without a server message while the page is visible.
setInterval(() => {
  if (!ui || state.page !== 'overview') return;
  for (const node of ui.panel.querySelectorAll('[data-created]')) {
    const created = Number(node.dataset.created);
    if (created) node.textContent = ago(created);
  }
  summary();
}, 30000);

export function show() {
  if (!ui) build();
}
export function render() {
  if (!ui) build();
  update();
}
