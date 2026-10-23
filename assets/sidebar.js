// The sidebar: server menu, search, views, one row per workspace and the
// server status footer.
import {$, avatar, el, icon, plural, uptime} from './dom.js';
import {PANE_LIMIT, SESSION_LIMIT, failed, failedSessions, go, state, terminalStatus, workspaceIndex, workspaceLabel} from './model.js';
import {menu} from './ui.js';
import {createWorkspace, moveTerminal, orderWorkspaces, stopServer, workspaceMenu} from './actions.js';
import {SESSION_DRAG} from './pane.js';

const WORKSPACE_DRAG = 'application/x-webterminal-workspace';
const hooks = {shortcuts() {}, palette() {}};
const projects = $('navigation-projects');

export function configureSidebar(next) { Object.assign(hooks, next); }

// Connection as the footer and the server menu report it.
function connection() {
  const online = state.connected, stopped = state.stopping && !online;
  const label = online ? 'Connected' : stopped ? 'Disconnected' : state.hello ? 'Reconnecting…' : 'Connecting…';
  const detail = online && state.hello?.started ? uptime(Date.now() - state.hello.started) : stopped ? 'Server stopped' : 'Waiting for the local server';
  return {label, detail, tone:online ? 'green' : stopped ? 'red' : 'amber'};
}
function serverMenu() {
  const now = connection(), port = state.hello?.port;
  return [
    {head:now.label, detail:[port ? `127.0.0.1:${port}` : '', now.detail].filter(Boolean).join(' · '), tone:now.tone},
    {label:'Keyboard shortcuts', hint:'?', action:() => hooks.shortcuts()},
    {separator:true},
    {label:'Stop server…', danger:true, disabled:!state.connected, action:stopServer},
  ];
}

for (const button of document.querySelectorAll('#sidebar [data-page]')) button.addEventListener('click', () => go(button.dataset.page));
$('search-btn').addEventListener('click', () => hooks.palette());
$('new-workspace').addEventListener('click', () => createWorkspace());
$('server-options').addEventListener('click', event => menu.toggle(event.currentTarget, serverMenu(), {label:'Server options'}));

function selectWorkspace(id) {
  state.selected = id;
  go('workspace');
}

// Rows are rebuilt only when their content changes; selection alone updates
// `aria-current` in place, so rows keep their focus, open menus and drags.
function rowsKey() {
  return JSON.stringify(state.workspaces.map(workspace => [workspace.id, workspaceLabel(workspace), workspaceIndex(workspace),
    workspace.sessions.map(id => terminalStatus(id).key)]));
}
function row(workspace) {
  const id = workspace.id, label = workspaceLabel(workspace), count = workspace.sessions.length;
  const failures = workspace.sessions.filter(session => failed(state.sessions.get(session))).length;
  const capacity = `${count} of ${PANE_LIMIT} terminals${failures ? `, ${failures} failed` : ''}`;
  return el('li', {class:'navigation-project', dataset:{workspace:id}},
    el('div', {class:'navigation-workspace-row', draggable:'true'},
      el('button', {class:'navigation-item', type:'button', 'aria-label':`${label}, ${capacity}`, title:'Alt+↑ or Alt+↓ reorders', dataset:{focus:`workspace:${id}`}, onclick:() => selectWorkspace(id)},
        avatar(workspaceIndex(workspace), label), el('span', {class:'navigation-name', text:label}),
        el('span', {class:'navigation-capacity', 'aria-hidden':'true'}, failures ? el('span', {class:'dot', 'data-tone':'red', title:plural(failures, 'failed terminal')}) : null, `${count}/${PANE_LIMIT}`)),
      el('button', {class:'icon-btn ghost sm navigation-more', type:'button', 'aria-haspopup':'menu', 'aria-expanded':'false', 'aria-label':`${label} options`, title:`${label} options`, dataset:{focus:`more:${id}`},
        onclick:event => menu.toggle(event.currentTarget, workspaceMenu(id), {label:`${label} options`})}, icon('ellipsis'))));
}
function renderRows() {
  const key = rowsKey();
  if (projects.dataset.key !== key) {
    const focus = projects.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    projects.dataset.key = key;
    projects.replaceChildren(...state.workspaces.map(row));
    if (focus) projects.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus();
  }
  const shown = state.page === 'workspace';
  for (const project of projects.querySelectorAll('[data-workspace]')) setCurrent(project.querySelector('.navigation-item'), shown && project.dataset.workspace === state.selected ? 'page' : null);
}
function setCurrent(node, value) {
  if (!node || node.getAttribute('aria-current') === value) return;
  if (value) node.setAttribute('aria-current', value); else node.removeAttribute('aria-current');
}

