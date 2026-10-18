import {TerminalRenderer, lineText} from './render.js';
import {TerminalInput} from './input.js';
import {droppedFiles} from './upload.js';
import {displayPath, sessionName} from './common.js';
import {state, canInput, control, programLabel, ready, requestSummary, requestsFor, terminalStatus} from './model.js';
import {plural} from './dom.js';

export const SESSION_DRAG = 'application/x-webterminal-session';
const PARTS = ['pane-header', 'terminal-scroll', 'terminal-lines', 'keyboard', 'terminal-title', 'terminal-path', 'pane-program', 'pane-status', 'find', 'maximize', 'maximize-icon', 'pane-menu', 'findbar', 'find-input', 'find-count', 'find-prev', 'find-next', 'find-close', 'observer', 'take-control', 'prompt', 'prompt-text', 'prompt-review', 'follow', 'latest', 'terminal-hint'];

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
function setAttribute(node, name, value) { if (node.getAttribute(name) !== value) node.setAttribute(name, value); }

// Each visible pane has its own projection, input adapter and viewport.
// Terminal state and control epochs remain owned by the Rust server.
export class TerminalPane {
  constructor(root, prefix, callbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.id = null;
    this.following = true;
    this.mark = null;
    this.ui = Object.fromEntries(PARTS.map(id => [id, document.getElementById(prefix + id)]));
    const ui = this.ui;
    this.renderer = new TerminalRenderer(ui['terminal-scroll'], ui['terminal-lines']);
    this.input = new TerminalInput({keyboard:ui.keyboard, scroll:ui['terminal-scroll'], renderer:this.renderer, snapshot:() => state.snapshots.get(this.id), canInput:() => canInput(this.id), send:data => callbacks.input(this, data), notify:callbacks.notify});
    root.addEventListener('pointerdown', () => callbacks.focus(this), true);
    root.addEventListener('focusin', () => callbacks.focus(this));
    ui.find.addEventListener('click', () => this.showFind(true));
    ui['find-close'].addEventListener('click', () => this.showFind(false));
    ui['find-input'].addEventListener('input', () => this.updateFind());
    ui['find-input'].addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.advanceFind(event.shiftKey ? -1 : 1); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.showFind(false); }
    });
    ui['find-prev'].addEventListener('click', () => this.advanceFind(-1));
    ui['find-next'].addEventListener('click', () => this.advanceFind(1));
    ui['take-control'].addEventListener('click', () => callbacks.claim(this));
    ui.maximize.addEventListener('click', () => callbacks.maximize(this));
    ui['pane-menu'].addEventListener('click', () => callbacks.menu(this, ui['pane-menu']));
    ui['terminal-title'].addEventListener('click', () => callbacks.rename(this));
    ui['prompt-review'].addEventListener('click', () => callbacks.review(this));
    ui.latest.addEventListener('click', () => { this.scrollToLatest(); this.focus(); });
    const scroll = ui['terminal-scroll'];
    scroll.addEventListener('pointerdown', () => {
      if (!document.getSelection()?.isCollapsed) document.getSelection().removeAllRanges();
    });
    scroll.addEventListener('scroll', () => { if (this.visible) this.savedTop = scroll.scrollTop; this.updateFollow(); }, {passive:true});
    // The header drags the terminal to another pane position or workspace.
    ui['pane-header'].addEventListener('dragstart', event => {
      if (!this.id || event.target.closest('button')) { event.preventDefault(); return; }
      event.dataTransfer.setData(SESSION_DRAG, this.id);
      event.dataTransfer.effectAllowed = 'move';
      document.documentElement.classList.add('dragging-session');
    });
    ui['pane-header'].addEventListener('dragend', () => document.documentElement.classList.remove('dragging-session'));
    // Files dropped from the desktop are staged and pasted as paths.
    const files = event => !event.dataTransfer.types.includes(SESSION_DRAG) && event.dataTransfer.types.includes('Files');
    root.addEventListener('dragover', event => {
      if (files(event) && this.id) event.dataTransfer.dropEffect = 'copy';
      else if (!event.dataTransfer.types.includes(SESSION_DRAG)) return;
      event.preventDefault();
      root.classList.add('drop-target');
    });
    root.addEventListener('dragleave', event => { if (!root.contains(event.relatedTarget)) root.classList.remove('drop-target'); });
    root.addEventListener('drop', event => {
      root.classList.remove('drop-target');
      if (files(event)) {
        event.preventDefault();
        if (this.id) callbacks.files(this, droppedFiles(event.dataTransfer));
        return;
      }
      const id = event.dataTransfer.getData(SESSION_DRAG);
      if (!id) return;
      event.preventDefault();
      if (id !== this.id) callbacks.drop(this, id);
    });
    const geometry = new ResizeObserver(() => { this.updateFollow(); callbacks.resize(); });
    geometry.observe(root);
    geometry.observe(scroll);
  }

  get visible() { return this.ui['terminal-scroll'].clientWidth > 0; }

  bind(id, views) {
    if (this.id === id) return;
    if (this.id) {
      const scroll = this.ui['terminal-scroll'];
      views.set(this.id, {scrollTop:scroll.scrollTop, atBottom:this.following, query:this.ui['find-input'].value, findOpen:!this.ui.findbar.hidden, matchIndex:this.renderer.matchIndex});
    }
    this.input.reset();
    this.id = id;
    this.root.hidden = !id;
    this.dirty = false;
    const view = views.get(id);
    this.renderer.clear();
    this.ui['find-input'].value = view?.query || '';
    this.ui.findbar.hidden = !view?.findOpen;
    this.renderer.setSearch(view?.query || '');
    const snapshot = state.snapshots.get(id);
    if (snapshot) this.renderer.render(snapshot);
    if (view) {
      this.renderer.matchIndex = Math.min(view.matchIndex, this.renderer.matches.length - 1);
      this.renderer.highlightActive();
      this.ui['terminal-scroll'].scrollTop = view.atBottom ? this.ui['terminal-scroll'].scrollHeight : view.scrollTop;
    }
    this.following = view ? view.atBottom : true;
    this.mark = null;
    this.findCount();
  }

  // A pane hidden by the layout keeps its terminal; showing it restores the view.
  reveal() {
    const scroll = this.ui['terminal-scroll'];
    this.shown = true;
    if (this.following) scroll.scrollTop = scroll.scrollHeight;
    else if (this.savedTop) scroll.scrollTop = this.savedTop;
    this.updateFollow();
  }

  // Chrome only: text and attributes change in place, the terminal rows never.
  update({focused, maximized}) {
    const ui = this.ui, session = state.sessions.get(this.id), snapshot = state.snapshots.get(this.id);
    const name = sessionName(session), path = displayPath(session?.cwd), status = terminalStatus(this.id), owner = control(this.id);
    this.root.classList.toggle('focused', focused);
    setText(ui['terminal-title'], name);
    ui['terminal-title'].title = `${session?.title || name}\nClick to rename`;
    setAttribute(ui['terminal-title'], 'aria-label', `Rename terminal ${name}`);
    setText(ui['pane-program'], programLabel(session));
    setText(ui['terminal-path'], path);
    ui['terminal-path'].title = path;
    setText(ui['pane-status'].firstElementChild, status.label);
    setAttribute(ui['pane-status'], 'data-tone', status.tone);
    ui['pane-status'].title = snapshot?.terminal ? `${status.label} · ${snapshot.terminal.cols} × ${snapshot.terminal.rows}` : status.label;
    const observing = ready(this.id) && snapshot?.alive && snapshot.controller !== state.view;
    ui.observer.hidden = !observing;
    ui['take-control'].disabled = !state.connected;
    ui['take-control'].title = state.connected ? '' : 'Reconnect before taking control';
    const request = requestsFor(this.id)[0];
    ui.prompt.hidden = !request;
    if (request) setText(ui['prompt-text'], `${request.label || programLabel(session)} ${requestSummary(request)}`);
    setAttribute(ui['maximize-icon'], 'href', maximized ? '#icon-minimize-2' : '#icon-maximize-2');
    setAttribute(ui.maximize, 'aria-label', maximized ? 'Restore layout' : 'Maximize terminal');
    ui.maximize.title = maximized ? 'Restore layout' : 'Maximize';
    setAttribute(ui.maximize, 'aria-pressed', String(maximized));
    setAttribute(this.root, 'aria-label', name);
    setAttribute(ui['terminal-scroll'], 'aria-label', `${name} terminal`);
    setText(ui['terminal-hint'], observing ? 'This view is observing. Take control to type, paste, resize, or use the mouse.' : 'Click to type · Select text to copy · Shift+drag selects text when an app uses the mouse');
    // Status words for tests and assistive tools; the badge carries the visible state.
    this.root.dataset.status = !state.connected ? 'Reconnecting…' : !ready(this.id) || !snapshot ? 'Connecting…'
      : !snapshot.alive ? `Exited${snapshot.exitCode === null ? '' : ` (${snapshot.exitCode})`}` : owner.mine ? 'Controlling' : 'Observing';
    this.updateFollow();
  }

  render(snapshot) {
    const before = this.following;
    this.renderer.render(snapshot);
    if (!before && this.mark === null) this.mark = this.rowCount(snapshot);
    this.updateFollow();
  }
  rowCount(snapshot = state.snapshots.get(this.id)) {
    const term = snapshot?.terminal;
    return term ? (term.alternate ? 0 : term.history?.length || 0) + (term.screen?.length || 0) : 0;
  }
  // The footer reports history and follow state only.
  updateFollow() {
    const scroll = this.ui['terminal-scroll'];
    if (!this.visible) return;
    // Hiding a pane resets its scroll position; restore it before reading it.
    if (!this.shown) return this.reveal();
    // A layout or font change moves the bottom edge; it never stops following.
    const size = `${scroll.clientWidth}x${scroll.clientHeight}x${this.renderer.lineHeight}`;
    if (size !== this.size) {
      this.size = size;
      if (this.following) scroll.scrollTop = scroll.scrollHeight;
    }
    const atBottom = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < this.renderer.lineHeight * 2;
    if (atBottom !== this.following) { this.following = atBottom; this.mark = atBottom ? null : this.rowCount(); }
    const fresh = this.mark === null ? 0 : Math.max(0, this.rowCount() - this.mark);
    const text = !state.connected ? 'Output paused' : atBottom ? 'Following output' : fresh ? plural(fresh, 'new row') : 'History';
    setText(this.ui.follow, text);
    this.ui.latest.hidden = atBottom;
  }
  scrollToLatest() {
    const scroll = this.ui['terminal-scroll'];
    scroll.scrollTop = scroll.scrollHeight;
    this.updateFollow();
  }

  focus() { this.input.focus(); }

  showFind(show) {
    if (show && !this.id) return;
    this.ui.findbar.hidden = !show;
    if (show) { this.ui['find-input'].focus(); this.ui['find-input'].select(); }
    else { this.ui['find-input'].value = ''; this.renderer.setSearch(''); this.findCount(); this.focus(); }
    this.callbacks.resize();
  }
  findCount(position = null) {
    const total = this.renderer.matches.length, query = this.ui['find-input'].value;
    this.ui['find-count'].textContent = !query ? 'Type to find' : !total ? 'No matches' : `${position?.index ?? this.renderer.matchIndex + 1} of ${total}`;
    this.ui['find-prev'].disabled = this.ui['find-next'].disabled = !total;
  }
  updateFind() {
    const count = this.renderer.setSearch(this.ui['find-input'].value);
    if (count) this.advanceFind(1); else this.findCount();
  }
  advanceFind(direction) {
    const position = this.renderer.nextMatch(direction);
    this.findCount(position);
  }

  // Plain text of the whole history and screen; wrapped rows join their next row.
  outputText() {
    const term = state.snapshots.get(this.id)?.terminal;
    if (!term) return '';
    const lines = (term.alternate ? [] : term.history || []).concat(term.screen || []);
    let text = '';
    lines.forEach((line, index) => {
      const value = lineText(line);
      text += line?.wrapped ? value : value.replace(/\s+$/, '');
      if (!line?.wrapped && index + 1 < lines.length) text += '\n';
    });
    return text.replace(/\n+$/, '');
  }
  selectionText() { return this.renderer.selectionText(); }
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
