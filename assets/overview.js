// Overview: a real summary of this server and the terminal inventory.
// Search, filter, sort, selection and scroll survive live updates; bulk close
// always targets the exact selected IDs that still exist.
import {$, ago, avatar, badge, el, icon, patch, plural} from './dom.js';
import {PANE_LIMIT, SESSION_LIMIT, WORKSPACE_LIMIT, failedSessions, orderedSessions, sessionShell, showTerminal, state, terminalName, terminalStatus, workspaceIndex, workspaceLabel, workspaceOf} from './model.js';
import {displayPath} from './common.js';
import {closeTerminals, showTerminalMenu} from './actions.js';
import {openLauncher} from './launcher.js';
import {menu} from './ui.js';

const FILTERS = [
  {id:'all', label:'All', test:() => true},
  {id:'running', label:'Running', test:row => row.alive},
  {id:'failed', label:'Failed', test:row => row.status.key === 'failed'},
  {id:'exited', label:'Exited or failed', test:row => !row.alive},
];
const SORTS = [['workspace', 'Workspace order'], ['name', 'Name A–Z'], ['status', 'Status'], ['newest', 'Newest first']];
// Status sort: failures first, then live work, then finished terminals.
const RANK = {failed:0, active:1, exited:2, unknown:3};

const view = {query:'', filter:'all', sort:'workspace', selected:new Set()};
let ui = null;

