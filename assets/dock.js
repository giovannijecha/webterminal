// The Dock: one notice at a time at the bottom of the page frame. It reserves
// its own height, so terminals shrink above it instead of being covered.
import {el} from './dom.js';

export class Dock {
  constructor(root, live, {home = () => null} = {}) {
    this.root = root;
    this.live = live;
    this.home = home;
    this.current = null;
  }
  // kind: success | attention | error. `action` is {label, run}.
  show({title, text = '', kind = 'success', action = null, key = null}) {
    const notice = el('section', {class:'feedback-notice', 'data-kind':kind, 'aria-label':title});
    const dismiss = el('button', {class:'btn ghost sm', type:'button', text:'Dismiss'});
    const actions = el('div', {class:'feedback-actions'});
    if (action) {
      const run = el('button', {class:'btn primary sm', type:'button', text:action.label});
      run.addEventListener('click', () => { this.hide(notice); action.run(); });
      actions.append(run);
    }
    actions.append(dismiss);
    dismiss.addEventListener('click', () => this.hide(notice));
    notice.append(el('div', {}, el('h2', {text:title}), text ? el('p', {text}) : null), actions);
    this.root.replaceChildren(notice);
    this.root.hidden = false;
    this.current = {notice, key};
    this.live.textContent = '';
    // A separate task lets screen readers announce a replaced notice again.
    setTimeout(() => { this.live.textContent = text ? `${title}. ${text}` : title; }, 30);
    return notice;
  }
  // Removes the current notice; with `key`, only a notice shown with it.
  clear(key = null) {
    if (!this.current || (key !== null && this.current.key !== key)) return;
    this.hide(this.current.notice);
  }
  hide(notice) {
    if (this.current?.notice !== notice) return;
    const hadFocus = notice.contains(document.activeElement);
    this.current = null;
    this.root.replaceChildren();
    this.root.hidden = true;
    if (hadFocus) this.home()?.focus();
  }
}

// Browser notifications for events that arrive while the tab is in the
// background. Permission is requested only from a user action, and each
// event key notifies once per page load.
export class BrowserNotices {
  constructor() { this.seen = new Set(); }
  get supported() { return typeof Notification === 'function'; }
  get permission() { return this.supported ? Notification.permission : 'unsupported'; }
  async request() {
    if (!this.supported) return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    try { return await Notification.requestPermission(); } catch { return Notification.permission; }
  }
  show(key, title, body, onClick) {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 512) this.seen.delete(this.seen.values().next().value);
    if (!this.supported || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
    try {
      const notice = new Notification(title, {body, tag:key});
      notice.addEventListener('click', () => { focus(); onClick?.(); notice.close(); });
    } catch { /* Some browsers allow notifications only from a service worker. */ }
  }
}
