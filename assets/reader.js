// Reader: Markdown pasted or captured from the clipboard, kept in this
// browser tab's memory only. The list comes first; a document opens on its
// own with copy, find, outline and its exact source.
import {$, ago, clock, el, icon, plural} from './dom.js';
import {renderMarkdown} from './markdown.js';
import {ClipboardFollower, Documents, clipboardSource, filterDocuments, meaningful} from './documents.js';
import {changed, go, noteCopied, sessionShell, showTerminal, state, subscribe, terminalName, workspaceLabel, workspaceOf} from './model.js';
import {dialogs, menu, notify, problem} from './ui.js';

const MATCH_LIMIT = 2000, FOLLOW_INTERVAL = 1000;
const TOPICS = ['page', 'documents', 'sessions', 'connection'];
const FILTERS = [['all', 'All'], ['unread', 'Unread']];
const docs = new Documents();
const view = {panel:'list', key:null, query:'', filter:'all', target:undefined, nodes:null, rendered:'', listScroll:0};
const find = {open:false, ranges:[], index:-1};
let poll = 0;

// Terminal names are recorded while terminals exist, so a copy keeps
// naming its source after that terminal closes.
function rememberPlaces() {
  for (const [id, session] of state.sessions) docs.remember(id, {name:terminalName(id), workspace:workspaceLabel(workspaceOf(id)), shell:sessionShell(session)});
}
subscribe(topics => { if (topics.has('sessions')) rememberPlaces(); });
rememberPlaces();

const all = () => docs.list();
const current = () => (view.key && docs.find(view.key)) || null;

function origin(doc) {
  if (doc.kind === 'pasted' || doc.kind === 'clipboard') {
    const label = doc.kind === 'pasted' ? 'Pasted' : 'Clipboard';
    return {label, line:label, id:null, live:false};
  }
  // Only OSC 52 copies name a terminal.
  const live = state.sessions.has(doc.id), place = docs.place(doc.id);
  const name = live ? terminalName(doc.id) : place?.name;
  const shell = doc.shell || place?.shell || '';
  const terminal = live ? name : name ? `Closed terminal ${name}` : 'Closed terminal';
  const workspace = live ? workspaceLabel(workspaceOf(doc.id)) : place?.workspace || '';
  return {label:'Copied from a terminal', shell, terminal, workspace, id:doc.id, live, line:[`Copied from ${shell || 'a terminal'}`, terminal, workspace].filter(Boolean).join(' · ')};
}

function markRead(doc, read) {
  if (doc.read !== read) changed('documents');
  doc.read = read;
}

// Sources
function addPasted(text) {
  const {doc, added} = docs.add(text, {kind:'pasted'});
  if (!doc) { problem('Nothing to add', 'Paste some text before adding a document.'); return; }
  follower.saw(text);
  open(doc.key);
  if (!added) notify('Already in Reader', 'The same text was already here, so it opened instead.', null, 'reader');
}

async function pasteFromClipboard() {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { pasteDialog('The browser did not allow reading the clipboard. Paste with Ctrl+V below instead.'); return; }
  if (text.trim()) addPasted(text);
  else pasteDialog('The clipboard has no text. Paste or type Markdown below.');
}

function pasteDialog(reason) {
  const field = el('textarea', {class:'field reader-paste-input', id:'reader-paste-input', rows:8, placeholder:'# Document title\n\nPaste Markdown here.', 'aria-describedby':'reader-paste-help'});
  const body = el('div', {class:'reader-paste-fields'}, el('p', {class:'help', text:reason}), el('label', {}, el('span', {class:'lbl', text:'Document'}), field), el('p', {class:'help', id:'reader-paste-help', text:'The first heading or line becomes the title.'}));
  dialogs.show({title:'Paste Markdown', description:'Add a document to this browser tab.', body, initial:field, action:'Add document', onSubmit:() => {
    if (!field.value.trim()) return 'Paste some text before adding a document.';
    addPasted(field.value);
    return true;
  }});
}

