/// Nest overlays: menus, modal dialogs and the owned combobox.
import {avatar, el, icon} from './dom.js';

let nextId = 0;
const uid = prefix => `${prefix}-${++nextId}`;
const host = anchor => anchor?.closest?.('dialog[open]') || document.body;

function place(node, anchor, {side = 'below', gap = 6} = {}) {
  const box = anchor.getBoundingClientRect(), width = node.offsetWidth, height = node.offsetHeight;
  let left, top;
  if (side === 'right') {
    left = box.right + 4 + width <= innerWidth - 8 ? box.right + 4 : box.left - width - 4;
    top = box.top - 8;
  } else {
    left = box.right - width >= 8 && box.left + width > innerWidth - 8 ? box.right - width : box.left;
    top = box.bottom + gap + height <= innerHeight - 8 || box.top - gap - height < 8 ? box.bottom + gap : box.top - gap - height;
  }
  node.style.left = `${Math.max(8, Math.min(left, innerWidth - width - 8))}px`;
  node.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
}

// A context header names what the menu acts on:
// {head, detail, avatar:[family, label]} or {head, detail, tone} for a status dot.
function header(item) {
  return el('div', {class:'menu-head', role:'presentation'},
    item.avatar ? avatar(item.avatar[0], item.avatar[1]) : item.tone ? el('span', {class:'dot', 'data-tone':item.tone}) : null,
    el('div', {class:'menu-head-text'}, el('b', {text:item.head}), item.detail ? el('span', {text:item.detail}) : null));
}

// Text-only items: {label, hint, danger, disabled, checked, action, submenu,
// title} | {head, …} | {separator:true}. `submenu` may be a function.
export class Menu {
  constructor() {
    this.levels = [];
    this.anchor = null;
    addEventListener('pointerdown', event => { if (this.levels.length && !this.levels.some(level => level.node.contains(event.target)) && !this.anchor?.contains(event.target)) this.close(false); }, true);
    addEventListener('resize', () => this.close(false));
  }
  get open() { return this.levels.length > 0; }
  toggle(anchor, items, options) { if (this.anchor === anchor && this.open) this.close(); else this.show(anchor, items, options); }
  show(anchor, items, {label = 'Actions'} = {}) {
    this.close(false);
    this.anchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    this.push(items, anchor, label, 'below');
  }
  push(items, anchor, label, side) {
    const node = el('div', {class:'menu', role:'menu', 'aria-label':label, tabindex:'-1'});
    const level = {node, items, anchor};
    for (const item of typeof items === 'function' ? items() : items) node.append(this.item(item, level));
    node.addEventListener('keydown', event => this.key(event, level));
    host(this.anchor).append(node);
    this.levels.push(level);
    place(node, anchor, {side});
    this.focusItem(level, 0);
    return level;
  }
  item(item, level) {
    if (item.separator) return el('div', {class:'menu-sep', role:'separator'});
    if (item.head) return header(item);
    const disabled = Boolean(item.disabled);
    // A submenu keeps its popup semantics and arrow keys without a drawn arrow.
    const button = el('button', {class:`menu-item${item.danger ? ' danger' : ''}`, type:'button', role:item.checked === undefined ? 'menuitem' : 'menuitemradio', 'aria-checked':item.checked === undefined ? undefined : String(Boolean(item.checked)), 'aria-disabled':disabled ? 'true' : undefined, 'aria-haspopup':item.submenu ? 'menu' : undefined, 'aria-expanded':item.submenu ? 'false' : undefined, title:item.title, tabindex:'-1'},
      el('span', {text:item.label}), item.hint ? el('span', {class:'hint', text:item.hint}) : item.checked ? icon('check', 'sm') : null);
    button.addEventListener('click', () => {
      if (disabled) return;
      if (item.submenu) { this.openSubmenu(level, button, item); return; }
      this.close(true);
      item.action?.();
    });
    button.addEventListener('pointerenter', () => {
      if (disabled) return;
      button.focus();
      const index = this.levels.indexOf(level);
      if (item.submenu) this.openSubmenu(level, button, item, false);
      else while (this.levels.length > index + 1) this.pop(false);
    });
    return button;
  }
  openSubmenu(level, button, item, focus = true) {
    const index = this.levels.indexOf(level);
    if (this.levels[index + 1]?.anchor === button) { if (focus) this.focusItem(this.levels[index + 1], 0); return; }
    while (this.levels.length > index + 1) this.pop(false);
    button.setAttribute('aria-expanded', 'true');
    const child = this.push(item.submenu, button, item.label, 'right');
    if (!focus) button.focus();
    else this.focusItem(child, 0);
  }
  pop(focus) {
    const level = this.levels.pop();
    if (!level) return;
    level.node.remove();
    level.anchor.setAttribute('aria-expanded', 'false');
    if (focus && this.levels.length) level.anchor.focus();
  }
  enabled(level) { return [...level.node.querySelectorAll('.menu-item:not([aria-disabled="true"])')]; }
  focusItem(level, index) { const items = this.enabled(level); if (items.length) items[(index + items.length) % items.length].focus(); else level.node.focus(); }
  key(event, level) {
    const items = this.enabled(level), index = items.indexOf(document.activeElement);
    const keys = {ArrowDown:() => this.focusItem(level, index + 1), ArrowUp:() => this.focusItem(level, index < 0 ? -1 : index - 1), Home:() => this.focusItem(level, 0), End:() => this.focusItem(level, -1),
      ArrowRight:() => { if (document.activeElement?.getAttribute('aria-haspopup') === 'menu') document.activeElement.click(); },
      ArrowLeft:() => { if (this.levels.length > 1) this.pop(true); },
      Escape:() => { if (this.levels.length > 1) this.pop(true); else this.close(true); },
      Tab:() => { this.close(false); return true; }};
    const handler = keys[event.key];
    if (!handler) return;
    if (handler() !== true) event.preventDefault();
    event.stopPropagation();
  }
  close(focus = true) {
    const anchor = this.anchor;
    while (this.levels.length) this.pop(false);
    this.anchor = null;
    if (!anchor) return;
    anchor.setAttribute('aria-expanded', 'false');
    if (focus && anchor.isConnected) anchor.focus();
  }
}

