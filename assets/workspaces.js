import {editInline, folderName, icon, sessionName, stateClass} from './common.js';
import {SESSION_DRAG} from './pane.js';

export const PANE_LIMIT = 4;
export const WORKSPACE_LIMIT = 16;
const WORKSPACE_DRAG = 'application/x-webterminal-workspace';

// A custom name wins; otherwise the first terminal's folder, then the ID.
export function workspaceLabel(workspace, sessions) {
  if (!workspace) return 'Workspace';
  if (workspace.name) return workspace.name;
  const first = sessions.get(workspace.sessions[0]);
  return first ? folderName(first.cwd) || 'Workspace' : `Workspace ${workspace.id.replace(/^w/, '')}`;
}

// Workspaces render as browser-style tabs. Server state is authoritative;
// the view only reports intents through `actions`.
export class WorkspaceTabs {
  constructor(root, actions) {
    this.root = root;
    this.actions = actions;
    this.list = [];
    this.sessions = new Map();
    this.selected = null;
    this.signature = '';
    root.addEventListener('keydown', event => this.keydown(event));
  }

  render(list, sessions, selected) {
    Object.assign(this, {list, sessions, selected});
    if (this.root.querySelector('.inline-edit')) return;
    const signature = JSON.stringify([selected, list, list.flatMap(w => w.sessions.map(id => sessions.get(id)?.cwd))]);
    if (signature === this.signature) return;
    this.signature = signature;
    const focused = this.root.contains(document.activeElement);
    this.root.replaceChildren(...list.map(workspace => this.tab(workspace)));
    this.root.querySelector('.workspace-tab.active')?.scrollIntoView({block:'nearest', inline:'nearest'});
    if (focused) this.root.querySelector('.workspace-tab.active')?.focus();
  }

  tab(workspace) {
    const active = workspace.id === this.selected, label = workspaceLabel(workspace, this.sessions);
    const tab = document.createElement('div');
    tab.className = `workspace-tab${active ? ' active' : ''}`;
    tab.id = `workspace-tab-${workspace.id}`;
    tab.dataset.workspace = workspace.id;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(active));
    tab.setAttribute('aria-controls', 'workspace');
    tab.tabIndex = active ? 0 : -1;
    tab.draggable = true;
    const count = workspace.sessions.length;
    tab.title = `${label}\n${count} of ${PANE_LIMIT} terminals · Double-click to rename`;
    const name = document.createElement('span');
    name.className = 'tab-label';
    name.textContent = label;
    const badge = document.createElement('span');
    badge.className = 'tab-count';
    badge.textContent = String(count);
    badge.hidden = !count;
    badge.setAttribute('aria-label', `${count} terminal${count === 1 ? '' : 's'}`);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.tabIndex = -1;
    close.title = 'Close workspace';
    close.setAttribute('aria-label', `Close workspace ${label}`);
    close.append(icon('close'));
    // Closing the only empty workspace would just replace it.
    close.hidden = this.list.length === 1 && !count;
    close.addEventListener('click', event => { event.stopPropagation(); this.actions.close(workspace.id); });
    tab.append(name, badge, close);
    tab.addEventListener('click', () => this.actions.select(workspace.id));
    tab.addEventListener('dblclick', event => { if (!event.target.closest('button')) this.edit(workspace.id); });
    tab.addEventListener('auxclick', event => { if (event.button === 1) { event.preventDefault(); this.actions.close(workspace.id); } });
    this.dragging(tab, workspace.id);
    return tab;
  }

  dragging(tab, id) {
    tab.addEventListener('dragstart', event => { event.dataTransfer.setData(WORKSPACE_DRAG, id); event.dataTransfer.effectAllowed = 'move'; });
    tab.addEventListener('dragover', event => {
      const types = event.dataTransfer.types;
      if (!types.includes(WORKSPACE_DRAG) && !types.includes(SESSION_DRAG)) return;
      event.preventDefault();
      const after = types.includes(WORKSPACE_DRAG) && event.offsetX > tab.clientWidth / 2;
      tab.classList.toggle('drop-before', types.includes(WORKSPACE_DRAG) && !after);
      tab.classList.toggle('drop-after', after);
      tab.classList.toggle('drop-target', types.includes(SESSION_DRAG));
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-before', 'drop-after', 'drop-target'));
    tab.addEventListener('drop', event => {
      const after = tab.classList.contains('drop-after');
      tab.classList.remove('drop-before', 'drop-after', 'drop-target');
      const session = event.dataTransfer.getData(SESSION_DRAG), dragged = event.dataTransfer.getData(WORKSPACE_DRAG);
      event.preventDefault();
      if (session) { this.actions.move(session, id); return; }
      if (!dragged || dragged === id) return;
      const order = this.list.map(workspace => workspace.id).filter(item => item !== dragged);
      order.splice(order.indexOf(id) + (after ? 1 : 0), 0, dragged);
      this.actions.reorder(order);
    });
  }

  edit(id) {
    const workspace = this.list.find(item => item.id === id);
    const label = this.root.querySelector(`[data-workspace="${CSS.escape(id)}"] .tab-label`);
    if (!workspace || !label) return;
    editInline(label, {value:workspaceLabel(workspace, this.sessions), accessibleName:'Workspace name', save:name => this.actions.rename(id, name), closed:() => { this.signature = ''; this.render(this.list, this.sessions, this.selected); }});
  }

  keydown(event) {
    const tab = event.target.closest?.('.workspace-tab');
    if (!tab || event.target !== tab) return;
    const ids = this.list.map(workspace => workspace.id), index = ids.indexOf(tab.dataset.workspace);
    let next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % ids.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + ids.length) % ids.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = ids.length - 1;
    else if (event.key === 'F2') { event.preventDefault(); this.edit(ids[index]); return; }
    else if (event.key === 'Delete') { event.preventDefault(); this.actions.close(ids[index]); return; }
    if (next === null) return;
    event.preventDefault();
    this.actions.select(ids[next]);
    this.root.querySelector('.workspace-tab.active')?.focus();
  }
}

// On narrow screens one pane is visible; this lists the workspace's terminals.
export function renderSwitcher(root, ids, sessions, focused, select) {
  const signature = JSON.stringify([focused, ids.map(id => [id, sessionName(sessions.get(id)), stateClass(sessions.get(id))])]);
  if (root.dataset.signature === signature) return;
  root.dataset.signature = signature;
  root.hidden = ids.length < 2;
  root.replaceChildren(...ids.map((id, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `switcher-item${id === focused ? ' active' : ''}`;
    button.setAttribute('aria-pressed', String(id === focused));
    const dot = document.createElement('span');
    dot.className = `pane-dot${stateClass(sessions.get(id))}`;
    const label = document.createElement('span');
    label.textContent = `${index + 1} · ${sessionName(sessions.get(id))}`;
    button.append(dot, label);
    button.addEventListener('click', () => select(id));
    return button;
  }));
}
