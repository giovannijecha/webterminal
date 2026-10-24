// The sidebar: server menu, search, views, one row per workspace and the
// server status footer.
import {$, avatar, el, icon, plural, uptime} from './dom.js';
import {PANE_LIMIT, SESSION_LIMIT, failed, failedSessions, go, state, terminalStatus, workspaceById, workspaceIndex, workspaceLabel} from './model.js';
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

// Keep each workspace node across count, status and label changes so a menu,
// keyboard focus or an active drag remains attached to its workspace.
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
        onclick:event => menu.toggle(event.currentTarget, workspaceMenu(id), {label:`${workspaceLabel(workspaceById(id))} options`})}, icon('ellipsis'))));
}
function renderRows() {
  const wanted = new Set(state.workspaces.map(workspace => workspace.id));
  const focused = projects.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
  const focusedIndex = focused ? [...projects.children].findIndex(project => project.contains(document.activeElement)) : -1;
  for (const project of [...projects.children]) {
    if (wanted.has(project.dataset.workspace)) continue;
    if (menu.anchor && project.contains(menu.anchor)) menu.close(false);
    project.remove();
  }
  for (const [index, workspace] of state.workspaces.entries()) {
    const project = [...projects.children].find(node => node.dataset.workspace === workspace.id) || row(workspace);
    const label = workspaceLabel(workspace), count = workspace.sessions.length;
    const failures = workspace.sessions.filter(id => failed(state.sessions.get(id))).length;
    const capacity = `${count} of ${PANE_LIMIT} terminals${failures ? `, ${failures} failed` : ''}`;
    const button = project.querySelector('.navigation-item'), more = project.querySelector('.navigation-more');
    const name = project.querySelector('.navigation-name'), avatarNode = project.querySelector('.avatar');
    if (name.textContent !== label) name.textContent = label;
    const nextAvatar = avatar(workspaceIndex(workspace), label);
    if (avatarNode.textContent !== nextAvatar.textContent || avatarNode.dataset.family !== nextAvatar.dataset.family) avatarNode.replaceWith(nextAvatar);
    const countNode = project.querySelector('.navigation-capacity');
    if (countNode.textContent !== `${count}/${PANE_LIMIT}` || Boolean(countNode.querySelector('.dot')) !== Boolean(failures))
      countNode.replaceChildren(...(failures ? [el('span', {class:'dot', 'data-tone':'red', title:plural(failures, 'failed terminal')})] : []), `${count}/${PANE_LIMIT}`);
    else if (failures) countNode.querySelector('.dot').title = plural(failures, 'failed terminal');
    button.setAttribute('aria-label', `${label}, ${capacity}`);
    more.setAttribute('aria-label', `${label} options`);
    more.title = `${label} options`;
    if (projects.children[index] !== project) projects.insertBefore(project, projects.children[index] || null);
  }
  if (focused && !projects.contains(document.activeElement)) {
    const same = [...projects.querySelectorAll('[data-focus]')].find(node => node.dataset.focus === focused);
    (same || projects.children[Math.min(focusedIndex, projects.children.length - 1)]?.querySelector('.navigation-item') || $('new-workspace')).focus({preventScroll:true});
  }
  const shown = state.page === 'workspace';
  for (const project of projects.querySelectorAll('[data-workspace]')) setCurrent(project.querySelector('.navigation-item'), shown && project.dataset.workspace === state.selected ? 'page' : null);
}
function setCurrent(node, value) {
  if (!node || node.getAttribute('aria-current') === value) return;
  if (value) node.setAttribute('aria-current', value); else node.removeAttribute('aria-current');
}
function setText(node, value) { if (node.textContent !== value) node.textContent = value; }

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
  setText($('connection-status'), now.label);
  setText($('uptime'), now.detail);
  setText($('brand-sub'), state.hello?.port ? `127.0.0.1:${state.hello.port}` : 'Local terminal server');
  // Segments: failed, running, then exited terminals.
  const total = state.sessions.size, failures = failedSessions().length;
  const active = [...state.sessions.keys()].filter(id => terminalStatus(id).key === 'active').length;
  const widths = [failures, active, Math.max(0, total - failures - active)];
  [...$('meter').children].forEach((segment, index) => { segment.style.width = `${(widths[index] / SESSION_LIMIT) * 100}%`; });
  $('meter').setAttribute('aria-label', `${total} of ${SESSION_LIMIT} terminals in use`);
  setText($('meter-count'), String(total));
  setText($('meter-limit'), String(SESSION_LIMIT));
  setText($('meter-workspaces'), plural(state.workspaces.length, 'workspace'));
}

export function renderSidebar() {
  renderViews();
  renderRows();
  renderServer();
}
// Uptime advances without any server message.
setInterval(() => { if (state.connected) renderServer(); }, 30000);