// Modal dialogs, one at a time; later requests wait for the current one.
// `onSubmit(form)` may return a string error to keep the dialog open.
export class Dialogs {
  constructor({fallbackFocus = () => null} = {}) { this.queue = Promise.resolve(); this.fallbackFocus = fallbackFocus; this.current = null; }
  show(options) {
    const result = this.queue.then(() => this.present(options));
    this.queue = result.catch(() => {});
    return result;
  }
  confirm(options) { return this.show({danger:true, ...options}); }
  present({title, description = '', body = null, action = 'OK', onSubmit = null, danger = false, initial = null, origin = '', cancelLabel = 'Cancel', cancel = true, className = ''}) {
    const opener = document.activeElement;
    const titleId = uid('dialog-title'), descriptionId = uid('dialog-description');
    const error = el('p', {class:'dlg-error', role:'alert', hidden:true});
    const submit = action ? el('button', {class:`btn primary${danger ? ' danger' : ''}`, type:'submit', text:action}) : null;
    const cancelButton = cancel ? el('button', {class:'btn', type:'button', value:'cancel', text:cancelLabel}) : null;
    const closeButton = el('button', {class:'icon-btn ghost', type:'button', 'aria-label':'Close dialog', title:'Close dialog'}, icon('x'));
    const content = typeof body === 'function' ? body() : body;
    const form = el('form', {method:'dialog', novalidate:true},
      el('div', {class:'dlg-head'}, el('div', {}, el('h2', {id:titleId, text:title}), description ? el('p', {id:descriptionId, text:description}) : null, origin ? el('p', {class:'dlg-origin', text:origin}) : null), closeButton),
      el('div', {class:'dlg-body'}, content, error),
      el('div', {class:'dlg-foot'}, cancelButton, submit));
    const dialog = el('dialog', {class:`dlg${className ? ` ${className}` : ''}`, 'aria-labelledby':titleId, 'aria-describedby':description ? descriptionId : undefined}, form);
    if (!content) form.querySelector('.dlg-body').hidden = true;
    document.body.append(dialog);
    this.current = dialog;
    return new Promise(resolve => {
      let pending = false, value = false;
      const finish = result => { value = result; if (dialog.open) dialog.close(); };
      dialog.addEventListener('close', () => {
        // close is queued: a newer focus choice outside the dialog wins.
        const active = document.activeElement;
        const restore = !active || active === document.body || dialog.contains(active);
        dialog.remove();
        this.current = null;
        if (restore) {
          const target = opener?.isConnected && !opener.closest('[inert]') ? opener : this.fallbackFocus();
          target?.focus?.();
        }
        resolve(value);
      });
      dialog.addEventListener('cancel', event => { event.preventDefault(); if (!pending) finish(false); });
      closeButton.addEventListener('click', () => { if (!pending) finish(false); });
      cancelButton?.addEventListener('click', () => { if (!pending) finish(false); });
      form.addEventListener('submit', async event => {
        event.preventDefault();
        if (pending) return;
        error.hidden = true;
        let outcome = true;
        if (onSubmit) {
          pending = true;
          submit?.setAttribute('aria-busy', 'true');
          try { outcome = await onSubmit(form); } catch (problem) { outcome = problem?.message || 'Something went wrong. Try again.'; }
          pending = false;
          submit?.removeAttribute('aria-busy');
        }
        if (typeof outcome === 'string') { error.textContent = outcome; error.hidden = false; return; }
        if (outcome === false) return;
        finish(outcome === undefined ? true : outcome);
      });
      dialog.showModal();
      const focus = danger ? cancelButton : (typeof initial === 'string' ? form.querySelector(initial) : initial) || form.querySelector('.dlg-body input:not([type=hidden]),.dlg-body textarea,.dlg-body select,.dlg-body [role=radio][aria-checked=true],.dlg-body button') || submit || cancelButton;
      focus?.focus();
    });
  }
  // Inline field validation: marks the field and links its message.
  static invalid(field, message) {
    const id = field.id || (field.id = uid('field'));
    let note = document.getElementById(`${id}-error`);
    if (!message) { field.removeAttribute('aria-invalid'); note?.remove(); return false; }
    if (!note) { note = el('p', {class:'error', id:`${id}-error`}); (field.closest('.choice') || field).after(note); }
    note.textContent = message;
    field.setAttribute('aria-invalid', 'true');
    field.setAttribute('aria-describedby', note.id);
    field.focus();
    return true;
  }
}

