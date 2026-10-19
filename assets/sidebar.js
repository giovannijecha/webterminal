// The sidebar: Views, the workspace tree, server status and, on narrow
// screens, the navigation drawer.
import {$, counter, el, icon, plural, storage, uptime} from './dom.js';
import {SESSION_LIMIT, changed, failedSessions, focusedId, go, sessionShell, showTerminal, state, terminalName, terminalStatus, workspaceById, workspaceLabel} from './model.js';
import {menu} from './ui.js';
import {createWorkspace, moveTerminal, orderWorkspaces, stopServer, workspaceMenu} from './actions.js';
import {SESSION_DRAG} from './pane.js';

const WORKSPACE_DRAG = 'application/x-webterminal-workspace';
const narrow = matchMedia('(max-width:900px)');
const hooks = {shortcuts() {}, palette() {}};
const view = storage('session');
const collapsed = new Set((() => { try { return JSON.parse(view.get('webterminal.collapsed') || '[]'); } catch { return []; } })());
const sidebar = $('sidebar'), backdrop = $('backdrop'), projects = $('navigation-projects');
let drawerOpener = null;

export function configureSidebar(next) { Object.assign(hooks, next); }

// Drawer (≤900): a modal dialog with focus held inside until it closes.
export function openDrawer(opener = document.activeElement) {
  if (!narrow.matches) return;
  drawerOpener = opener;
  sidebar.classList.add('open');
  backdrop.classList.add('open');
  sidebar.setAttribute('role', 'dialog');
  sidebar.setAttribute('aria-modal', 'true');
  $('main').inert = true;
  $('navigation-close').focus();
}
export function closeDrawer(returnFocus = true) {
  if (!sidebar.classList.contains('open')) return;
  sidebar.classList.remove('open');
  backdrop.classList.remove('open');
  sidebar.removeAttribute('role');
  sidebar.removeAttribute('aria-modal');
  $('main').inert = false;
  if (returnFocus) (drawerOpener?.isConnected ? drawerOpener : document.querySelector('.page:not([hidden]) .menu-btn'))?.focus();
  drawerOpener = null;
}
function layout() {
  // Narrow screens list workspaces first; the DOM order matches the visual order.
  const nav = $('sb-nav'), workspaces = $('navigation-workspaces');
  if (narrow.matches) nav.prepend(workspaces); else nav.append(workspaces);
  if (!narrow.matches) closeDrawer(false);
}
narrow.addEventListener('change', layout);
layout();
$('navigation-close').addEventListener('click', () => closeDrawer());
backdrop.addEventListener('click', () => closeDrawer());
sidebar.addEventListener('keydown', event => {
  if (!sidebar.classList.contains('open')) return;
  if (event.key === 'Escape' && !menu.open) { event.preventDefault(); closeDrawer(); }
  else if (event.key === 'Tab') {
    const items = [...sidebar.querySelectorAll('button:not([disabled]),[tabindex="0"]')].filter(item => item.offsetParent);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
});
document.addEventListener('click', event => { const button = event.target.closest('.menu-btn'); if (button) openDrawer(button); });

function navigate(page, target = null) { closeDrawer(false); go(page, target); }
for (const button of document.querySelectorAll('#navigation-views [data-page]')) button.addEventListener('click', () => navigate(button.dataset.page));
$('search-btn').addEventListener('click', () => { closeDrawer(false); hooks.palette(); });
$('new-workspace').addEventListener('click', async () => { closeDrawer(false); await createWorkspace(); });
$('server-options').addEventListener('click', event => menu.toggle(event.currentTarget, [
  {head:'Webterminal'},
  {label:'Keyboard shortcuts', icon:'keyboard', action:() => hooks.shortcuts()},
  {separator:true},
  {label:'Stop server…', icon:'power', danger:true, disabled:!state.connected, action:stopServer},
], {label:'Server options'}));

function toggle(id) {
  if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
  view.set('webterminal.collapsed', JSON.stringify([...collapsed]));
  changed('sessions');
}
function selectWorkspace(id) {
  state.selected = id;
  navigate('workspace');
}

// The tree is rebuilt only when its content changes; selection alone updates
// `aria-current` in place, so rows keep their focus, scroll position, open
// menus and drags.
function treeKey() {
  return JSON.stringify([[...collapsed], state.workspaces.map(workspace => [workspace.id, workspaceLabel(workspace),
    workspace.sessions.map(id => [id, terminalName(id), terminalStatus(id).label, sessionShell(state.sessions.get(id))])])]);
}
function tree() {
  return state.workspaces.map(workspace => {
    const id = workspace.id, label = workspaceLabel(workspace), count = workspace.sessions.length, expanded = !collapsed.has(id);
    const terminals = el('ul', {class:'navigation-terminals', id:`navigation-terminals-${id}`, hidden:!expanded},
      count ? workspace.sessions.map(session => {
        const status = terminalStatus(session), name = terminalName(session);
        return el('li', {}, el('button', {
          class:'navigation-item', type:'button', draggable:'true',
          title:`${sessionShell(state.sessions.get(session))} · ${status.label}`, 'aria-label':`${name}, ${status.label}`,
          dataset:{focus:`terminal:${session}`, session}, onclick:() => { closeDrawer(false); showTerminal(session); },
        }, el('span', {class:'status-dot', 'data-tone':status.tone}), el('span', {class:'navigation-name', text:name})));
      }) : el('li', {class:'navigation-empty', text:'No terminals yet'}));
    return el('li', {class:'navigation-project', dataset:{workspace:id}},
      el('div', {class:'navigation-workspace-row', draggable:'true'},
        el('button', {class:'navigation-disclosure', type:'button', 'aria-expanded':String(expanded), 'aria-controls':terminals.id, 'aria-label':`${expanded ? 'Collapse' : 'Expand'} ${label}`, dataset:{focus:`disclosure:${id}`}, onclick:() => toggle(id)}, icon('chevron-right')),
        el('button', {class:'navigation-item', type:'button', 'aria-label':`${label}, ${plural(count, 'terminal')}`, title:'Alt+↑ or Alt+↓ reorders', dataset:{focus:`workspace:${id}`}, onclick:() => selectWorkspace(id)},
          el('span', {class:'navigation-name', text:label}), counter(count, 'neutral', plural(count, 'terminal'))),
        el('button', {class:'icon-btn ghost sm navigation-more', type:'button', 'aria-haspopup':'menu', 'aria-label':`${label} options`, title:`${label} options`, dataset:{focus:`more:${id}`},
          onclick:event => menu.toggle(event.currentTarget, workspaceMenu(id), {label:`${label} options`})}, icon('ellipsis'))),
      terminals);
  });
}
function renderTree() {
  const key = treeKey();
  if (projects.dataset.key !== key) {
    const focus = projects.contains(document.activeElement) ? document.activeElement.dataset.focus : null;
    projects.dataset.key = key;
    projects.replaceChildren(...tree());
    if (focus) projects.querySelector(`[data-focus="${CSS.escape(focus)}"]`)?.focus();
  }
  markSelection();
}
function markSelection() {
  const shown = state.page === 'workspace', focused = focusedId(workspaceById(state.selected));
  for (const project of projects.querySelectorAll('[data-workspace]')) {
    const current = shown && project.dataset.workspace === state.selected;
    setCurrent(project.querySelector('.navigation-workspace-row .navigation-item'), current ? 'location' : null);
    for (const item of project.querySelectorAll('[data-session]')) setCurrent(item, current && item.dataset.session === focused ? 'true' : null);
  }
}
function setCurrent(node, value) {
  if (!node || node.getAttribute('aria-current') === value) return;
  if (value) node.setAttribute('aria-current', value); else node.removeAttribute('aria-current');
}

// Drag a terminal onto a workspace or terminal row, or a workspace to reorder.
let dragged = null;
function clearDrop() { for (const node of projects.querySelectorAll('.drop-target,.drop-before,.drop-after')) node.classList.remove('drop-target', 'drop-before', 'drop-after'); }
projects.addEventListener('dragstart', event => {
  const terminal = event.target.closest?.('[data-session]'), row = event.target.closest?.('.navigation-workspace-row');
  if (terminal) { event.dataTransfer.setData(SESSION_DRAG, terminal.dataset.session); dragged = null; }
  else if (row) { dragged = row.closest('[data-workspace]').dataset.workspace; event.dataTransfer.setData(WORKSPACE_DRAG, dragged); }
  else return;
  event.dataTransfer.effectAllowed = 'move';
});
projects.addEventListener('dragover', event => {
  const types = event.dataTransfer.types, project = event.target.closest?.('[data-workspace]');
  if (!project) return;
  clearDrop();
  if (types.includes(SESSION_DRAG)) {
    event.preventDefault();
    (event.target.closest('[data-session]') || project.querySelector('.navigation-workspace-row')).classList.add('drop-target');
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
  if (session) {
    const row = event.target.closest('[data-session]'), workspace = workspaceById(target);
    moveTerminal(session, target, row ? workspace.sessions.indexOf(row.dataset.session) : undefined);
  } else if (dragged && dragged !== target) {
    const ids = state.workspaces.map(workspace => workspace.id).filter(id => id !== dragged);
    ids.splice(ids.indexOf(target) + (before ? 0 : 1), 0, dragged);
    orderWorkspaces(ids);
  }
  dragged = null;
});
document.addEventListener('dragend', clearDrop);
projects.addEventListener('keydown', event => {
  const row = event.target.closest?.('.navigation-workspace-row .navigation-item');
  if (!row || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const id = row.closest('[data-workspace]').dataset.workspace, ids = state.workspaces.map(workspace => workspace.id);
  const index = ids.indexOf(id), next = index + (event.key === 'ArrowUp' ? -1 : 1);
  if (next < 0 || next >= ids.length) return;
  ids.splice(index, 1);
  ids.splice(next, 0, id);
  orderWorkspaces(ids);
});

function setCounter(id, count, label) {
  const node = $(id);
  node.hidden = !count;
  node.textContent = String(count);
  node.title = label;
  node.setAttribute('aria-label', label);
}
function renderViews() {
  const total = state.sessions.size;
  setCounter('count-terminals', total, plural(total, 'terminal'));
  for (const button of document.querySelectorAll('#navigation-views [data-page]')) setCurrent(button, button.dataset.page === state.page ? 'page' : null);
}
function renderServer() {
  const online = state.connected, stopped = state.stopping && !online;
  $('server-tile').classList.toggle('green', online);
  $('connection-badge').dataset.tone = stopped ? 'red' : 'neutral';
  $('connection-status').textContent = online ? 'Connected' : stopped ? 'Disconnected' : state.hello ? 'Reconnecting…' : 'Connecting…';
  $('uptime').textContent = online && state.hello?.started ? uptime(Date.now() - state.hello.started) : stopped ? 'Server stopped' : 'Waiting for the local server';
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
  renderTree();
  renderServer();
}
// Uptime advances without any server message.
setInterval(() => { if (state.connected) renderServer(); }, 30000);
