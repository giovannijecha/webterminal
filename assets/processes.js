// Processes: what Webterminal started, grouped by terminal. The list polls the
// server only while this page is visible; details open on explicit selection,
// and every action targets the owning terminal, never a process ID.
import {$, avatar, badge, clock, ago, el, icon, patch, pathText, plural} from './dom.js';
import {control, orderedSessions, sessionShell, showTerminal, state, subscribe, terminalName, workspaceIndex, workspaceLabel, workspaceOf} from './model.js';
import {dialogs, menu} from './ui.js';
import {closeTerminals, interrupt} from './actions.js';
import {openLauncher} from './launcher.js';

const POLL = 2000;
const wide = matchMedia('(min-width:901px)');
// `last` keeps the selected process as last seen, so its exit can be shown.
const view = {data:null, error:'', request:null, timer:0, query:'', selected:null, last:null, nodes:null};

// A PID can be reused after exit; the start time tells the two apart.
const keyOf = (session, process) => `${session}:${process.pid}:${process.started ?? ''}`;
const showing = () => state.page === 'processes' && document.visibilityState === 'visible';
const started = ms => Number.isFinite(ms) ? new Date(ms).toLocaleString([], {dateStyle:'medium', timeStyle:'medium'}) : 'Unknown';
const REASONS = {
  Observing:'Another view controls this terminal. Take control in the terminal to interrupt it.',
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
wide.addEventListener('change', () => paint());

// Terminals in sidebar order; each keeps the server's order (root first).
function model() {
  const order = orderedSessions(), rank = id => (order.indexOf(id) + order.length + 1) % (order.length + 1);
  const query = view.query.trim().toLowerCase(), has = value => String(value ?? '').toLowerCase().includes(query);
  return (view.data?.sessions || []).filter(entry => state.sessions.has(entry.id)).sort((a, b) => rank(a.id) - rank(b.id)).map(entry => {
    const session = state.sessions.get(entry.id), workspace = workspaceOf(entry.id);
    const processes = (entry.processes || []).map(process => ({...process, key:keyOf(entry.id, process)}));
    const group = {id:entry.id, name:terminalName(entry.id), workspace:workspaceLabel(workspace), family:workspace ? workspaceIndex(workspace) : 0,
      program:sessionShell(session), access:control(entry.id), total:entry.total, truncated:entry.truncated, problem:entry.problem, processes};
    group.visible = !query || has(group.name) || has(group.workspace) || has(group.program) ? processes : processes.filter(process => has(process.name) || has(process.pid) || has(process.path));
    return group;
  });
}

function find(groups, key) {
  for (const group of groups) {
    const process = group.processes.find(item => item.key === key);
    if (process) return {group, process};
  }
  return null;
}

// Depth inside the terminal's tree, from the parent IDs it reported.
function depth(process, list, seen = 0) {
  const parent = process.root ? null : list.find(item => item.pid === process.parent);
  return !parent || seen > 3 ? (process.root ? 0 : 1) : depth(parent, list, seen + 1) + 1;
}

function items(group, process) {
  const access = control(group.id);
  return [
    {label:'Details', icon:'info', action:() => inspect(process.key)},
    {label:'Open terminal', icon:'open', action:() => showTerminal(group.id)},
    {separator:true},
    {label:'Interrupt terminal', icon:'stop', hint:access.can ? 'Ctrl+C' : access.label, disabled:!access.can, title:access.can ? 'Sends Ctrl+C to the terminal' : REASONS[access.label], action:() => interrupt(group.id)},
    {label:'Close terminal', icon:'square-x', danger:true, action:() => closeTerminals([group.id])},
  ];
}

function row(group, process) {
  const parent = group.processes.find(item => item.pid === process.parent);
  const node = el('li', {class:'process-row', 'data-root':String(process.root), 'data-selected':String(process.key === view.selected)},
    el('div', {class:'process-identity'},
      el('button', {class:'process-name', type:'button', 'aria-current':process.key === view.selected ? 'true' : null, 'aria-haspopup':wide.matches ? null : 'dialog', dataset:{focus:`name:${process.key}`}, onclick:() => inspect(process.key)},
        el('span', {class:'mono', text:process.name})),
      process.root ? badge('Root', 'neutral', {title:'The process this terminal started'}) : null),
    el('div', {class:'process-meta'},
      el('span', {class:'process-fact'}, el('span', {text:'PID '}), el('b', {text:String(process.pid)})),
      el('span', {class:'process-fact', title:parent ? parent.name : null}, el('span', {text:'Parent '}), el('b', {text:process.parent ?? '—'})),
      el('span', {class:'process-fact', title:started(process.started)}, el('span', {text:'Started '}), el('b', {text:Number.isFinite(process.started) ? clock(process.started) : '—'}))),
    el('button', {class:'icon-btn ghost process-menu', type:'button', 'aria-haspopup':'menu', 'aria-expanded':'false', 'aria-label':`${process.name}, PID ${process.pid}, actions`, dataset:{focus:`menu:${process.key}`},
      onclick:event => menu.toggle(event.currentTarget, () => items(group, process), {label:'Process actions'})}, icon('ellipsis')));
  node.style.setProperty('--depth', depth(process, group.processes));
  return node;
}

function groupNode(group) {
  const meta = [group.workspace, group.program, group.access.mine ? '' : group.access.label].filter(Boolean).join(' · ');
  const shown = group.visible.length, count = group.truncated ? `Showing ${group.processes.length} of ${group.total}` : plural(group.total, 'process', 'processes');
  return el('section', {class:'process-group', 'aria-labelledby':`process-group-${group.id}`},
    el('header', {class:'process-group-head'},
      el('div', {class:'process-group-title'},
        el('h2', {}, el('button', {class:'process-terminal', id:`process-group-${group.id}`, type:'button', title:'Open terminal', dataset:{focus:`terminal:${group.id}`}, onclick:() => showTerminal(group.id), text:group.name})),
        el('p', {class:'process-group-meta'}, avatar(group.family, group.workspace, 'xs'), el('span', {text:meta}))),
      el('span', {class:'process-count', text:view.query.trim() && shown !== group.processes.length ? `${shown} of ${count}` : count})),
    group.problem ? el('p', {class:'process-problem', text:`Process list unavailable: ${group.problem}`}) : null,
    shown ? el('ul', {class:'process-list', 'aria-label':`Processes in ${group.name}`}, group.visible.map(process => row(group, process)))
      : el('p', {class:'process-none', text:group.problem ? '' : 'No running processes.'}));
}

const stateBlock = (title, text, button, tone) => el('div', {class:'state', role:tone === 'error' ? 'alert' : 'status', 'data-tone':tone || null}, el('h2', {text:title}), text ? el('p', {text}) : null, button);

function main(groups, shown) {
  if (!view.data) {
    if (view.error) return stateBlock('Could not load processes', `${view.error} Your search is kept.`, el('button', {class:'btn', type:'button', text:'Retry', onclick:() => load()}), 'error');
    return el('div', {class:'state', role:'status'}, el('span', {class:'spinner', 'aria-hidden':'true'}), el('h2', {text:'Loading processes…'}));
  }
  if (!groups.length) return stateBlock('No terminals are open', 'Processes appear here when a terminal starts a program.', el('button', {class:'btn', type:'button', onclick:() => openLauncher()}, icon('plus'), el('span', {text:'New terminal'})));
  if (view.query.trim() && !shown) return stateBlock('No matching processes', `Nothing matches “${view.query.trim()}”.`, el('button', {class:'btn', type:'button', text:'Clear search', onclick:() => { view.nodes.search.value = ''; view.query = ''; paint(); view.nodes.search.focus(); }}));
  return el('div', {class:'process-groups'}, groups.filter(group => !view.query.trim() || group.visible.length).map(groupNode));
}

function facts(group, process) {
  const parent = group.processes.find(item => item.pid === process.parent);
  const values = [
    ['Process ID', String(process.pid)],
    ['Parent', process.parent == null ? 'None reported' : `${process.parent}${parent ? ` · ${parent.name}` : ' · outside this terminal'}`],
    ['Started', Number.isFinite(process.started) ? `${started(process.started)} · ${ago(process.started)}` : 'Unknown'],
    ['Path', process.path ? pathText(process.path) : 'Not available'],
    ['Terminal', `${group.name} · ${group.program}`],
    ['Workspace', group.workspace],
    ['Control', group.access.label],
  ];
  return el('dl', {class:'process-facts'}, values.map(([label, value]) => el('div', {}, el('dt', {text:label}), el('dd', {}, value))));
}

// `run` lets the phone dialog close before an action opens its own dialog.
function actions(group, run = task => task()) {
  const open = state.sessions.has(group.id), access = control(group.id);
  const reason = open && !access.can ? REASONS[access.label] || '' : '';
  return el('div', {class:'process-detail-actions'},
    el('button', {class:'btn', type:'button', disabled:!open, dataset:{focus:'detail-open'}, onclick:event => run(() => showTerminal(group.id), event)}, icon('open'), el('span', {text:'Open terminal'})),
    el('button', {class:'btn', type:'button', 'aria-disabled':String(!open || !access.can), 'aria-describedby':reason ? 'process-interrupt-reason' : null, dataset:{focus:'detail-interrupt'},
      onclick:event => { if (open && control(group.id).can) run(() => interrupt(group.id), event); }}, icon('stop'), el('span', {text:'Interrupt terminal'})),
    el('button', {class:'btn danger', type:'button', disabled:!open, dataset:{focus:'detail-close'}, onclick:event => run(() => closeTerminals([group.id]), event)}, icon('square-x'), el('span', {text:'Close terminal'})),
    reason ? el('p', {class:'help', id:'process-interrupt-reason', text:reason}) : null);
}

function inspector(found) {
  const current = found || view.last;
  if (!current) return null;
  const {group, process} = current;
  return el('aside', {class:'process-inspector', 'aria-labelledby':'process-detail-title', onkeydown:event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDetails(); } }},
    el('header', {class:'process-inspector-head'},
      el('h2', {id:'process-detail-title', class:'mono', tabindex:'-1', dataset:{focus:'detail-title'}, text:process.name}),
      el('button', {class:'icon-btn ghost', type:'button', 'aria-label':'Close process details', title:'Close details', dataset:{focus:'detail-x'}, onclick:closeDetails}, icon('x'))),
    found ? null : el('div', {class:'process-exited', role:'status'}, el('b', {text:'This process has exited.'}), el('p', {text:'Details below are from the last update.'})),
    facts(group, process), found ? actions(group) : null);
}