// Drag a terminal (by its pane header) onto a workspace row, or a workspace
// row to reorder.
let dragged = null;
function clearDrop() { for (const node of projects.querySelectorAll('.drop-target,.drop-before,.drop-after')) node.classList.remove('drop-target', 'drop-before', 'drop-after'); }
projects.addEventListener('dragstart', event => {
  const source = event.target.closest?.('.navigation-workspace-row');
  if (!source) return;
  dragged = source.closest('[data-workspace]').dataset.workspace;
  event.dataTransfer.setData(WORKSPACE_DRAG, dragged);
  event.dataTransfer.effectAllowed = 'move';
});
projects.addEventListener('dragover', event => {
  const types = event.dataTransfer.types, project = event.target.closest?.('[data-workspace]');
  if (!project) return;
  clearDrop();
  if (types.includes(SESSION_DRAG)) {
    event.preventDefault();
    project.querySelector('.navigation-workspace-row').classList.add('drop-target');
  } else if (types.includes(WORKSPACE_DRAG)) {
    event.preventDefault();
    const box = project.getBoundingClientRect();
    project.classList.add(event.clientY < box.top + box.height / 2 ? 'drop-before' : 'drop-after');
  }
});
projects.addEventListener('dragleave', event => { if (!projects.contains(event.relatedTarget)) clearDrop(); });
projects.addEventListener('drop', event => {
  const project = event.target.closest?.('[data-workspace]');
  const before = project?.classList.contains('drop-before');
  clearDrop();
  if (!project) return;
  const target = project.dataset.workspace, session = event.dataTransfer.getData(SESSION_DRAG);
  event.preventDefault();
  if (session) moveTerminal(session, target);
  else if (dragged && dragged !== target) {
    const ids = state.workspaces.map(workspace => workspace.id).filter(id => id !== dragged);
    ids.splice(ids.indexOf(target) + (before ? 0 : 1), 0, dragged);
    orderWorkspaces(ids);
  }
  dragged = null;
});
document.addEventListener('dragend', clearDrop);
projects.addEventListener('keydown', event => {
  const item = event.target.closest?.('.navigation-workspace-row .navigation-item');
  if (!item || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const id = item.closest('[data-workspace]').dataset.workspace, ids = state.workspaces.map(workspace => workspace.id);
  const index = ids.indexOf(id), next = index + (event.key === 'ArrowUp' ? -1 : 1);
  if (next < 0 || next >= ids.length) return;
  ids.splice(index, 1);
  ids.splice(next, 0, id);
  orderWorkspaces(ids);
});

function renderViews() {
  const total = state.sessions.size, count = $('count-terminals'), label = plural(total, 'terminal');
  count.hidden = !total;
  if (count.textContent !== String(total)) count.textContent = String(total);
  count.title = label;
  for (const button of document.querySelectorAll('#sidebar [data-page]')) setCurrent(button, button.dataset.page === state.page ? 'page' : null);
}
function renderServer() {
  const now = connection();
  $('connection-dot').dataset.tone = now.tone;
  $('connection-status').textContent = now.label;
  $('uptime').textContent = now.detail;
  $('brand-sub').textContent = state.hello?.port ? `127.0.0.1:${state.hello.port}` : 'Local terminal server';
  // Segments: failed, running, then exited terminals.
  const total = state.sessions.size, failures = failedSessions().length;
  const active = [...state.sessions.keys()].filter(id => terminalStatus(id).key === 'active').length;
  const widths = [failures, active, Math.max(0, total - failures - active)];
  [...$('meter').children].forEach((segment, index) => { segment.style.width = `${(widths[index] / SESSION_LIMIT) * 100}%`; });
  $('meter').setAttribute('aria-label', `${total} of ${SESSION_LIMIT} terminals in use`);
  $('meter-count').textContent = String(total);
  $('meter-workspaces').textContent = plural(state.workspaces.length, 'workspace');
}

export function renderSidebar() {
  renderViews();
  renderRows();
  renderServer();
}
// Uptime advances without any server message.
setInterval(() => { if (state.connected) renderServer(); }, 30000);