function pasted(event) {
  if (event.target.closest('input, textarea, [contenteditable]') || dialogs.current) return;
  const text = event.clipboardData?.getData('text/plain') || '';
  if (!text.trim()) return;
  event.preventDefault();
  addPasted(text);
}

// Clipboard following: opt-in, and the clipboard is read only while this
// tab is visible and focused.
const follower = new ClipboardFollower({
  read:() => navigator.clipboard.readText(),
  focused:() => document.visibilityState === 'visible' && document.hasFocus(),
  capture,
  denied:() => {
    stopFollowing();
    problem('Stopped following the clipboard', 'The browser no longer allows clipboard access. Allow it for this site, then turn Follow clipboard on again.', null, 'reader-follow');
  },
});
addEventListener('focus', () => follower.check());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') follower.check(); });

function capture(text) {
  if (!meaningful(text)) return;
  const source = clipboardSource(text, state.copies);
  if (!source) return;
  const session = source.id && state.sessions.get(source.id);
  const {doc, added} = docs.add(text, {kind:source.kind, id:source.id, shell:session ? sessionShell(session) : ''});
  if (!added) return;
  changed('documents');
  if (state.page !== 'reader') notify('Saved to Reader', doc.title, {label:'Read', run:() => go('reader', {doc:doc.key})}, `reader:${doc.key}`);
}

async function toggleFollow() {
  if (follower.enabled) {
    stopFollowing();
    notify('Stopped following the clipboard', 'Copied text is no longer saved to Reader.', null, 'reader-follow');
    return;
  }
  try {
    if (!await follower.enable()) return;
  } catch {
    problem('Clipboard access blocked', 'The browser did not allow reading the clipboard, so Follow clipboard stays off. Allow clipboard access for this site, then try again.', null, 'reader-follow');
    return;
  }
  clearInterval(poll);
  poll = setInterval(() => follower.check(), FOLLOW_INTERVAL);
  paintActions();
  notify('Following the clipboard', 'While this tab is focused, Markdown you copy is saved here. Nothing is read in the background.', null, 'reader-follow');
}
function stopFollowing() {
  follower.disable();
  clearInterval(poll);
  poll = 0;
  paintActions();
}

// Document actions
async function copyText(text, title, detail) {
  try {
    await navigator.clipboard.writeText(text);
    noteCopied(text);
    follower.saw(text);
    notify(title, detail, null, 'reader-copy');
  } catch {
    const field = el('textarea', {class:'field reader-paste-input', readonly:true, rows:8, 'aria-label':'Text to copy', value:text, onfocus:event => event.target.select()});
    dialogs.show({title:'Copy this text', description:'Clipboard access is unavailable here. Select the text and copy it.', body:field, initial:field, action:'Done', cancel:false});
  }
}

function remove(doc) {
  const wasRead = doc.read, undo = docs.remove(doc);
  markRead(doc, true);
  if (view.key === doc.key) back(false);
  changed('documents');
  notify('Document removed', doc.title, {label:'Undo', run:() => {
    docs.restore(undo);
    markRead(doc, wasRead);
    changed('documents');
  }}, `reader-remove:${doc.key}`);
}

function sourceDetails(doc) {
  const source = origin(doc), lines = doc.text.split('\n').length;
  const fact = (label, value) => value ? [el('dt', {text:label}), el('dd', {text:value})] : null;
  dialogs.show({title:'Document source', description:doc.title, action:'Done', cancel:false, body:el('dl', {class:'facts'},
    fact('Source', source.label), fact('Shell', source.shell), fact('Terminal', source.terminal), fact('Workspace', source.workspace),
    fact('Added', `${clock(doc.at)} · ${ago(doc.at)}`), fact('Length', `${plural(lines, 'line')} · ${plural(doc.text.length, 'character')}`),
    fact('Kept', 'In this browser tab only, until it reloads.'))});
}