// Rebuilds only on change and puts keyboard focus back on the same control,
// or on the panel title when that control is gone (for example, after exit).
function update(container, key, build) {
  if (container.querySelector('[aria-expanded="true"]')) return; // Rebuild after the open row menu closes.
  const focused = container.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  if (!patch(container, key, build) || !focused) return;
  (container.querySelector(`[data-focus="${CSS.escape(focused)}"]`) || container.querySelector('[data-focus="detail-title"]') || view.nodes.search).focus({preventScroll:true});
}

function paint() {
  const nodes = view.nodes;
  if (!nodes) return;
  const groups = model(), query = view.query.trim();
  const total = groups.reduce((sum, group) => sum + group.total, 0), shown = groups.reduce((sum, group) => sum + group.visible.length, 0);
  nodes.summary.textContent = !view.data || !groups.length ? '' : query ? `${shown} of ${plural(total, 'process', 'processes')}` : `${plural(total, 'process', 'processes')} in ${plural(groups.length, 'terminal')}`;
  nodes.refresh.setAttribute('aria-busy', String(Boolean(view.request)));
  nodes.alert.hidden = !(view.error && view.data);
  nodes.alertText.textContent = view.error && view.data ? `Could not refresh: ${view.error} Showing the list from ${clock(view.data.at)}.` : '';
  const found = view.selected ? find(groups, view.selected) : null;
  if (found) view.last = found;
  const inspecting = Boolean(view.selected && wide.matches && (found || view.last));
  nodes.layout.dataset.inspecting = String(inspecting);
  const strip = group => [group.id, group.name, group.workspace, group.program, group.access.label, group.total, group.truncated, group.problem, group.visible];
  update(nodes.main, JSON.stringify([Boolean(view.data), view.error && !view.data, query, view.selected, wide.matches, groups.map(strip)]), () => main(groups, shown));
  update(nodes.inspector, inspecting ? JSON.stringify([view.selected, Boolean(found), found && [strip(found.group), found.process], state.sessions.has(view.last?.group.id), control(view.last?.group.id).label]) : '', () => inspecting ? inspector(found) : null);
  nodes.inspector.hidden = !inspecting;
}

