const $ = id => document.getElementById(id);

export class NoticeCenter {
  constructor() {
    this.queue = [];
    this.current = null;
    this.timer = 0;
    $('toast-close').addEventListener('click', () => this.dismiss());
    for (const id of ['notice-cancel', 'notice-dismiss']) $(id).addEventListener('click', () => this.finish(false));
    $('notice-confirm').addEventListener('click', () => this.finish(true));
    $('notice-dialog').addEventListener('cancel', event => { event.preventDefault(); this.finish(false); });
    $('notice-dialog').addEventListener('close', () => { if (this.current && !$('notice-dialog').open) this.finish(false); });
  }

  notify(message, kind = 'info') {
    clearTimeout(this.timer);
    $('toast').className = `toast ${kind}`;
    $('toast-message').textContent = message;
    $('toast-icon').querySelector('use').setAttribute('href', `#icon-${kind === 'error' ? 'error' : kind === 'warning' ? 'warning' : 'info'}`);
    $('toast').setAttribute('role', kind === 'error' ? 'alert' : 'status');
    $('toast').setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    $('toast').hidden = false;
    // Errors remain available until dismissed; ordinary notices expire.
    if (kind !== 'error') this.timer = setTimeout(() => this.dismiss(), 6000);
  }

  dismiss() {
    clearTimeout(this.timer);
    $('toast').hidden = true;
  }

  ask(options) {
    if (this.queue.length >= 8) return Promise.resolve(false);
    return new Promise(resolve => {
      this.queue.push({...options, resolve});
      this.showNext();
    });
  }

  showNext() {
    if (this.current || !this.queue.length) return;
    this.current = this.queue.shift();
    const {kind = 'close', heading, description, details = [], confirm} = this.current;
    $('notice-dialog').className = `notice-dialog ${kind}`;
    $('notice-heading').textContent = heading;
    $('notice-description').textContent = description;
    $('notice-confirm').textContent = confirm;
    $('notice-icon').querySelector('use').setAttribute('href', `#icon-${kind === 'clipboard' ? 'copy' : 'warning'}`);
    const fragment = document.createDocumentFragment();
    for (const [label, value] of details) {
      const term = document.createElement('dt');
      const data = document.createElement('dd');
      term.textContent = label;
      data.textContent = value;
      fragment.append(term, data);
    }
    $('notice-details').replaceChildren(fragment);
    $('notice-dialog').showModal();
    $('notice-cancel').focus();
  }

  finish(accepted) {
    const pending = this.current;
    if (!pending) return;
    this.current = null;
    if ($('notice-dialog').open) $('notice-dialog').close();
    pending.resolve(accepted);
    queueMicrotask(() => this.showNext());
  }
}