function open(key, focus = true) {
  const doc = docs.find(key);
  if (!doc) return false;
  if (view.panel === 'list' && view.nodes) view.listScroll = view.nodes.scroll.scrollTop;
  view.key = key;
  view.panel = 'detail';
  markRead(doc, true);
  paint();
  if (focus) view.nodes.title.focus({preventScroll:true});
  return true;
}

function back(focus = true) {
  const key = view.key;
  view.panel = 'list';
  view.key = null;
  closeFind();
  paint();
  view.nodes.scroll.scrollTop = view.listScroll;
  if (focus) (view.nodes.list.querySelector(`[data-key="${CSS.escape(key || '')}"] button`) || view.nodes.search).focus({preventScroll:true});
}

function optionItems() {
  const list = all(), unread = list.filter(doc => !doc.read);
  return [
    {label:'Search documents', icon:'search', action:() => { if (view.panel !== 'list') back(false); view.nodes.search.focus(); }},
    {label:'Mark all as read', icon:'check', disabled:!unread.length, action:() => { unread.forEach(doc => markRead(doc, true)); changed('documents'); }},
    {separator:true},
    {label:'Follow clipboard', icon:'clipboard-paste', checked:follower.enabled, hint:follower.enabled ? 'On' : 'Off', action:toggleFollow},
  ];
}

function documentItems(doc) {
  const headings = [...view.nodes.prose.querySelectorAll('h1, h2, h3')];
  return [
    {label:'Find in document', icon:'text-search', action:openFind},
    {label:'On this page', icon:'outline', disabled:!headings.length, hint:headings.length ? undefined : 'No headings', submenu:() => headings.map(heading => ({label:heading.textContent || 'Untitled', action:() => reveal(heading)}))},
    {label:doc.read ? 'Mark as unread' : 'Mark as read', icon:'eye', action:() => { markRead(doc, !doc.read); if (!doc.read) back(); else paint(); }},
    {label:'Source details', icon:'info', action:() => sourceDetails(doc)},
    {separator:true},
    {label:'Remove document', icon:'square-x', danger:true, action:() => remove(doc)},
  ];
}

function reveal(node) {
  node.setAttribute('tabindex', '-1');
  node.scrollIntoView({block:'start', behavior:matchMedia('(prefers-reduced-motion:reduce)').matches ? 'auto' : 'smooth'});
  node.focus({preventScroll:true});
}

// Find in document, highlighted with the CSS Custom Highlight API so the
// rendered document is never modified.
function openFind() {
  find.open = true;
  view.nodes.tools.hidden = false;
  view.nodes.findInput.focus();
  view.nodes.findInput.select();
}
function closeFind(focus = false) {
  find.open = false;
  if (!view.nodes) return;
  view.nodes.tools.hidden = true;
  view.nodes.findInput.value = '';
  clearHighlights();
  view.nodes.count.textContent = '';
  if (focus) view.nodes.title.focus();
}
function clearHighlights() {
  find.ranges = [];
  find.index = -1;
  CSS.highlights?.delete('reader-match');
  CSS.highlights?.delete('reader-current');
}
function findMatches() {
  clearHighlights();
  const query = view.nodes.findInput.value.toLowerCase();
  if (!query.trim()) { view.nodes.count.textContent = ''; return; }
  const walker = document.createTreeWalker(view.nodes.prose, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && find.ranges.length < MATCH_LIMIT; node = walker.nextNode()) {
    if (node.parentElement.closest('.md-code-bar')) continue;
    const text = node.data.toLowerCase();
    if (text.length !== node.data.length) continue;
    for (let index = text.indexOf(query); index >= 0 && find.ranges.length < MATCH_LIMIT; index = text.indexOf(query, index + query.length)) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      find.ranges.push(range);
    }
  }
  if (globalThis.Highlight && find.ranges.length) CSS.highlights.set('reader-match', new Highlight(...find.ranges));
  if (find.ranges.length) step(1);
  else view.nodes.count.textContent = 'No matches';
}
function step(direction) {
  if (!find.ranges.length) return;
  find.index = (find.index + direction + find.ranges.length) % find.ranges.length;
  const range = find.ranges[find.index], article = view.nodes.article;
  if (globalThis.Highlight) CSS.highlights.set('reader-current', new Highlight(range));
  view.nodes.count.textContent = `${find.index + 1} of ${find.ranges.length}${find.ranges.length === MATCH_LIMIT ? '+' : ''}`;
  const rect = range.getBoundingClientRect(), frame = article.getBoundingClientRect();
  if (rect.top < frame.top + 8 || rect.bottom > frame.bottom - 8) article.scrollTop += rect.top - frame.top - article.clientHeight / 3;
}