function inspect(key) {
  const found = find(model(), key);
  if (!found) return;
  view.selected = key;
  view.last = found;
  paint();
  if (wide.matches) { $('process-detail-title')?.focus({preventScroll:true}); return; }
  // Phones show the same details in a dialog that closes before acting.
  const {group, process} = found;
  let chosen = null;
  const run = (task, event) => { chosen = task; event.currentTarget.closest('dialog')?.close(); };
  dialogs.show({title:process.name, description:`Process ${process.pid} in ${group.name}`, body:[facts(group, process), actions(group, run)], action:null, cancelLabel:'Done', className:'process-dialog'})
    .then(() => {
      if (view.selected === key) { view.selected = null; view.last = null; paint(); }
      chosen?.();
    });
}

function closeDetails() {
  const key = view.selected;
  view.selected = null;
  view.last = null;
  paint();
  (view.nodes.main.querySelector(`[data-focus="${CSS.escape(`name:${key}`)}"]`) || view.nodes.search).focus();
}

function build() {
  const search = el('input', {class:'field', id:'process-search', type:'search', placeholder:'Search processes, PIDs or terminals', autocomplete:'off', spellcheck:'false', 'aria-label':'Search processes',
    oninput:() => { view.query = search.value; paint(); }});
  const refresh = el('button', {class:'btn ghost', type:'button', onclick:() => load()}, icon('refresh'), el('span', {text:'Refresh'}));
  const alertText = el('span');
  const alert = el('div', {class:'process-alert', role:'alert', hidden:true}, icon('warning'), alertText, el('button', {class:'btn sm', type:'button', text:'Retry', onclick:() => load()}));
  const summary = el('p', {class:'process-summary', role:'status'});
  const main = el('div', {class:'process-main'}), inspector = el('div', {class:'process-inspector-slot', hidden:true});
  const layout = el('div', {class:'process-layout'}, main, inspector);
  $('processes-actions').replaceChildren(refresh);
  $('processes-content').replaceChildren(el('div', {class:'process-root'},
    el('div', {class:'process-tools'}, el('div', {class:'search-field'}, icon('search'), search), summary), alert, layout,
    el('p', {class:'process-footnote', text:'Only processes Webterminal started, updated every 2 seconds while this page is open. Interrupt sends Ctrl+C to the terminal; closing a terminal stops all of its processes.'})));
  view.nodes = {search, refresh, alert, alertText, summary, main, inspector, layout};
}

export function show() {
  if (!view.nodes) build();
  load();
}

export function render() { paint(); }
