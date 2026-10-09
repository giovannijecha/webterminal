import {TerminalRenderer} from './render.js';
import {TerminalInput} from './input.js';
import {displayPath, sessionName} from './workbench.js';

// Each visible group has its own projection, input adapter and viewport.
// Terminal state and control epochs remain owned by the Rust server.
export class TerminalPane {
  constructor(root, prefix, callbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.id = null;
    this.ui = Object.fromEntries(['welcome','welcome-new','terminal-area','terminal-scroll','terminal-lines','keyboard','terminal-title','terminal-path','live-dot','take-control','copy','paste','close-session','terminal-hint','find','findbar','find-input','find-count','find-prev','find-next','find-close'].map(id => [id, document.getElementById(prefix + id)]));
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
    ui.copy.addEventListener('click', () => this.copy());
    ui.paste.addEventListener('click', () => this.paste());
    ui['welcome-new'].addEventListener('click', () => callbacks.create(this));
    ui['terminal-scroll'].addEventListener('pointerdown', () => {
      if (!document.getSelection()?.isCollapsed) document.getSelection().removeAllRanges();
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
    const ui = this.ui;
    ui.welcome.hidden = Boolean(this.id);
    ui['terminal-area'].hidden = !this.id;
    ui.find.disabled = !this.id;
    ui['terminal-title'].textContent = sessionName(session);
    ui['terminal-title'].title = session?.title || sessionName(session);
    ui['terminal-path'].textContent = displayPath(session?.cwd);
    ui['terminal-path'].title = displayPath(session?.cwd);
    ui['live-dot'].classList.toggle('live', Boolean(snapshot?.alive ?? session?.alive));
    ui['take-control'].hidden = !ready || !snapshot?.alive || snapshot.controller === view;
    ui.paste.disabled = !this.callbacks.canInput(this);
    ui['terminal-hint'].textContent = ready && snapshot?.alive && snapshot.controller !== view ? 'This view is observing. Take control to type, paste, resize, or use the mouse.' : 'Click to type · Select text to copy · Shift+drag selects text when an app uses the mouse';
    this.root.dataset.status = status;
    const label = this.root.querySelector('.pane-status');
    if (label) label.textContent = status;
  }

  render(snapshot) { this.renderer.render(snapshot); }
  focus() { this.input.focus(); }

  showFind(show) {
    if (show && !this.id) { this.callbacks.notify('Create a terminal to search its output.'); return; }
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
  selectAll() {
    if (!this.id) return;
    const range = document.createRange();
    range.selectNodeContents(this.ui['terminal-lines']);
    document.getSelection().removeAllRanges();
    document.getSelection().addRange(range);
    this.renderer.setFrozen(true);
  }
  async copy() {
    const text = this.renderer.selectionText();
    if (!text) { this.callbacks.notify('Select terminal text to copy.'); return; }
    try { await navigator.clipboard.writeText(text); this.callbacks.notify('Copied selection.'); }
    catch { this.callbacks.notify('Clipboard access was denied by the browser.', 'error'); }
  }
  async paste() {
    const id = this.id;
    const epoch = this.callbacks.snapshot(id)?.epoch;
    const connection = this.callbacks.connection();
    try {
      const text = await navigator.clipboard.readText();
      if (this.id !== id || this.callbacks.connection() !== connection || this.callbacks.snapshot(id)?.epoch !== epoch || !this.callbacks.canInput(this)) return;
      this.input.pasteText(text);
      this.focus();
    } catch { this.callbacks.notify('Clipboard access was denied by the browser.', 'error'); }
  }
}

export function createSecondGroup() {
  const primary = document.getElementById('editor-primary');
  const secondary = primary.cloneNode(true);
  secondary.id = 'editor-secondary';
  secondary.dataset.group = '2';
  secondary.setAttribute('aria-label', 'Terminal group 2');
  for (const element of secondary.querySelectorAll('[id]')) element.id = 'secondary-' + element.id;
  for (const element of secondary.querySelectorAll('*')) {
    for (const attr of ['for','aria-controls','aria-labelledby','aria-describedby']) {
      if (element.hasAttribute(attr)) element.setAttribute(attr, element.getAttribute(attr).split(' ').map(id => 'secondary-' + id).join(' '));
    }
  }
  secondary.querySelector('#secondary-welcome h1').textContent = 'Group 2';
  secondary.querySelector('#secondary-welcome .welcome-heading p').textContent = 'Open a terminal or move a tab here.';
  secondary.querySelector('#secondary-editor-more').dataset.menu = 'Terminal';
  secondary.hidden = true;
  document.getElementById('editor-groups').append(secondary);
  return secondary;
}