// Rendering
function iconButton(name, label, extra = {}) {
  return el('button', {class:'icon-btn', type:'button', 'aria-label':label, title:label, ...extra}, icon(name));
}
function labelled(name, label, text, cls = 'btn sm') {
  return el('button', {class:cls, type:'button', 'aria-label':label, title:label}, icon(name), el('span', {class:'reader-action-label', text}));
}

function build() {
  $('reader-content').classList.add('reader-content');
  const paste = labelled('clipboard-paste', 'Paste Markdown', 'Paste', 'btn');
  paste.addEventListener('click', pasteFromClipboard);
  const options = iconButton('ellipsis', 'Reader options', {'aria-haspopup':'menu', 'aria-expanded':'false'});
  options.addEventListener('click', () => menu.toggle(options, optionItems, {label:'Reader options'}));
  const following = el('span', {class:'status-badge reader-following', title:'Following clipboard', hidden:true}, el('span', {class:'status-label', text:'Following clipboard'}));
  $('reader-actions').replaceChildren(following, paste, options);

  const search = el('input', {class:'field', type:'search', id:'reader-search', placeholder:'Search documents', autocomplete:'off', 'aria-label':'Search documents', value:view.query});
  search.addEventListener('input', () => { view.query = search.value; paint(); });
  const filters = el('div', {class:'segment reader-filter', role:'group', 'aria-label':'Show documents'},
    FILTERS.map(([key, label]) => el('button', {class:'btn sm', type:'button', dataset:{filter:key}, 'aria-pressed':String(view.filter === key)}, el('span', {text:label}), el('span', {class:'reader-count', dataset:{count:key}}))));
  filters.addEventListener('click', event => {
    const key = event.target.closest('[data-filter]')?.dataset.filter;
    if (key) { view.filter = key; paint(); }
  });
  const summary = el('p', {class:'reader-summary', role:'status'});
  const list = el('ul', {class:'reader-index', 'aria-label':'Documents'});
  list.addEventListener('click', event => { const key = event.target.closest('[data-key]')?.dataset.key; if (key) open(key); });
  const empty = el('div', {class:'state reader-empty', hidden:true});
  const scroll = el('div', {class:'reader-index-scroll'}, list, empty);
  const collection = el('section', {class:'reader-collection', 'aria-label':'Documents'},
    el('div', {class:'reader-collection-tools'}, el('label', {class:'search-field reader-search'}, icon('search'), search), el('div', {class:'reader-tools-row'}, filters, summary)), scroll);

  const backButton = el('button', {class:'btn sm ghost reader-back', type:'button'}, icon('chevron-left'), 'All documents');
  backButton.addEventListener('click', () => back());
  const title = el('h2', {class:'reader-document-title', id:'reader-document-title', tabindex:'-1'});
  const openTerminal = labelled('square-terminal', 'Open terminal', 'Open terminal');
  openTerminal.addEventListener('click', () => { const doc = current(); if (doc?.id && state.sessions.has(doc.id)) showTerminal(doc.id); });
  const copy = labelled('copy', 'Copy Markdown', 'Copy');
  copy.addEventListener('click', () => { const doc = current(); if (doc) copyText(doc.text, 'Copied as Markdown', doc.title); });
  const more = iconButton('ellipsis', 'Document actions', {'aria-haspopup':'menu', 'aria-expanded':'false'});
  more.addEventListener('click', () => { const doc = current(); if (doc) menu.toggle(more, () => documentItems(doc), {label:'Document actions'}); });
  const caption = el('p', {class:'reader-document-caption'});

  const findInput = el('input', {class:'field', type:'search', id:'reader-find', placeholder:'Find in document', autocomplete:'off', 'aria-label':'Find in document'});
  findInput.addEventListener('input', findMatches);
  findInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeFind(true); }
  });
  const count = el('output', {class:'reader-find-count', 'aria-live':'polite'});
  const previous = iconButton('chevron-down', 'Previous match', {class:'icon-btn ghost reader-previous'});
  const next = iconButton('chevron-down', 'Next match', {class:'icon-btn ghost'});
  const closeButton = iconButton('x', 'Close find', {class:'icon-btn ghost'});
  previous.addEventListener('click', () => step(-1));
  next.addEventListener('click', () => step(1));
  closeButton.addEventListener('click', () => closeFind(true));
  const tools = el('div', {class:'reader-document-tools', hidden:true}, el('label', {class:'search-field reader-find-field'}, icon('text-search'), findInput), el('div', {class:'reader-find-actions'}, count, previous, next, closeButton));
  const prose = el('div', {class:'reader-prose'});
  prose.addEventListener('click', event => {
    const button = event.target.closest('.reader-code-copy');
    if (!button) return;
    const block = button.closest('.md-code');
    copyText(block.querySelector('code').textContent, 'Block copied', block.querySelector('.md-code-language')?.textContent || '');
  });
  const article = el('div', {class:'reader-article', tabindex:'0', 'aria-label':'Document content'}, prose);
  const detail = el('section', {class:'reader-detail', 'aria-labelledby':'reader-document-title'},
    el('div', {class:'reader-detail-header'}, backButton, el('div', {class:'reader-title-row'}, title, el('div', {class:'reader-document-actions'}, openTerminal, copy, more)), caption),
    tools, article);
  detail.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.target.closest('input')) { event.preventDefault(); back(); }
  });
  const root = el('div', {class:'reader-root', dataset:{panel:view.panel}}, collection, detail);
  $('reader-content').replaceChildren(root);
  $('page-reader').addEventListener('paste', pasted);
  view.nodes = {root, following, search, filters, summary, list, empty, scroll, title, openTerminal, caption, tools, findInput, count, prose, article};
}