// One row of real data per session, in workspace order.
function rows() {
  const order = orderedSessions();
  for (const id of state.sessions.keys()) if (!order.includes(id)) order.push(id);
  return order.map((id, index) => {
    const session = state.sessions.get(id), workspace = workspaceOf(id);
    return {
      id, index, alive:Boolean(session.alive), name:terminalName(id), program:sessionShell(session), cwd:displayPath(session.cwd),
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
const sortLabel = () => SORTS.find(([id]) => id === view.sort)[1];
// Grouping follows the workspace order only; other sorts mix workspaces.
const grouped = () => view.sort === 'workspace';
function clearFilters() {
  view.query = '';
  view.filter = 'all';
  ui.search.value = '';
  update();
}

// Built once; later renders patch it in place so focus and drafts survive.
function build() {
  ui = {groups:new Map(), rows:new Map()};
  ui.summary = el('section', {class:'overview-summary', 'aria-label':'Summary'});
  ui.search = el('input', {type:'search', class:'field', id:'inventory-search', placeholder:'Name, shell, folder…', autocomplete:'off', spellcheck:'false', 'aria-label':'Search terminals',
    oninput:event => { view.query = event.target.value; update(); }});
  ui.filters = el('div', {class:'segment inventory-filters', role:'group', 'aria-label':'Filter terminals by status'},
    FILTERS.map(filter => el('button', {type:'button', 'aria-pressed':'false', dataset:{filter:filter.id}, onclick:() => { view.filter = filter.id; update(); }},
      el('span', {text:filter.label}), el('span', {class:'count', text:'0'}))));
  ui.sort = el('button', {class:'btn ghost inventory-sort', type:'button', id:'inventory-sort', 'aria-haspopup':'menu', 'aria-expanded':'false',
    onclick:() => menu.toggle(ui.sort, SORTS.map(([id, label]) => ({label, checked:id === view.sort, action:() => { view.sort = id; update(); }})), {label:'Sort terminals'})});
  ui.result = el('p', {class:'sr-only', role:'status', 'aria-live':'polite'});
  ui.tools = el('div', {class:'inventory-tools'}, el('div', {class:'search-field inventory-search'}, icon('search'), ui.search), ui.filters, ui.sort, ui.result);
  ui.all = el('input', {type:'checkbox', class:'check', id:'inventory-select-all', 'aria-label':'Select all visible terminals',
    onchange:event => { for (const id of ui.visible) { if (event.target.checked) view.selected.add(id); else view.selected.delete(id); } update(); }});
  ui.body = el('tbody');
  ui.table = el('table', {class:'inventory-table'},
    el('caption', {class:'sr-only', text:'Terminals in every workspace'}),
    el('thead', {}, el('tr', {},
      el('th', {scope:'col', class:'inventory-cell-select'}, ui.all),
      el('th', {scope:'col', class:'inventory-cell-identity', text:'Terminal'}),
      el('th', {scope:'col', class:'inventory-cell-workspace', text:'Workspace'}),
      el('th', {scope:'col', class:'inventory-cell-status', text:'Status'}),
      el('th', {scope:'col', class:'inventory-cell-created', text:'Created'}),
      el('th', {scope:'col', class:'inventory-cell-actions'}, el('span', {class:'sr-only', text:'Actions'})))),
    ui.body);
  ui.hidden = el('div', {class:'inventory-hidden', hidden:true});
  ui.empty = el('div', {class:'inventory-empty'});
  ui.bulk = el('div', {class:'inventory-bulk', role:'region', 'aria-label':'Selected terminals', hidden:true});
  ui.panel = el('section', {class:'inventory', 'aria-labelledby':'inventory-title'},
    el('h2', {class:'sr-only', id:'inventory-title', tabindex:'-1', text:'Terminals'}), ui.tools, ui.bulk, ui.table, ui.hidden, ui.empty);
  $('overview-content').replaceChildren(el('div', {class:'overview'}, ui.summary, ui.panel));
  $('overview-actions').replaceChildren(el('button', {class:'btn primary', type:'button', onclick:() => openLauncher()}, icon('plus'), 'New terminal'));
}

// Capacity and outcomes as separate cards; each opens the matching list.
function summary() {
  const total = state.sessions.size, spaces = state.workspaces.length, failures = failedSessions();
  const running = [...state.sessions.values()].filter(session => session.alive).length, exited = total - running - failures.length;
  const first = failures[0];
  const cards = [
    {label:'Terminals', value:total, limit:SESSION_LIMIT, action:'Show every terminal', run:() => showList('all')},
    {label:'Workspaces', value:spaces, limit:WORKSPACE_LIMIT, action:'Show every terminal', run:() => showList('all')},
    {label:'Running', value:running, note:exited ? `${exited} exited` : running ? 'None exited' : 'Nothing running', action:'Show running terminals', run:() => showList('running')},
    {label:'Failed', value:failures.length, tone:failures.length ? 'red' : null,
      note:failures.length === 1 ? `${terminalName(first.id)} · exit ${first.exitCode}` : failures.length ? `${failures.length} exited with an error` : 'No failures',
      action:'Show failed terminals', run:() => showList('failed')},
  ];
  const focused = [...ui.summary.children].indexOf(document.activeElement);
  patch(ui.summary, JSON.stringify(cards.map(({label, value, note, tone}) => [label, value, note, tone])), () => cards.map(card =>
    el('button', {class:'overview-stat', type:'button', 'data-tone':card.tone,
      'aria-label':`${card.label}: ${card.value}${card.limit ? ` of ${card.limit}` : ''}${card.note ? `, ${card.note}` : ''}. ${card.action}`, onclick:card.run},
    el('span', {class:'overview-stat-label', text:card.label}),
    el('b', {}, String(card.value), card.limit ? el('span', {text:` of ${card.limit}`}) : null),
    card.limit ? meter(card.value / card.limit) : el('small', {text:card.note}))));
  if (focused >= 0 && !ui.summary.contains(document.activeElement)) ui.summary.children[focused]?.focus({preventScroll:true});
}
// The style policy forbids style attributes, so the width goes through CSSOM.
function meter(share) {
  const fill = el('i');
  fill.style.width = `${Math.min(100, share * 100)}%`;
  return el('span', {class:'overview-stat-meter', 'aria-hidden':'true'}, fill);
}
function showList(filter) {
  if (view.filter !== filter) { view.filter = filter; update(); }
  // Only the page content scrolls, so the top bar stays in place.
  const content = $('overview-content');
  content.scrollTop += ui.tools.getBoundingClientRect().top - content.getBoundingClientRect().top - 8;
  $('inventory-title').focus({preventScroll:true});
}

// Rows are keyed by session ID and rebuilt only when what they show changed.
function rowNode(row) {
  const select = el('input', {type:'checkbox', class:'check', 'aria-label':`Select ${row.name} in ${row.place}`, checked:view.selected.has(row.id), dataset:{focus:'select'},
    onchange:event => { if (event.target.checked) view.selected.add(row.id); else view.selected.delete(row.id); update(); }});
  const menuButton = el('button', {class:'icon-btn ghost', type:'button', 'aria-label':`Actions for ${row.name}`, 'aria-haspopup':'menu', 'aria-expanded':'false', dataset:{focus:'menu'},
    onclick:event => showTerminalMenu(row.id, event.currentTarget)}, icon('ellipsis'));
  return el('tr', {class:'inventory-row', dataset:{id:row.id}, 'data-selected':String(view.selected.has(row.id)),
    onclick:event => { if (!event.target.closest('button, input, label, a, .inventory-cell-select, .inventory-cell-actions')) showTerminal(row.id); }},
  el('td', {class:'inventory-cell-select'}, select),
  el('td', {class:'inventory-cell-identity'},
    el('button', {class:'inventory-name', type:'button', dataset:{focus:'open'}, title:`Open ${row.name}`, text:row.name, onclick:() => showTerminal(row.id)}),
    // One truncated line: Chrome breaks at <wbr> even under nowrap.
    el('span', {class:'inventory-sub'}, `${row.program} · `, el('span', {class:'mono', title:row.cwd, text:row.cwd}))),
  el('td', {class:'inventory-cell-workspace'}, el('span', {class:'inventory-workspace'}, row.workspace ? avatar(workspaceIndex(row.workspace), row.place, 'xs') : null, el('span', {text:row.place}))),
  el('td', {class:'inventory-cell-status'}, badge(row.status.label, row.status.tone)),
  el('td', {class:'inventory-cell-created'}, el('span', {class:'inventory-time', title:row.created ? new Date(row.created).toLocaleString() : undefined, dataset:{created:String(row.created)}, text:row.created ? ago(row.created) : ''})),
  el('td', {class:'inventory-cell-actions'}, menuButton));
}
const rowKey = row => JSON.stringify([row.name, row.program, row.cwd, row.place, row.workspace ? workspaceIndex(row.workspace) : -1, row.status.label, row.status.tone, row.created, view.selected.has(row.id)]);

// A workspace heading in grouped order: avatar, name and how many are shown.
// It spans the five visible columns; grouped order hides Workspace, and a
// sixth span would add an empty fixed-layout column.
function groupNode(workspace, shown) {
  const label = workspace ? workspaceLabel(workspace) : 'No workspace', count = workspace?.sessions.length || shown;
  const text = shown < count ? `${shown} of ${count} shown` : `${count} of ${PANE_LIMIT}`;
  const key = JSON.stringify([label, workspace ? workspaceIndex(workspace) : -1, text]);
  const id = workspace?.id || '', old = ui.groups.get(id);
  if (old?.dataset.key === key) return old;
  const node = el('tr', {class:'inventory-group', dataset:{key}},
    el('th', {scope:'colgroup', colspan:'5'}, el('span', {}, workspace ? avatar(workspaceIndex(workspace), label, 'xs') : null, el('span', {class:'inventory-group-name', text:label}), el('span', {text:`· ${text}`}))));
  ui.groups.set(id, node);
  return node;
}

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
    const wanted = [];
    let current;
    for (const row of visible) {
      if (grouped() && row.workspace !== current) {
        current = row.workspace;
        wanted.push(groupNode(current, visible.filter(item => item.workspace === current).length));
      }
      const key = rowKey(row), old = ui.rows.get(row.id);
      if (old?.dataset.key !== key) {
        const node = rowNode(row);
        node.dataset.key = key;
        if (old) old.replaceWith(node);
        ui.rows.set(row.id, node);
      }
      wanted.push(ui.rows.get(row.id));
    }
    const keep = new Set(wanted);
    for (const node of [...ui.body.children]) if (!keep.has(node)) node.remove();
    if (wanted.some((node, index) => ui.body.children[index] !== node)) ui.body.append(...wanted);
  });
  ui.table.dataset.grouped = String(grouped());
}

// Rows a search or filter hides are counted, never silently dropped.
function renderHidden(all, visible) {
  const hidden = all.length - visible.length, query = Boolean(view.query.trim()), filter = view.filter !== 'all';
  ui.hidden.hidden = !hidden || !visible.length;
  if (ui.hidden.hidden) { delete ui.hidden.dataset.key; return; }
  const by = query && filter ? 'the search and filter' : query ? 'the search' : 'the filter';
  patch(ui.hidden, `${hidden}:${by}`, () => [
    el('span', {text:`${plural(hidden, 'terminal')} ${hidden === 1 ? 'is' : 'are'} hidden by ${by}.`}),
    el('button', {class:'btn ghost sm', type:'button', text:'Show all', onclick:() => { clearFilters(); ui.search.focus(); }}),
  ]);
}

function renderEmpty(all, visible) {
  let key = '', build = null;
  if (!state.listed) {
    key = 'loading';
    build = () => el('div', {class:'state', role:'status'}, el('span', {class:'spinner', 'aria-hidden':'true'}), el('h2', {text:'Loading terminals…'}), el('p', {text:'Waiting for the local server.'}));
  } else if (!all.length) {
    key = 'none';
    build = () => el('div', {class:'state'}, el('span', {class:'state-mark', 'aria-hidden':'true'}, icon('square-terminal')), el('h2', {text:'No terminals yet'}),
      el('p', {text:'Open a terminal to start working. Terminals keep running when you close the browser.'}),
      el('button', {class:'btn primary', type:'button', onclick:() => openLauncher()}, icon('plus'), 'New terminal'));
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
    el('b', {text:`${ids.length} selected`}),
    el('span', {class:'inventory-bulk-detail', text:hidden ? `${hidden} hidden by the filter; closing includes ${hidden === 1 ? 'it' : 'them'}` : ids.length === 1 ? 'visible' : ids.length === 2 ? 'both visible' : 'all visible'}),
    el('div', {class:'inventory-bulk-actions'},
      hidden ? el('button', {class:'btn ghost sm', type:'button', dataset:{focus:'show'}, text:'Show all', onclick:clearFilters}) : null,
      el('button', {class:'btn ghost sm', type:'button', dataset:{focus:'clear'}, text:'Clear', 'aria-label':'Clear selection', onclick:() => { view.selected.clear(); update(); ui.search.focus(); }}),
      el('button', {class:'btn danger sm', type:'button', dataset:{focus:'close'}, text:`Close ${plural(ids.length, 'terminal')}…`, onclick:closeSelected})),
  ]);
  if (changed && restore) ui.bulk.querySelector(`[data-focus="${restore}"]`)?.focus({preventScroll:true});
}
async function closeSelected() {
  const ids = [...view.selected].filter(id => state.sessions.has(id));
  if (await closeTerminals(ids, {confirm:true})) {
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
  $('overview-subtitle').textContent = state.listed ? 'Every terminal on this server' : 'Connecting to the local server…';
  ui.tools.hidden = !all.length;
  for (const button of ui.filters.children) {
    const item = filterOf(button.dataset.filter), count = found.filter(item.test).length;
    button.setAttribute('aria-pressed', String(item.id === view.filter));
    button.setAttribute('aria-label', `${item.label}, ${count}`);
    button.lastChild.textContent = String(count);
  }
  if (ui.sort.textContent !== `Sort: ${sortLabel()}`) ui.sort.textContent = `Sort: ${sortLabel()}`;
  const result = visible.length < all.length ? `Showing ${visible.length} of ${plural(all.length, 'terminal')}` : plural(all.length, 'terminal');
  if (ui.result.textContent !== result) ui.result.textContent = result;
  const chosen = visible.filter(row => view.selected.has(row.id)).length;
  ui.all.checked = Boolean(visible.length) && chosen === visible.length;
  ui.all.indeterminate = chosen > 0 && chosen < visible.length;
  ui.all.disabled = !visible.length;
  renderRows(visible);
  renderHidden(all, visible);
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
}, 30000);

export function show() {
  if (!ui) build();
}
export function render() {
  if (!ui) build();
  update();
}