// An owned combobox over a hidden native select. Call `refresh()` after
// changing the select's options or value.
export function choice(select, label) {
  select.classList.add('choice-source');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const popupId = uid('listbox');
  const value = el('span', {class:'choice-value'});
  const trigger = el('button', {class:'field-control choice-trigger', type:'button', role:'combobox', 'aria-haspopup':'listbox', 'aria-expanded':'false', 'aria-controls':popupId, 'aria-label':label}, value);
  const root = el('div', {class:'choice'});
  select.replaceWith(root);
  root.append(select, trigger);
  let popup = null, active = -1, typed = '', typedAt = 0;
  const options = () => [...select.options];
  const refresh = () => { value.textContent = select.selectedOptions[0]?.textContent || ''; trigger.disabled = select.disabled || options().every(option => option.disabled); };
  const close = (focus = true) => {
    if (!popup) return;
    popup.remove(); popup = null;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-activedescendant');
    removeEventListener('pointerdown', outside, true);
    if (focus) trigger.focus();
  };
  const outside = event => { if (popup && !popup.contains(event.target) && !trigger.contains(event.target)) close(false); };
  const mark = (index, keyboard) => {
    const nodes = [...popup.children];
    active = nodes[index]?.getAttribute('aria-disabled') === 'true' ? -1 : index;
    nodes.forEach((node, i) => node.classList.toggle('active', i === active));
    nodes.forEach(node => node.classList.toggle('keyboard', keyboard));
    if (active >= 0) { trigger.setAttribute('aria-activedescendant', nodes[active].id); nodes[active].scrollIntoView({block:'nearest'}); }
    else trigger.removeAttribute('aria-activedescendant');
  };
  const commit = index => {
    const option = options()[index];
    if (!option || option.disabled) return;
    const changed = select.value !== option.value;
    select.value = option.value;
    refresh(); close();
    if (changed) { select.dispatchEvent(new Event('input', {bubbles:true})); select.dispatchEvent(new Event('change', {bubbles:true})); }
  };
  const open = (keyboard = false) => {
    if (popup || trigger.disabled) return;
    popup = el('div', {class:'choice-popup', id:popupId, role:'listbox', 'aria-label':label});
    options().forEach((option, index) => {
      const node = el('div', {class:'choice-option', id:`${popupId}-${index}`, role:'option', 'aria-selected':String(option.selected), 'aria-disabled':option.disabled ? 'true' : undefined, text:option.textContent});
      node.addEventListener('pointerdown', event => event.preventDefault());
      node.addEventListener('click', () => commit(index));
      node.addEventListener('pointermove', () => { if (active !== index) mark(index, false); });
      popup.append(node);
    });
    host(trigger).append(popup);
    const box = trigger.getBoundingClientRect();
    popup.style.minWidth = `${box.width}px`;
    popup.style.maxWidth = `${Math.max(box.width, 420)}px`;
    place(popup, trigger, {side:'below'});
    trigger.setAttribute('aria-expanded', 'true');
    const selected = select.selectedIndex;
    const initial = selected < 0 || options()[selected]?.disabled ? options().findIndex(option => !option.disabled) : selected;
    mark(initial, keyboard);
    addEventListener('pointerdown', outside, true);
  };
  const move = step => {
    const list = options();
    for (let index = active + step; index >= 0 && index < list.length; index += step) if (!list[index].disabled) { mark(index, true); return; }
  };
  trigger.addEventListener('click', () => popup ? close() : open());
  trigger.addEventListener('blur', () => setTimeout(() => { if (popup && !popup.contains(document.activeElement) && document.activeElement !== trigger) close(false); }));
  trigger.addEventListener('keydown', event => {
    const key = event.key;
    if (!popup) {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(key)) { event.preventDefault(); open(true); }
      return;
    }
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    else if (key === 'Tab') close(false);
    else if (key === 'Enter' || key === ' ') { event.preventDefault(); commit(active); }
    else if (key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (key === 'Home') { event.preventDefault(); active = -1; move(1); }
    else if (key === 'End') { event.preventDefault(); active = options().length; move(-1); }
    else if (key.length === 1) {
      const now = Date.now();
      typed = now - typedAt > 700 ? key.toLowerCase() : typed + key.toLowerCase();
      typedAt = now;
      const index = options().findIndex(option => !option.disabled && option.textContent.toLowerCase().startsWith(typed));
      if (index >= 0) mark(index, true);
    }
  });
  select.addEventListener('change', refresh);
  refresh();
  return {root, trigger, refresh, close};
}
