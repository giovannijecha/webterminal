const $ = id => document.getElementById(id);

export function displayPath(path = '') {
  if (path.startsWith('\\\\?\\UNC\\')) return '\\\\' + path.slice(8);
  return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}

export function sessionName(session) {
  if (typeof session?.name === 'string' && session.name.trim()) return session.name.trim();
  const title = displayPath(session?.title || '');
  if (title && !/^(?:[a-z]:[\\/]|\\\\)/i.test(title)) return title;
  const path = title || displayPath(session?.cwd || '');
  return path.split(/[\\/]/).filter(Boolean).at(-1) || 'Terminal';
}

export function stateClass(session) {
  if (session.alive) return ' live';
  return Number.isInteger(session.exitCode) && session.exitCode !== 0 ? ' failed' : '';
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

export class Workbench {
  constructor({select, create, find, layout, actions}) {
    this.select = select;
    this.actions = actions;
    this.sessions = [];
    this.active = null;
    this.groups = [];
    this.focusedGroup = '1';
    this.view = null;
    this.signature = '';
    this.items = [];
    this.selected = 0;
    this.mobile = matchMedia('(max-width:760px)');
    this.layout = layout;
    for (const id of ['toggle-sidebar', 'activity-sessions']) $(id).addEventListener('click', () => this.toggleSidebar());
    for (const id of ['sidebar-new', 'title-new']) $(id).addEventListener('click', create);
    $('activity-find').addEventListener('click', find);
    for (const id of ['command-center', 'activity-commands']) $(id).addEventListener('click', () => this.showCommands());
    $('previous-session').addEventListener('click', () => this.neighbor(-1));
    $('next-session').addEventListener('click', () => this.neighbor(1));
    $('activity-info').addEventListener('click', () => {
      const visible = $('activity-sessions').getAttribute('aria-expanded') === 'true';
      if (!visible) this.toggleSidebar();
      $('session-details').open = true;
      $('session-details').querySelector('summary').focus();
    });
    $('command-close').addEventListener('click', () => $('command-dialog').close());
    $('command-input').addEventListener('input', () => this.renderCommands());
    $('command-input').addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        this.highlight(this.selected + (event.key === 'ArrowDown' ? 1 : -1));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        this.run(this.selected);
      }
    });
    this.mobile.addEventListener('change', () => {
      document.documentElement.classList.remove('sidebar-open');
      this.sidebarState();
      layout();
    });
    this.sidebarState();
  }

  sidebarState() {
    const classes = document.documentElement.classList;
    const visible = this.mobile.matches ? classes.contains('sidebar-open') : !classes.contains('sidebar-collapsed');
    classes.toggle('rail', this.mobile.matches || !visible);
    for (const id of ['toggle-sidebar', 'activity-sessions']) $(id).setAttribute('aria-expanded', String(visible));
    $('activity-sessions').classList.toggle('active', visible);
  }

  toggleSidebar() {
    document.documentElement.classList.toggle(this.mobile.matches ? 'sidebar-open' : 'sidebar-collapsed');
    this.sidebarState();
    this.layout();
  }

  update({sessions, active, cwd, shell, connected, fontSize, groups = [], focusedGroup = '1', view = null}) {
    this.sessions = [...sessions.values()];
    this.active = active;
    this.groups = groups;
    this.focusedGroup = focusedGroup;
    this.view = view;
    const current = sessions.get(active);
    const path = displayPath(current?.cwd || cwd);
    $('workspace-path').textContent = path;
    $('workspace-path').title = path;
    $('workspace-name').textContent = path.split(/[\\/]/).filter(Boolean).at(-1) || 'Webterminal';
    $('workspace-name').title = path;
    $('command-workspace').textContent = $('workspace-name').textContent;
    $('preferences-font').textContent = `${fontSize} px`;
    $('detail-session').textContent = current ? `${sessionName(current)} · ${current.id}` : 'No terminal selected';
    $('detail-directory').textContent = path;
    $('detail-shell').textContent = shell;
    $('detail-connection').textContent = connected ? 'Connected' : 'Reconnecting…';
    $('previous-session').disabled = this.sessions.length < 2;
    $('next-session').disabled = this.sessions.length < 2;
    $('session-count').textContent = this.sessions.length;
    $('sidebar-empty').hidden = Boolean(this.sessions.length);
    $('tabs-empty').hidden = Boolean(this.sessions.length);
    $('session-list').hidden = !this.sessions.length;
    $('status-session-count').textContent = `${this.sessions.length} terminal${this.sessions.length === 1 ? '' : 's'}`;
    $('connection-status').textContent = connected ? 'Connected' : 'Reconnecting…';
    $('connection-dot').classList.toggle('connected', connected);
    $('statusbar').classList.toggle('disconnected', !connected);
    $('status-shell').textContent = shell;
    $('status-shell').title = shell;
    $('status-font').textContent = `${fontSize} px`;
    $('activity-find').disabled = !active;
    const signature = JSON.stringify([active, focusedGroup, groups, view,
      this.sessions.map(s => [s.id, s.name, s.title, s.cwd, s.alive, s.exitCode, s.controller])]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.renderSessions();
      if ($('command-dialog').open) this.renderCommands();
    }
  }

  renderSessions() {
    const fragment = document.createDocumentFragment();
    const rows = new Map(this.sessions.map(session => [session.id, session]));
    if (this.groups.length > 1) {
      const containers = new Map();
      const assigned = new Set();
      for (const group of this.groups) {
        const container = document.createElement('div');
        container.className = `session-group${group.id === this.focusedGroup ? ' focused' : ''}`;
        container.dataset.group = group.id;
        container.setAttribute('role', 'group');
        container.setAttribute('aria-label', group.label);
        const heading = document.createElement('div');
        heading.className = 'session-group-heading';
        heading.textContent = group.label;
        container.append(heading);
        containers.set(group.id, container);
        fragment.append(container);
        for (const id of group.sessions || []) {
          const session = rows.get(id);
          if (session && !assigned.has(id)) {
            container.append(this.sessionRow(session));
            assigned.add(id);
          }
        }
      }
      const primary = containers.get('1') || containers.values().next().value;
      for (const session of this.sessions) {
        if (!assigned.has(session.id)) primary.append(this.sessionRow(session));
      }
    } else {
      for (const session of this.sessions) fragment.append(this.sessionRow(session));
    }
    $('session-list').replaceChildren(fragment);
  }

  sessionRow(session) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `session-entry${session.id === this.active ? ' active' : ''}${session.alive ? ' running' : ' exited'}`;
    row.dataset.session = session.id;
    row.setAttribute('aria-current', String(session.id === this.active));
    const statusText = session.alive
      ? `Running${this.view ? ` · ${session.controller === this.view ? 'Controlling' : 'Observing'}` : ''}`
      : `Exited (${session.exitCode ?? '?'})`;
    row.title = `${sessionName(session)}\n${displayPath(session.cwd)}\n${statusText} · ${session.id}`;
    row.setAttribute('aria-label', `${sessionName(session)}, ${statusText}, ${displayPath(session.cwd)}, session ${session.id}`);
    const details = document.createElement('span');
    details.className = 'session-details';
    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = sessionName(session);
    const path = document.createElement('span');
    path.className = 'session-directory';
    const folder = displayPath(session.cwd).split(/[\\/]/).filter(Boolean).at(-1) || displayPath(session.cwd);
    path.textContent = session.alive ? folder : `${folder} · ${statusText}`;
    const status = document.createElement('span');
    status.className = `session-state${stateClass(session)}`;
    status.setAttribute('aria-label', statusText);
    details.append(name, path);
    row.append(status, details);
    row.addEventListener('click', () => {
      if (this.mobile.matches) {
        document.documentElement.classList.remove('sidebar-open');
        this.sidebarState();
      }
      this.select(session.id);
    });
    return row;
  }

  showCommands() {
    $('command-input').value = '';
    this.renderCommands();
    $('command-dialog').showModal();
    $('command-input').focus();
  }

  neighbor(direction) {
    if (this.sessions.length < 2) return;
    const index = this.sessions.findIndex(session => session.id === this.active);
    this.select(this.sessions[(index + direction + this.sessions.length) % this.sessions.length].id);
  }

  renderCommands() {
    const query = $('command-input').value.trim().toLocaleLowerCase();
    const sessions = this.sessions.map(session => ({
      label: sessionName(session), detail: `${session.id} · ${displayPath(session.cwd)}`,
      kind: 'Session', icon: 'terminal', run: () => this.select(session.id),
    }));
    this.items = [...sessions, ...this.actions().filter(action => !action.disabled)]
      .filter(item => `${item.label} ${item.detail || ''}`.toLocaleLowerCase().includes(query));
    const fragment = document.createDocumentFragment();
    this.items.forEach((item, index) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.id = `command-option-${index}`;
      row.className = 'command-option';
      row.tabIndex = -1;
      row.setAttribute('role', 'option');
      const details = document.createElement('span');
      details.className = 'command-details';
      const label = document.createElement('span');
      label.textContent = item.label;
      details.append(label);
      if (item.detail) {
        const detail = document.createElement('small');
        detail.textContent = item.detail;
        details.append(detail);
      }
      const kind = document.createElement('span');
      kind.className = 'command-kind';
      kind.textContent = item.kind || 'Command';
      row.append(icon(item.icon || 'command'), details, kind);
      row.addEventListener('click', () => this.run(index));
      fragment.append(row);
    });
    if (!this.items.length) {
      const empty = document.createElement('div');
      empty.className = 'command-empty';
      empty.textContent = 'No matching sessions or commands.';
      fragment.append(empty);
    }
    $('command-list').replaceChildren(fragment);
    this.highlight(0);
  }

  highlight(index) {
    this.selected = this.items.length ? (index + this.items.length) % this.items.length : 0;
    const rows = [...$('command-list').querySelectorAll('.command-option')];
    rows.forEach((row, position) => {
      row.classList.toggle('selected', position === this.selected);
      row.setAttribute('aria-selected', String(position === this.selected));
    });
    const current = rows[this.selected];
    if (current) {
      $('command-input').setAttribute('aria-activedescendant', current.id);
      current.scrollIntoView({block:'nearest'});
    } else $('command-input').removeAttribute('aria-activedescendant');
  }

  run(index) {
    const item = this.items[index];
    if (!item) return;
    $('command-dialog').close();
    item.run();
  }
}
