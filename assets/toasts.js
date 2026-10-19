// Toasts: short feedback cards stacked at the bottom right, above the page
// rather than inside its layout, so showing one never resizes a terminal.
// Routine successes expire, toasts with an action linger, errors stay until
// dismissed. A toast under the pointer or holding focus waits. Showing a
// toast never moves focus; the region passes pointer events through between
// cards.
import {el, icon} from './dom.js';

const LIMIT = 3, SUCCESS_MS = 4000, ACTION_MS = 8000;

export class Toasts {
  constructor(root, live, {home = () => null} = {}) {
    this.root = root;
    this.live = live;
    this.home = home;
    this.items = new Map();
    this.announcement = 0;
  }
  // kind: success | error. `action` is {label, run}. A `sticky` toast stays
  // until it is dismissed, cleared or replaced; a newer toast with the same
  // `key` replaces the older one.
  show({title, text = '', kind = 'success', action = null, key = null, sticky = false}) {
    if (key !== null) this.clear(key);
    while (this.items.size >= LIMIT) this.hide(this.oldest());
    const node = el('section', {class:'toast', 'data-kind':kind, 'aria-label':title});
    const item = {node, key, kind, held:new Set(), timer:0, returnTo:null, delay:sticky || kind === 'error' ? 0 : action ? ACTION_MS : SUCCESS_MS};
    const body = el('div', {class:'toast-body'}, el('h2', {text:title}), text ? el('p', {text}) : null);
    if (action) {
      const run = el('button', {class:'btn sm', type:'button', text:action.label});
      run.addEventListener('click', () => { this.hide(item); action.run(); });
      body.append(el('div', {class:'toast-actions'}, run));
    }
    const dismiss = el('button', {class:'icon-btn ghost sm', type:'button', 'aria-label':`Dismiss: ${title}`, title:'Dismiss'}, icon('x'));
    dismiss.addEventListener('click', () => this.hide(item));
    node.append(body, dismiss);
    node.addEventListener('pointerenter', () => this.hold(item, 'pointer', true));
    node.addEventListener('pointerleave', () => this.hold(item, 'pointer', false));
    node.addEventListener('focusin', event => {
      if (!item.held.has('focus') && !node.contains(event.relatedTarget)) item.returnTo = event.relatedTarget;
      this.hold(item, 'focus', true);
    });
    node.addEventListener('focusout', event => { if (!node.contains(event.relatedTarget)) this.hold(item, 'focus', false); });
    node.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      this.hide(item);
    });
    this.items.set(node, item);
    this.root.append(node);
    this.root.hidden = false;
    this.arm(item);
    this.announce(text ? `${title}. ${text}` : title);
    return node;
  }
  // True while `node` is still on screen, so its owner may update it in place.
  shown(node) { return Boolean(node && this.items.has(node)); }
  // Removes the toasts shown with `key`.
  clear(key) {
    for (const item of [...this.items.values()]) if (item.key === key) this.hide(item);
  }
  hide(target) {
    const item = target instanceof Node ? this.items.get(target) : target;
    if (!item || this.items.get(item.node) !== item) return;
    clearTimeout(item.timer);
    const hadFocus = item.node.contains(document.activeElement);
    this.items.delete(item.node);
    item.node.remove();
    this.root.hidden = !this.items.size;
    if (hadFocus) (item.returnTo?.isConnected && !this.root.contains(item.returnTo) ? item.returnTo : this.home())?.focus({preventScroll:true});
  }
  // Errors and toasts in use are evicted last.
  oldest() {
    const items = [...this.items.values()];
    return items.find(item => !item.held.size && item.kind !== 'error') || items.find(item => !item.held.size) || items[0];
  }
  hold(item, reason, on) {
    if (on) item.held.add(reason); else item.held.delete(reason);
    this.arm(item);
  }
  // Each toast owns its timer, so an earlier timer never dismisses a newer toast.
  arm(item) {
    clearTimeout(item.timer);
    item.timer = item.delay && !item.held.size ? setTimeout(() => this.hide(item), item.delay) : 0;
  }
  announce(text) {
    this.live.textContent = '';
    clearTimeout(this.announcement);
    // A separate task lets screen readers announce a repeated message again.
    this.announcement = setTimeout(() => { this.live.textContent = text; }, 30);
  }
}