function paintActions() {
  if (!view.nodes) return;
  view.nodes.following.hidden = !follower.enabled;
}

function rowNode(doc) {
  const source = origin(doc);
  return el('li', {dataset:{key:doc.key}}, el('button', {class:'reader-item', type:'button', dataset:{key:doc.key, read:String(doc.read)}},
    el('span', {class:'reader-item-top'}, el('b', {text:doc.title}), doc.read ? null : el('span', {class:'reader-read-label', text:'Unread'})),
    el('span', {class:'reader-item-source', text:`${source.line} · ${ago(doc.at)}`})));
}

function paintList(list) {
  const {filters, summary, empty, scroll} = view.nodes, unread = list.filter(doc => !doc.read).length;
  const visible = filterDocuments(list, {query:view.query, filter:view.filter});
  for (const button of filters.querySelectorAll('[data-filter]')) {
    const key = button.dataset.filter, count = key === 'unread' ? unread : list.length;
    button.setAttribute('aria-pressed', String(view.filter === key));
    text(button.querySelector('[data-count]'), String(count));
  }
  text(summary, visible.length === list.length ? plural(list.length, 'document') : `${visible.length} of ${plural(list.length, 'document')}`);
  const target = view.nodes.list, focus = document.activeElement, focusKey = target.contains(focus) ? focus.dataset.key : null;
  const existing = new Map([...target.children].map(node => [node.dataset.key, node]));
  const wanted = visible.map(doc => {
    const sig = `${doc.title}\u0001${doc.read}\u0001${origin(doc).line}\u0001${ago(doc.at)}`;
    let node = existing.get(doc.key);
    if (node?.dataset.sig === sig) return node;
    const fresh = rowNode(doc);
    fresh.dataset.sig = sig;
    if (node) node.replaceWith(fresh);
    return fresh;
  });
  wanted.forEach((node, index) => { if (target.children[index] !== node) target.insertBefore(node, target.children[index] || null); });
  for (const node of [...target.children].slice(wanted.length)) node.remove();
  if (focusKey && !focus.isConnected) target.querySelector(`[data-key="${CSS.escape(focusKey)}"] button`)?.focus({preventScroll:true});
  scroll.dataset.empty = String(!visible.length);
  empty.hidden = Boolean(visible.length);
  if (!visible.length) paintEmpty(list.length);
}

