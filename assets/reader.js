import {icon} from './common.js';
import {markdownTitle, renderMarkdown} from './markdown.js';

const $ = id => document.getElementById(id);
const DOCUMENT_LIMIT = 20, TEXT_LIMIT = 512 * 1024, MATCH_LIMIT = 2000;
const FOLLOW_KEY = 'webterminal.reader.follow';
// Agents such as Codex and Claude write /copy straight to the system clipboard,
// so a followed clipboard is read about once a second while this page is focused.
const FOLLOW_INTERVAL = 900;

// Short single-line copies (paths, commands, tokens) are not documents;
// a long sentence or several lines are.
function meaningful(text) {
  const value = text.trim();
  return value.length >= 24 && (/\n\s*\S/.test(value) || /(^|\s)(#{1,6} |[-*] |\d+\. |```|\*\*)/.test(value) || value.split(/\s+/).length >= 12);
}

function when(time) {
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(time).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

function button(className, label, iconName, text) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.title = label;
  if (!text) node.setAttribute('aria-label', label);
  node.append(icon(iconName));
  if (text) { const span = document.createElement('span'); span.textContent = text; node.append(span); }
  return node;
}

// Markdown documents captured from terminals or the clipboard. They live in
// this browser tab's memory only and disappear on reload.
export class Reader {
  constructor({notify}) {
    Object.assign(this, {notify, documents:[], current:null, rendered:null, view:'read', unread:0, ignored:[], seen:null, follow:false, followGeneration:0, reading:false, ranges:[], match:-1, counter:0});
    try { this.follow = localStorage.getItem(FOLLOW_KEY) === 'on'; } catch { /* Off by default. */ }
    $('reader-toggle').addEventListener('click', () => this.toggle());
    $('reader-close').addEventListener('click', () => this.toggle(false));
    $('reader-back').addEventListener('click', () => { this.view = 'list'; this.render(); });
    $('reader-paste').addEventListener('click', () => this.paste());
    $('reader-empty-paste').addEventListener('click', () => this.paste());
    $('reader-follow').addEventListener('click', () => this.setFollow(!this.follow));
    $('reader-copy').addEventListener('click', () => this.copy(this.current?.text, $('reader-copy')));
    $('reader-outline-toggle').addEventListener('click', () => this.showOutline($('reader-outline').hidden));
    $('reader-search').addEventListener('input', () => this.search());
    $('reader-search').addEventListener('keydown', event => this.searchKey(event));
    $('reader-prev').addEventListener('click', () => this.step(-1));
    $('reader-next').addEventListener('click', () => this.step(1));
    $('reader').addEventListener('paste', event => this.pasted(event));
    window.addEventListener('focus', () => this.check());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) this.check(); });
    setInterval(() => this.check(), FOLLOW_INTERVAL);
    this.render();
  }

  get open() { return !$('reader').hidden; }

  toggle(open = !this.open, focus = true) {
    if (open === this.open) return;
    $('reader').hidden = !open;
    $('app').classList.toggle('reader-open', open);
    $('reader-toggle').setAttribute('aria-pressed', String(open));
    if (open) {
      this.unread = 0;
      this.render();
      this.check();
      if (focus) $('reader-body').focus({preventScroll:true});
    } else {
      this.clearHighlights();
      this.badge();
      $('reader-toggle').focus();
    }
  }

  // Terminal copies (OSC 52) become documents only when they look like prose.
  capture(text, source) { if (meaningful(text)) this.add(text, source); }

  // Text Webterminal itself put on the clipboard is not a new document.
  ignore(text) { if (text) this.ignored = [text, ...this.ignored.filter(item => item !== text)].slice(0, 8); }

  add(text, source) {
    let value = text.replace(/\r\n?/g, '\n');
    if (!value.trim()) return;
    if (value.length > TEXT_LIMIT) value = `${value.slice(0, TEXT_LIMIT)}\n\n*Truncated at 512 KiB.*`;
    const existing = this.documents.find(item => item.text === value);
    if (existing && existing === this.documents[0] && existing === this.current) { if (!this.open) return; this.view = 'read'; this.render(); return; }
    this.documents = this.documents.filter(item => item !== existing);
    const doc = existing || {id:++this.counter, text:value, title:markdownTitle(value), source};
    doc.time = Date.now();
    this.documents.unshift(doc);
    this.documents.length = Math.min(this.documents.length, DOCUMENT_LIMIT);
    this.current = doc;
    this.view = 'read';
    if (!this.open) this.unread++;
    this.render();
  }

  async paste() {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) { this.notify('The clipboard has no text.'); return; }
      this.seen = text;
      this.add(text, 'Pasted');
    } catch { this.notify('The browser blocked clipboard access. Press Ctrl+V in the Reader instead.', 'warning'); }
  }

  pasted(event) {
    if (event.target.closest('input')) return;
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!text.trim()) return;
    event.preventDefault();
    this.seen = text;
    this.add(text, 'Pasted');
  }

  async setFollow(on) {
    const generation = ++this.followGeneration;
    if (on) {
      // Reading inside the click lets the browser ask for permission once.
      try {
        const text = await navigator.clipboard.readText();
        if (generation !== this.followGeneration) return;
        this.seen = text;
      } catch {
        if (generation === this.followGeneration) this.notify('The browser blocked clipboard access. Allow it in the site settings to follow the clipboard.', 'warning');
        return;
      }
    }
    this.follow = on;
    try { localStorage.setItem(FOLLOW_KEY, on ? 'on' : 'off'); } catch { /* This view only. */ }
    this.render();
  }

  async check() {
    if (!this.follow || this.reading || !document.hasFocus()) return;
    const generation = this.followGeneration;
    this.reading = true;
    try {
      const text = await navigator.clipboard.readText();
      if (generation !== this.followGeneration || !this.follow) return;
      if (!document.hasFocus()) { this.seen = text; return; }
      if (text === this.seen) return;
      // The first read after a reload only records what was already there.
      const primed = this.seen !== null;
      this.seen = text;
      if (!primed || this.ignored.includes(text) || !meaningful(text)) return;
      this.add(text, 'Clipboard');
      // Followed copies open the Reader beside the terminal without taking its focus.
      this.toggle(true, false);
    } catch { /* Not focused or permission withdrawn; the switch stays as chosen. */ }
    finally { this.reading = false; }
  }

  async copy(text, control) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.ignore(text);
      this.seen = text;
      const label = control.querySelector('span');
      if (label) { label.textContent = 'Copied'; setTimeout(() => { label.textContent = control.dataset.label; }, 1200); }
      else this.notify('Copied Markdown.');
    } catch { this.notify('Clipboard access was denied by the browser.', 'error'); }
  }

  badge() {
    const badge = $('reader-badge');
    badge.hidden = !this.unread;
    badge.textContent = this.unread > 9 ? '9+' : String(this.unread);
    $('reader-toggle').title = this.unread ? `Reader · ${this.unread} new` : 'Reader — Markdown copied from your terminals';
  }

  render() {
    const current = this.documents.includes(this.current) ? this.current : this.documents[0] || null;
    this.current = current;
    const view = current ? this.view : 'empty';
    $('reader').dataset.view = view;
    $('reader-back').hidden = view !== 'read';
    $('reader-tools').hidden = view !== 'read';
    $('reader-article').hidden = view !== 'read';
    $('reader-list').hidden = view !== 'list';
    $('reader-empty').hidden = view !== 'empty';
    if (view !== 'read') this.showOutline(false);
    $('reader-title').textContent = view === 'read' ? current.title : view === 'list' ? 'Documents' : 'Reader';
    $('reader-meta').textContent = view === 'read' ? `${current.source} · ${when(current.time)}` : view === 'list' ? `${this.documents.length} of ${DOCUMENT_LIMIT} · kept until reload` : 'Markdown from your agents';
    if (view === 'read' && this.rendered !== current) this.renderDocument(current);
    if (view === 'list') this.renderList();
    if (view !== 'read') this.rendered = null;
    const follow = $('reader-follow');
    follow.setAttribute('aria-checked', String(this.follow));
    $('reader-status').textContent = this.follow ? 'Copied replies open here' : 'Off';
    this.badge();
  }

  renderDocument(doc) {
    this.rendered = doc;
    this.clearHighlights();
    $('reader-search').value = '';
    $('reader-count').textContent = '';
    $('reader-article').replaceChildren(renderMarkdown(doc.text));
    for (const block of $('reader-article').querySelectorAll('.md-code')) {
      const copy = button('md-copy', 'Copy code', 'copy', 'Copy');
      copy.dataset.label = 'Copy';
      copy.addEventListener('click', () => this.copy(block.querySelector('code').textContent, copy));
      block.firstChild.append(copy);
    }
    const headings = [...$('reader-article').querySelectorAll('h1,h2,h3')];
    $('reader-outline-toggle').hidden = headings.length < 2;
    $('reader-outline').replaceChildren(...headings.map(heading => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = `outline-item level-${heading.tagName[1]}`;
      item.textContent = heading.textContent;
      item.addEventListener('click', () => {
        heading.scrollIntoView({block:'start', behavior:matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth'});
        if (matchMedia('(max-width:760px)').matches) this.showOutline(false);
      });
      return item;
    }));
    $('reader-body').scrollTop = 0;
  }

  renderList() {
    $('reader-list').replaceChildren(...this.documents.map(doc => {
      const item = document.createElement('li');
      item.className = `reader-item${doc === this.current ? ' current' : ''}`;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'reader-open';
      const title = document.createElement('span');
      title.className = 'reader-item-title';
      title.textContent = doc.title;
      const meta = document.createElement('span');
      meta.className = 'reader-item-meta';
      const lines = doc.text.split('\n').length;
      meta.textContent = `${doc.source} · ${when(doc.time)} · ${lines} line${lines === 1 ? '' : 's'}`;
      open.append(title, meta);
      open.addEventListener('click', () => { this.current = doc; this.view = 'read'; this.render(); $('reader-body').focus({preventScroll:true}); });
      const remove = button('icon-button reader-remove', `Remove ${doc.title}`, 'close');
      remove.addEventListener('click', () => { this.documents = this.documents.filter(item => item !== doc); this.render(); $('reader-body').focus({preventScroll:true}); });
      item.append(open, remove);
      return item;
    }));
  }

  showOutline(open) {
    $('reader-outline').hidden = !open;
    $('reader-outline-toggle').setAttribute('aria-expanded', String(open));
  }

  clearHighlights() {
    this.ranges = [];
    this.match = -1;
    CSS.highlights?.delete('reader-match');
    CSS.highlights?.delete('reader-current');
  }

  search() {
    this.clearHighlights();
    const query = $('reader-search').value.toLowerCase();
    if (!query.trim()) { $('reader-count').textContent = ''; return; }
    const walker = document.createTreeWalker($('reader-article'), NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && this.ranges.length < MATCH_LIMIT; node = walker.nextNode()) {
      const text = node.data.toLowerCase();
      if (text.length !== node.data.length) continue;
      for (let index = text.indexOf(query); index >= 0 && this.ranges.length < MATCH_LIMIT; index = text.indexOf(query, index + query.length)) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + query.length);
        this.ranges.push(range);
      }
    }
    if (globalThis.Highlight && this.ranges.length) CSS.highlights.set('reader-match', new Highlight(...this.ranges));
    if (this.ranges.length) this.step(1); else $('reader-count').textContent = 'No matches';
  }

  step(direction) {
    if (!this.ranges.length) return;
    this.match = (this.match + direction + this.ranges.length) % this.ranges.length;
    const range = this.ranges[this.match];
    if (globalThis.Highlight) CSS.highlights.set('reader-current', new Highlight(range));
    $('reader-count').textContent = `${this.match + 1} / ${this.ranges.length}`;
    const body = $('reader-body'), rect = range.getBoundingClientRect(), frame = body.getBoundingClientRect();
    if (rect.top < frame.top + 8 || rect.bottom > frame.bottom - 8) body.scrollTop += rect.top - frame.top - body.clientHeight / 3;
  }

  searchKey(event) {
    if (event.key === 'Enter') { event.preventDefault(); this.step(event.shiftKey ? -1 : 1); }
    else if (event.key === 'Escape' && event.target.value) { event.preventDefault(); event.stopPropagation(); event.target.value = ''; this.search(); }
  }
}
