import {icon, sessionName, displayPath, stateClass} from './workbench.js';

const STORAGE = 'webterminal.layout';
const DRAG_TYPE = 'text/x-webterminal-session';

export class WorkspaceLayout {
  constructor({change, create, close, rename, reorder, context}) {
    Object.assign(this, {change, create, close, rename, reorder, context});
    this.groups = [{id:'1', label:'Group 1', sessions:[], active:null}, {id:'2', label:'Group 2', sessions:[], active:null}];
    this.focused = 0;
    this.split = false;
    this.sessions = new Map();
    this.signature = '';
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE));
      if (Array.isArray(saved?.groups) && saved.groups.length === 2) {
        const seen = new Set();
        for (let i = 0; i < 2; i++) {
          const group = saved.groups[i];
          this.groups[i].sessions = (Array.isArray(group.sessions) ? group.sessions : []).filter(id => typeof id === 'string' && /^s\d+$/.test(id) && !seen.has(id) && seen.add(id)).slice(0, 32);
          this.groups[i].active = this.groups[i].sessions.includes(group.active) ? group.active : this.groups[i].sessions[0] || null;
        }
        this.split = Boolean(saved.split);
        this.focused = saved.focused === 1 && this.split ? 1 : 0;
      }
    } catch { /* Invalid tab-local presentation preferences are discarded. */ }
    const active = sessionStorage.getItem('webterminal.active');
    if (active && !this.groups.some(group => group.sessions.includes(active))) { this.groups[0].sessions.push(active); this.groups[0].active = active; }
    for (const [index, id] of ['tabs','secondary-tabs'].entries()) {
      const tabs = document.getElementById(id);
      tabs.addEventListener('dragover', event => {
        if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move'; tabs.classList.add('drop-target');
      });
      tabs.addEventListener('dragleave', () => tabs.classList.remove('drop-target'));
      tabs.addEventListener('drop', event => {
        tabs.classList.remove('drop-target');
        const id = event.dataTransfer.getData(DRAG_TYPE);
        if (!this.sessions.has(id)) return;
        event.preventDefault();
        const before = event.target.closest('.tab')?.dataset.session;
        this.move(id, index);
        const ids = [...this.sessions.keys()].filter(value => value !== id);
        const at = before && before !== id ? ids.indexOf(before) : -1;
        ids.splice(at < 0 ? ids.length : at, 0, id);
        this.reorder(ids);
      });
      tabs.addEventListener('keydown', event => this.tabKey(event, index));
    }
  }

  get active() { return this.groups[this.focused].active; }
  groupFor(id) { return this.groups.findIndex(group => group.sessions.includes(id)); }
  sync(sessions) {
    this.sessions = sessions;
    const assigned = new Set();
    for (const group of this.groups) {
      group.sessions = group.sessions.filter(id => sessions.has(id) && !assigned.has(id) && assigned.add(id));
    }
    for (const id of sessions.keys()) if (!assigned.has(id)) this.groups[0].sessions.push(id);
    for (const group of this.groups) {
      group.sessions.sort((a, b) => [...sessions.keys()].indexOf(a) - [...sessions.keys()].indexOf(b));
      if (!group.sessions.includes(group.active)) group.active = group.sessions[0] || null;
    }
    if (!this.split && this.groups[1].sessions.length) this.single(false);
    if (!this.groups[this.focused].active && this.groups[1 - this.focused].active && this.split) this.focused = 1 - this.focused;
    this.persist();
  }
  persist() {
    sessionStorage.setItem(STORAGE, JSON.stringify({groups:this.groups, focused:this.focused, split:this.split}));
    if (this.active) sessionStorage.setItem('webterminal.active', this.active);
    else sessionStorage.removeItem('webterminal.active');
  }
  select(id, focus = true) {
    const index = this.groupFor(id);
    if (index < 0) return;
    this.groups[index].active = id;
    this.focused = index;
    this.persist(); this.change(focus);
  }
  focus(index) {
    if (index === this.focused || index === 1 && !this.split) return;
    this.focused = index; this.persist(); this.change(false);
  }
  place(id, index) {
    for (const group of this.groups) group.sessions = group.sessions.filter(value => value !== id);
    this.groups[index].sessions.push(id);
    this.groups[index].active = id;
    this.focused = index;
    if (index === 1) this.split = true;
    this.persist();
  }
  move(id = this.active, index = 1 - this.focused) {
    if (!id) return;
    this.place(id, index);
    this.sync(this.sessions);
    this.change(true);
  }
  splitLayout() {
    if (this.split) { this.focus(1 - this.focused); this.change(true); return; }
    this.split = true;
    const other = this.groups[0].sessions.find(id => id !== this.active);
    if (other) this.move(other, 1);
    else { this.persist(); this.change(false); this.create(1); }
  }
  single(notify = true) {
    const active = this.active;
    this.groups[0].sessions = [...this.sessions.keys()];
    this.groups[0].active = this.groups[0].sessions.includes(active) ? active : this.groups[0].sessions[0] || null;
    this.groups[1].sessions = []; this.groups[1].active = null;
    this.split = false; this.focused = 0;
    this.persist(); if (notify) this.change(true);
  }
  moveTab(direction) {
    const ids = [...this.sessions.keys()];
    const index = ids.indexOf(this.active);
    const siblings = this.groups[this.focused].sessions;
    const target = siblings[siblings.indexOf(this.active) + direction];
    if (!target) return;
    const other = ids.indexOf(target);
    [ids[index], ids[other]] = [ids[other], ids[index]];
    this.reorder(ids);
  }
  tabKey(event, groupIndex) {
    const tab = event.target.closest('.tab');
    if (!tab || event.target.closest('.tab-close')) return;
    if (event.key === 'F2') { event.preventDefault(); this.select(tab.dataset.session, false); this.rename(tab.dataset.session); return; }
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    if (event.ctrlKey && event.shiftKey && event.key.startsWith('Arrow')) { this.select(tab.dataset.session, false); this.moveTab(event.key === 'ArrowLeft' ? -1 : 1); return; }
    const ids = this.groups[groupIndex].sessions;
    const index = ids.indexOf(tab.dataset.session);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
    this.select(ids[next]);
    requestAnimationFrame(() => document.querySelector(`.tab[data-session="${ids[next]}"]`)?.focus());
  }
  render() {
    document.getElementById('editor-secondary').hidden = !this.split;
    document.getElementById('editor-groups').classList.toggle('split', this.split);
    for (let index = 0; index < 2; index++) document.getElementById(index ? 'editor-secondary' : 'editor-primary').classList.toggle('focused-group', index === this.focused);
    const signature = JSON.stringify([this.groups, this.split, [...this.sessions.values()].map(s => [s.id,s.name,s.title,s.cwd,s.alive,s.exitCode])]);
    if (signature === this.signature) return;
    this.signature = signature;
    for (const [index, group] of this.groups.entries()) {
      const nav = document.getElementById(index ? 'secondary-tabs' : 'tabs');
      const focusId = nav.contains(document.activeElement) ? document.activeElement.closest('.tab')?.dataset.session : null;
      const fragment = document.createDocumentFragment();
      for (const id of group.sessions) {
        const session = this.sessions.get(id); if (!session) continue;
        const tab = document.createElement('div');
        tab.className = `tab${group.active === id ? ' active' : ''}${session.alive ? ' running' : ''}`;
        tab.dataset.session = id; tab.draggable = true;
        tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(group.active === id));
        tab.setAttribute('aria-controls', index ? 'secondary-terminal-area' : 'terminal-area');
        tab.tabIndex = group.active === id ? 0 : -1;
        tab.setAttribute('aria-label', `Open ${sessionName(session)}`);
        tab.title = `${sessionName(session)}\n${displayPath(session.cwd)} · ${id}\nDouble-click or F2 to rename`;
        const label = document.createElement('span'); label.className = 'tab-label'; label.textContent = sessionName(session);
        const dot = document.createElement('span'); dot.className = `tab-dot${stateClass(session)}`;
        const close = document.createElement('button'); close.className = 'tab-close'; close.type = 'button'; close.title = 'Close session'; close.setAttribute('aria-label', `Close ${sessionName(session)}`); close.append(icon('close'));
        close.addEventListener('click', event => { event.stopPropagation(); this.close(id); });
        tab.append(dot,label,close);
        tab.addEventListener('click', () => this.select(id));
        tab.addEventListener('dblclick', () => this.rename(id));
        tab.addEventListener('keydown', event => { if (event.target === tab && ['Enter',' '].includes(event.key)) { event.preventDefault(); this.select(id); } });
        tab.addEventListener('contextmenu', event => { event.preventDefault(); this.select(id, false); this.context(index); });
        tab.addEventListener('dragstart', event => { event.dataTransfer.setData(DRAG_TYPE,id); event.dataTransfer.effectAllowed = 'move'; });
        fragment.append(tab);
      }
      nav.replaceChildren(fragment);
      if (focusId) nav.querySelector(`.tab[data-session="${focusId}"]`)?.focus();
      nav.querySelector('.tab.active')?.scrollIntoView({block:'nearest',inline:'nearest'});
      document.getElementById(index ? 'secondary-tabs-empty' : 'tabs-empty').hidden = Boolean(group.sessions.length);
    }
  }
}
