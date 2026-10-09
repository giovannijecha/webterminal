import {TerminalRenderer} from './render.js';
import {TerminalInput} from './input.js';
import {displayPath, editInline, sessionName, stateClass} from './common.js';

export const SESSION_DRAG = 'application/x-webterminal-session';
const PARTS = ['pane-header', 'terminal-scroll', 'terminal-lines', 'keyboard', 'terminal-title', 'terminal-path', 'live-dot', 'pane-status', 'take-control', 'close-session', 'terminal-hint', 'find', 'findbar', 'find-input', 'find-count', 'find-prev', 'find-next', 'find-close'];

// Each visible pane has its own projection, input adapter and viewport.
// Terminal state and control epochs remain owned by the Rust server.
export class TerminalPane {
  constructor(root, prefix, callbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.id = null;
    this.ui = Object.fromEntries(PARTS.map(id => [id, document.getElementById(prefix + id)]));
    const ui = this.ui;
    this.renderer = new TerminalRenderer(ui['terminal-scroll'], ui['terminal-lines']);
    this.input = new TerminalInput({keyboard:ui.keyboard, scroll:ui['terminal-scroll'], renderer:this.renderer, snapshot:() => callbacks.snapshot(this.id), canInput:() => callbacks.canInput(this), send:data => callbacks.input(this, data), notify:callbacks.notify});
    root.addEventListener('pointerdown', () => callbacks.focus(this), true);
    root.addEventListener('focusin', () => callbacks.focus(this));
    ui.find.addEventListener('click', () => this.showFind(true));
    ui['find-close'].addEventListener('click', () => this.showFind(false));
    ui['find-input'].addEventListener('input', () => this.updateFind());
    ui['find-input'].addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.advanceFind(event.shiftKey ? -1 : 1); }
      else if (event.key === 'Escape') this.showFind(false);
    });
    ui['find-prev'].addEventListener('click', () => this.advanceFind(-1));
    ui['find-next'].addEventListener('click', () => this.advanceFind(1));
    ui['take-control'].addEventListener('click', () => callbacks.claim(this));
    ui['close-session'].addEventListener('click', () => callbacks.close(this.id));
    ui['terminal-title'].addEventListener('click', () => this.rename());
    ui['terminal-scroll'].addEventListener('pointerdown', () => {
      if (!document.getSelection()?.isCollapsed) document.getSelection().removeAllRanges();
    });
    // The header drags the terminal to another pane position or workspace tab.
    ui['pane-header'].addEventListener('dragstart', event => {
      if (!this.id || event.target.closest('button')) { event.preventDefault(); return; }
      event.dataTransfer.setData(SESSION_DRAG, this.id);
      event.dataTransfer.effectAllowed = 'move';
      document.documentElement.classList.add('dragging-session');
    });
    ui['pane-header'].addEventListener('dragend', () => document.documentElement.classList.remove('dragging-session'));
    root.addEventListener('dragover', event => {
      if (!event.dataTransfer.types.includes(SESSION_DRAG)) return;
      event.preventDefault();
      root.classList.add('drop-target');
    });
    root.addEventListener('dragleave', event => { if (!root.contains(event.relatedTarget)) root.classList.remove('drop-target'); });
    root.addEventListener('drop', event => {
      root.classList.remove('drop-target');
      const id = event.dataTransfer.getData(SESSION_DRAG);
      if (!id) return;
      event.preventDefault();
      if (id !== this.id) callbacks.drop(this, id);
    });
    const geometry = new ResizeObserver(callbacks.resize);
    geometry.observe(root);
    geometry.observe(ui['terminal-scroll']);
  }

  bind(id, views) {
    if (this.id === id) return;
    if (this.id) {
      const scroll = this.ui['terminal-scroll'];
      views.set(this.id, {scrollTop:scroll.scrollTop, atBottom:scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < this.renderer.lineHeight * 2, query:this.ui['find-input'].value, findOpen:!this.ui.findbar.hidden, matchIndex:this.renderer.matchIndex});
    }
    this.input.reset();
    this.id = id;
    this.root.hidden = !id;
    const view = views.get(id);
    this.renderer.clear();
    this.ui['find-input'].value = view?.query || '';
    this.ui.findbar.hidden = !view?.findOpen;
    this.renderer.setSearch(view?.query || '');
    const snapshot = this.callbacks.snapshot(id);
    if (snapshot) this.renderer.render(snapshot);
    if (view) {
      this.renderer.matchIndex = Math.min(view.matchIndex, this.renderer.matches.length - 1);
      this.renderer.highlightActive();
      this.ui['terminal-scroll'].scrollTop = view.atBottom ? this.ui['terminal-scroll'].scrollHeight : view.scrollTop;
    }
    this.ui['find-count'].textContent = this.renderer.matches.length ? `${this.renderer.matchIndex + 1} / ${this.renderer.matches.length}` : '0 matches';
  }

  update(session, snapshot, status, ready, view) {
    const ui = this.ui, name = sessionName(session), path = displayPath(session?.cwd);
    ui['terminal-title'].textContent = name;
    ui['terminal-title'].title = `${session?.title || name}\nClick to rename`;
    ui['terminal-title'].setAttribute('aria-label', `Rename terminal ${name}`);
    ui['terminal-path'].textContent = path;
    ui['terminal-path'].title = path;
    ui['live-dot'].className = `pane-dot${stateClass(snapshot ?? session)}`;
    ui['take-control'].hidden = !ready || !snapshot?.alive || snapshot.controller === view;
    ui['pane-status'].textContent = status === 'Controlling' ? '' : status;
    ui['pane-status'].title = snapshot?.terminal ? `${snapshot.terminal.cols} × ${snapshot.terminal.rows}` : '';
    ui['close-session'].setAttribute('aria-label', `Close terminal ${name}`);
    ui['terminal-hint'].textContent = ready && snapshot?.alive && snapshot.controller !== view ? 'This view is observing. Take control to type, paste, resize, or use the mouse.' : 'Click to type · Select text to copy · Shift+drag selects text when an app uses the mouse';
    this.root.dataset.status = status;
    this.root.setAttribute('aria-label', `Terminal ${name}`);
  }

  rename() {
    if (!this.id) return;
    const id = this.id, label = this.ui['terminal-title'];
    editInline(label, {value:label.textContent, accessibleName:'Terminal name', save:name => this.callbacks.rename(id, name), closed:() => this.callbacks.renamed()});
  }

  render(snapshot) { this.renderer.render(snapshot); }
  focus() { this.input.focus(); }

  showFind(show) {
    if (show && !this.id) return;
    this.ui.findbar.hidden = !show;
    if (show) { this.ui['find-input'].focus(); this.ui['find-input'].select(); }
    else { this.ui['find-input'].value = ''; this.renderer.setSearch(''); this.focus(); }
  }
  updateFind() {
    const count = this.renderer.setSearch(this.ui['find-input'].value);
    this.ui['find-count'].textContent = `${count} matches`;
    if (count) this.advanceFind(1);
  }
  advanceFind(direction) {
    const position = this.renderer.nextMatch(direction);
    if (position) this.ui['find-count'].textContent = `${position.index} / ${position.total}`;
  }
  async copy() {
    const text = this.renderer.selectionText();
    if (!text) { this.callbacks.notify('Select terminal text to copy.'); return; }
    try { await navigator.clipboard.writeText(text); this.callbacks.copied(text); this.callbacks.notify('Copied selection.'); }
    catch { this.callbacks.notify('Clipboard access was denied by the browser.', 'error'); }
  }
}

// Pane 1 keeps the plain IDs from the page; panes 2 to 4 are prefixed clones.
export function createPanes(count, callbacks) {
  const primary = document.getElementById('pane');
  const panes = [new TerminalPane(primary, '', callbacks)];
  for (let index = 2; index <= count; index++) {
    const prefix = `pane${index}-`, clone = primary.cloneNode(true);
    clone.id = prefix + 'pane';
    for (const element of clone.querySelectorAll('[id]')) element.id = prefix + element.id;
    for (const element of clone.querySelectorAll('[for],[aria-controls],[aria-labelledby],[aria-describedby]')) {
      for (const attr of ['for', 'aria-controls', 'aria-labelledby', 'aria-describedby']) {
        if (element.hasAttribute(attr)) element.setAttribute(attr, element.getAttribute(attr).split(' ').map(id => prefix + id).join(' '));
      }
    }
    primary.parentElement.append(clone);
    panes.push(new TerminalPane(clone, prefix, callbacks));
  }
  panes.forEach((pane, index) => { pane.index = index; pane.root.dataset.index = String(index); });
  return panes;
}
