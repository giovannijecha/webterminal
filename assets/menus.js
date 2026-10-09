const $ = id => document.getElementById(id);

export class ApplicationMenus {
  constructor(actions) {
    this.actions = actions;
    this.anchor = null;
    for (const button of document.querySelectorAll('[data-menu]')) {
      button.addEventListener('click', () => this.toggle(button));
      button.addEventListener('pointerenter', () => { if (this.anchor) this.show(button); });
      button.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown') { event.preventDefault(); this.show(button); this.buttons()[0]?.focus(); }
      });
    }
    $('editor-more').addEventListener('click', () => this.toggle($('editor-more')));
    $('activity-settings').addEventListener('click', () => this.settings());
    $('preferences-close').addEventListener('click', () => $('preferences-dialog').close());
    document.addEventListener('pointerdown', event => {
      if (this.anchor && !event.target.closest('#application-menu,[data-menu],#editor-more')) this.close();
    });
    document.addEventListener('keydown', event => {
      if (!this.anchor || !['Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === 'Escape') { this.close(true); return; }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const anchors = [...document.querySelectorAll('[data-menu]')].filter(button => button.offsetWidth);
        const index = anchors.indexOf(this.anchor);
        if (index >= 0) this.show(anchors[(index + (event.key === 'ArrowRight' ? 1 : -1) + anchors.length) % anchors.length]);
        this.buttons()[0]?.focus();
        return;
      }
      const buttons = this.buttons();
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }, true);
    window.addEventListener('resize', () => this.close());
  }

  settings() {
    this.close();
    $('preferences-dialog').showModal();
    $('preferences-close').focus();
  }

  buttons() { return [...$('application-menu').querySelectorAll('button:not(:disabled)')]; }

  toggle(anchor) { if (this.anchor === anchor) this.close(true); else this.show(anchor); }

  show(anchor) {
    this.close();
    this.anchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    const fragment = document.createDocumentFragment();
    const menu = anchor.dataset.menu;
    for (const action of this.actions().filter(action => !menu || action.menus?.includes(menu))) {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.disabled = Boolean(action.disabled);
      const label = document.createElement('span');
      label.textContent = action.label.replace(/^[^:]+: /, '');
      button.append(label);
      if (action.shortcut) {
        const shortcut = document.createElement('kbd');
        shortcut.textContent = action.shortcut;
        button.append(shortcut);
      }
      button.addEventListener('click', () => {
        const current = this.actions().find(item => item.label === action.label);
        this.close();
        if (current && !current.disabled) current.run();
      });
      fragment.append(button);
    }
    const popup = $('application-menu');
    popup.replaceChildren(fragment);
    popup.hidden = false;
    const rect = anchor.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${Math.min(rect.bottom + 2, innerHeight - popup.offsetHeight - 8)}px`;
  }

  close(restoreFocus = false) {
    const anchor = this.anchor;
    this.anchor = null;
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
    $('application-menu').hidden = true;
    if (restoreFocus) anchor?.focus();
  }
}