function paintEmpty(total) {
  const {empty} = view.nodes, key = total ? `none:${view.filter}:${view.query}` : 'empty';
  if (empty.dataset.key === key) return;
  empty.dataset.key = key;
  if (!total) {
    const paste = el('button', {class:'btn primary', type:'button', text:'Paste Markdown'});
    paste.addEventListener('click', pasteFromClipboard);
    empty.replaceChildren(el('h2', {text:'No documents yet'}), el('p', {text:'Paste Markdown to read it here, or follow the clipboard to keep what you copy. Documents stay in this browser tab.'}), paste);
    return;
  }
  const clear = el('button', {class:'btn', type:'button', text:view.query ? 'Clear search' : 'Show all documents'});
  clear.addEventListener('click', () => { view.query = ''; view.filter = 'all'; view.nodes.search.value = ''; paint(); view.nodes.search.focus(); });
  empty.replaceChildren(el('h2', {text:view.query ? 'No matching documents' : 'No unread documents'}), el('p', {text:view.query ? `Nothing matches “${view.query.trim()}”.` : 'Everything here has been read.'}), clear);
}

function paintDocument(doc) {
  const {title, openTerminal, caption, prose, article} = view.nodes, source = origin(doc);
  text(title, doc.title);
  openTerminal.hidden = !source.live;
  text(caption, `${source.line} · ${clock(doc.at)} · ${ago(doc.at)}`);
  const key = `${doc.key}\u0001${doc.text.length}`;
  if (view.rendered === key) return;
  view.rendered = key;
  closeFind();
  prose.replaceChildren(renderMarkdown(doc.text));
  for (const bar of prose.querySelectorAll('.md-code-bar')) bar.append(el('button', {class:'btn ghost sm reader-code-copy', type:'button'}, icon('copy'), 'Copy code'));
  article.scrollTop = 0;
}

function paint() {
  if (!view.nodes) build();
  const list = all(), doc = view.panel === 'detail' ? current() : null;
  if (view.panel === 'detail' && !doc) { view.panel = 'list'; view.key = null; closeFind(); }
  view.nodes.root.dataset.panel = view.panel;
  paintActions();
  paintList(list);
  if (doc) paintDocument(doc);
  else view.rendered = '';
}

// Unchanged text is left alone so live regions do not announce it again.
function text(node, value) { if (node.textContent !== value) node.textContent = value; }

function apply(target) {
  view.target = target;
  const key = target?.doc;
  if (!key) return;
  if (open(key, false)) return;
  view.panel = 'list';
  view.key = null;
  notify('Document not available', 'It was removed or replaced by newer documents.', null, 'reader');
}

export function show(target) {
  if (!view.nodes) build();
  apply(target);
}

export function render(topics) {
  if (topics.has('page') && state.target !== view.target) apply(state.target);
  if (TOPICS.some(topic => topics.has(topic))) paint();
}
