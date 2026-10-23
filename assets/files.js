// Dropped files: the staged copies the server keeps for each terminal plus
// this view's uploads in flight or failed. Each row carries its one direct
// action; selecting a row opens its details beside the list.
import {$, ago, avatar, badge, bytes, clock, el, icon, pathText, plural} from './dom.js';
import {changed, control, showTerminal, state, terminalName, workspaceIndex, workspaceLabel, workspaceOf} from './model.js';
import {ask} from './connection.js';
import {dialogs, notify, problem} from './ui.js';
import {cancelUpload, dismissUpload, forgetCopy, retryUpload, transfers} from './transfers.js';

const FILTERS = [['all', 'All'], ['staged', 'Staged'], ['uploading', 'Uploading'], ['failed', 'Failed']];
const TOPICS = ['page', 'files', 'transfers', 'sessions', 'connection'];
const view = {filter:'all', query:'', selected:null, target:undefined, nodes:null, rows:new Map(), removed:new Set()};

const stagedRow = copy => ({key:`c:${copy.id}`, state:'staged', name:copy.original || copy.name, session:copy.session, size:copy.size, at:copy.created, copy});

// Staged copies first come from upload responses, then from the server list.
function rows() {
  const copies = (state.files.files || []).filter(copy => !view.removed.has(copy.id));
  const listed = new Set(copies.map(copy => copy.id));
  for (const id of view.removed) if (!state.files.files.some(copy => copy.id === id)) view.removed.delete(id);
  const list = copies.map(stagedRow);
  for (const record of transfers()) {
    if (record.state === 'done') {
      if (view.selected === `t:${record.key}`) view.selected = `c:${record.copy.id}`;
      if (!listed.has(record.copy.id) && !view.removed.has(record.copy.id)) list.push(stagedRow({...record.copy, session:record.session, original:record.name, created:record.at}));
    } else list.push({key:`t:${record.key}`, state:record.state === 'failed' ? 'failed' : 'uploading', name:record.name, session:record.session, size:record.size, at:record.at, record});
  }
  return list.sort((a, b) => b.at - a.at);
}

function place(row) {
  const open = state.sessions.has(row.session), workspace = open ? workspaceOf(row.session) : null;
  return {open, terminal:open ? terminalName(row.session) : 'Closed terminal', workspace:open ? workspaceLabel(workspace) : 'No longer available',
    family:workspace ? workspaceIndex(workspace) : null, own:control(row.session)};
}

function matches(row, query) {
  if (!query) return true;
  const {terminal, workspace} = place(row);
  return [row.name, row.copy?.name, row.copy?.path, terminal, workspace].some(text => text?.toLowerCase().includes(query));
}

// What the row says under the name: size and time, progress, or the error.
function status(row) {
  if (row.state === 'failed') return row.record.error;
  if (row.state === 'uploading') return row.record.state === 'queued' ? `${bytes(row.size)} · waiting to upload` : `${bytes(row.size)} · ${row.record.percent}%`;
  const renamed = row.copy.name !== row.name ? ` · staged as ${row.copy.name}` : '';
  return `${bytes(row.size)} · dropped ${ago(row.at)}${renamed}`;
}
const stateLabel = row => row.state === 'staged' ? 'Staged' : row.state === 'failed' ? 'Failed' : row.record.state === 'queued' ? 'Waiting' : 'Uploading';

function removeBlock(row) {
  if (row.state !== 'staged') return 'Only a staged copy can be removed.';
  if (!state.connected) return 'Webterminal is offline. Copies can be removed once it reconnects.';
  const own = control(row.session);
  if (!own.mine) return `Only the view that controls ${terminalName(row.session)} can remove its copies. This view: ${own.label.toLowerCase()}.`;
  if (!state.snapshots.get(row.session)) return 'Open the terminal once so this view knows its current state.';
  return '';
}
function retryBlock(row) {
  if (!row.record.file) return 'The browser no longer holds this file. Drop it on the terminal again.';
  if (!state.sessions.has(row.session)) return 'Its terminal was closed.';
  return control(row.session).mine ? '' : `Take control of ${terminalName(row.session)} to retry.`;
}

// Actions
async function copyPath(row) {
  const path = row.copy?.path;
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    notify('Staged path copied', row.name, null, 'files-copy');
  } catch {
    const field = el('textarea', {class:'field', readonly:true, rows:3, 'aria-label':'Staged path', value:path, onfocus:event => event.target.select()});
    dialogs.show({title:'Copy staged path', description:'Clipboard access is unavailable here. Select the path and copy it.', body:field, initial:field, action:'Done', cancel:false});
  }
}

async function removeCopy(row) {
  const block = removeBlock(row);
  if (block) { problem('Copy not removed', block); return; }
  const {copy} = row, {terminal, workspace} = place(row);
  const removed = await dialogs.confirm({
    title:'Remove staged copy?',
    description:'This deletes only this staged copy and cannot be undone. Its terminal may still refer to the path. The original file is untouched.',
    body:el('div', {class:'files-remove-target'}, el('b', {text:row.name}), el('span', {text:`${terminal} · ${workspace}`}), pathText(copy.path, 'mono files-path-text')),
    action:'Remove staged copy',
    cancelLabel:'Keep copy',
    onSubmit:async () => {
      const again = removeBlock(row);
      if (again) return again;
      const reply = await ask({op:'remove-copy', id:copy.id, epoch:state.snapshots.get(copy.session).epoch}, message => message.type === 'copy-removed' && message.id === copy.id);
      if (!reply) return 'Not sent: the connection is unavailable. Try again when Webterminal reconnects.';
      if (reply.type === 'busy') return 'The server is busy. Try again shortly.';
      return true;
    },
  });
  if (!removed) return;
  view.removed.add(copy.id);
  forgetCopy(copy.id);
  if (view.selected === row.key) view.selected = null;
  notify('Staged copy removed', `${row.name} · ${terminal}`, null, `copy:${copy.id}`);
  changed('files');
}

// A retried upload stays in view: the Failed filter gives way to All.
async function retry(row) {
  const issue = await retryUpload(row.record.key);
  if (issue) { problem('Upload not retried', issue, null, 'upload'); return; }
  if (view.filter !== 'failed') return;
  view.filter = 'all';
  paint();
  if (!view.nodes.inspector.contains(document.activeElement)) restoreFocus(view.nodes.list.querySelector(`[data-key="${CSS.escape(row.key)}"]`), 'cancel');
}

function act(action, row) {
  if (action === 'select') select(row);
  else if (action === 'close') close();
  else if (action === 'terminal') { if (state.sessions.has(row.session)) showTerminal(row.session); }
  else if (action === 'copy') copyPath(row);
  else if (action === 'remove') removeCopy(row);
  else if (action === 'cancel') { if (cancelUpload(row.record.key)) notify('Upload cancelled', `${row.name} · no path was pasted.`, null, 'upload'); }
  else if (action === 'retry') retry(row);
  else if (action === 'dismiss') { dismissUpload(row.record.key); notify('Failed upload dismissed', row.name, null, 'upload'); }
}

function select(row) {
  view.selected = view.selected === row.key ? null : row.key;
  paint();
  if (view.selected) view.nodes.inspector.querySelector('h2')?.focus();
}
function close() {
  const key = view.selected;
  view.selected = null;
  paint();
  view.nodes.list.querySelector(`[data-key="${CSS.escape(key || '')}"] .files-name`)?.focus();
}

// Rendering
const iconButton = (name, label, action, title = label) => el('button', {class:'icon-btn ghost', type:'button', 'aria-label':label, title, dataset:{action}}, icon(name));

function placeNode(row) {
  const {open, terminal, workspace, family} = place(row);
  return el('span', {class:'files-place', title:open ? `${terminal} · ${workspace}` : 'Its terminal was closed'},
    family === null ? null : avatar(family, workspace, 'xs'), el('span', {text:terminal}));
}

function progressNode(row) {
  if (row.record?.state !== 'uploading') return null;
  return el('progress', {class:'files-progress', max:100, value:row.record.percent, 'aria-label':`Upload progress for ${row.name}`});
}

function rowNode(row) {
  const selected = view.selected === row.key;
  const name = el('button', {class:'files-name', type:'button', dataset:{action:'select'}, 'aria-expanded':String(selected), 'aria-controls':'files-inspector', text:row.name});
  const sub = el('span', {class:'files-sub'}, progressNode(row), el('span', {dataset:{status:''}, text:status(row)}));
  let action;
  if (row.state === 'staged') action = iconButton('copy', `Copy staged path for ${row.name}`, 'copy', 'Copy staged path');
  else if (row.state === 'uploading') action = iconButton('x', `Cancel upload of ${row.name}`, 'cancel', 'Cancel upload');
  else {
    const block = retryBlock(row);
    action = el('button', {class:'btn sm', type:'button', dataset:{action:'retry'}, 'aria-label':`Retry upload of ${row.name}`, disabled:Boolean(block), title:block || undefined, text:'Retry'});
  }
  return el('li', {class:'files-row', dataset:{key:row.key, state:row.state, selected:String(selected)}},
    el('div', {class:'files-identity'}, name, sub),
    placeNode(row),
    el('span', {}, badge(stateLabel(row), row.state === 'failed' ? 'red' : 'neutral')),
    el('div', {class:'files-row-actions'}, action));
}

// Progress changes update text in place so focus and scroll stay put.
function updateProgress(node, row) {
  if (row.state !== 'uploading') return;
  const bar = node.querySelector('.files-progress'), label = node.querySelector('[data-status]');
  if (bar) bar.value = row.record.percent;
  if (label) text(label, status(row));
}
// Unchanged text is left alone so live regions do not announce it again.
function text(node, value) { if (node.textContent !== value) node.textContent = value; }

function details(row) {
  const {open, terminal, workspace, family, own} = place(row);
  const fact = (label, value) => [el('dt', {text:label}), el('dd', {}, value)];
  const buttons = el('div', {class:'files-detail-actions'}), reasons = [];
  const button = (label, action, kind = '', block = '') => {
    if (block) reasons.push(block);
    return el('button', {class:`btn${kind}`, type:'button', dataset:{action}, disabled:Boolean(block), text:label});
  };
  const terminalButton = open ? button('Open terminal', 'terminal') : null;
  if (row.state === 'staged') buttons.append(el('div', {class:'files-detail-pair'}, button('Copy staged path', 'copy', ' primary'), terminalButton), button('Remove staged copy…', 'remove', ' danger', removeBlock(row)));
  else if (row.state === 'uploading') buttons.append(el('div', {class:'files-detail-pair'}, button('Cancel upload', 'cancel'), terminalButton));
  else buttons.append(el('div', {class:'files-detail-pair'}, button('Retry upload', 'retry', ' primary', retryBlock(row)), button('Dismiss', 'dismiss')), terminalButton);
  buttons.append(...reasons.map(reason => el('p', {class:'help', text:reason})));
  if (row.state === 'staged') buttons.append(el('p', {class:'help', text:'This copy is removed when its terminal closes. The original stays untouched.'}));
  return [
    row.copy ? el('div', {class:'files-staged-path'}, el('span', {text:'Staged path'}), pathText(row.copy.path, 'mono files-path-text'))
      : el('div', {class:'files-notice', dataset:{state:row.state}, role:'status'}, progressNode(row), el('span', {dataset:{status:''}, text:row.state === 'failed' ? `Not uploaded · ${row.record.error}` : status(row)})),
    el('dl', {class:'facts files-facts'},
      fact('State', stateLabel(row)),
      fact('Original name', row.name),
      row.copy ? fact('Staged as', row.copy.name === row.name ? 'Same name' : row.copy.name) : null,
      fact('Terminal', terminal),
      fact('Workspace', el('span', {class:'files-place'}, family === null ? null : avatar(family, workspace, 'xs'), el('span', {text:workspace}))),
      open && !own.mine ? fact('Control', own.label) : null),
    buttons,
  ];
}

function inspectorNode(row) {
  return [
    el('header', {}, el('div', {}, el('h2', {tabindex:'-1', text:row.name}), el('p', {text:`${bytes(row.size)} · ${row.state === 'staged' ? 'dropped' : 'started'} at ${clock(row.at)}`})),
      iconButton('x', 'Close file details', 'close')),
    ...details(row),
  ];
}

function signature(row) {
  const {terminal, workspace, family, own} = place(row);
  return [row.state, row.record?.state, Boolean(row.record?.file), row.name, row.size, row.copy?.path, row.copy?.name, terminal, workspace, family, own.label, row.record?.error, view.selected === row.key, state.connected, Math.floor((Date.now() - row.at) / 60000)].join('\u0001');
}

function build() {
  const search = el('input', {class:'field', type:'search', id:'files-search', placeholder:'Search files or terminals', autocomplete:'off', spellcheck:'false', 'aria-label':'Search dropped files', value:view.query});
  search.addEventListener('input', () => { view.query = search.value; paint(); });
  const filters = el('div', {class:'segment files-filter', role:'group', 'aria-label':'Show files'},
    FILTERS.map(([key, label]) => el('button', {type:'button', dataset:{filter:key}, 'aria-pressed':String(view.filter === key)}, el('span', {text:label}), el('span', {class:'count', dataset:{count:key}, text:'0'}))));
  filters.addEventListener('click', event => {
    const key = event.target.closest('[data-filter]')?.dataset.filter;
    if (key) { view.filter = key; paint(); }
  });
  const list = el('ul', {class:'files-list', 'aria-label':'Dropped files'});
  const inspector = el('aside', {class:'files-inspector', id:'files-inspector', 'aria-label':'File details', hidden:true});
  for (const area of [list, inspector]) area.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target || target.disabled) return;
    const key = area === list ? target.closest('.files-row')?.dataset.key : view.selected;
    const row = view.rows.get(key);
    if (row || target.dataset.action === 'close') act(target.dataset.action, row);
  });
  // A click on the row outside its controls selects it, like the name.
  list.addEventListener('click', event => {
    if (event.target.closest('button, a, input')) return;
    const row = view.rows.get(event.target.closest('.files-row')?.dataset.key);
    if (row) select(row);
  });
  inspector.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); close(); } });
  const frame = el('div', {class:'files-list-frame'},
    el('div', {class:'files-columns', 'aria-hidden':'true'}, el('span', {text:'File'}), el('span', {text:'Terminal'}), el('span', {text:'State'}), el('span')), list);
  const empty = el('div', {class:'state files-empty', hidden:true});
  const summary = el('p', {class:'files-summary', role:'status'});
  const layout = el('div', {class:'files-layout'}, el('div', {class:'files-main'},
    el('div', {class:'files-tools'}, el('div', {class:'search-field files-search'}, icon('search'), search), filters, summary), frame, empty), inspector);
  $('files-content').replaceChildren(layout);
  view.nodes = {search, filters, list, inspector, frame, empty, summary, layout};
}

function paint() {
  if (!view.nodes) build();
  const {filters, list, inspector, frame, empty, summary, layout} = view.nodes;
  const all = rows(), query = view.query.trim().toLowerCase();
  view.rows = new Map(all.map(row => [row.key, row]));
  const counts = {all:all.length, staged:0, uploading:0, failed:0};
  for (const row of all) counts[row.state]++;
  for (const button of filters.querySelectorAll('[data-filter]')) {
    const key = button.dataset.filter;
    button.setAttribute('aria-pressed', String(view.filter === key));
    text(button.querySelector('[data-count]'), String(counts[key]));
    button.setAttribute('aria-label', `${button.firstChild.textContent}, ${plural(counts[key], 'file')}`);
  }
  const visible = all.filter(row => (view.filter === 'all' || row.state === view.filter) && matches(row, query));
  text(summary, visible.length === all.length ? plural(all.length, 'file') : `${visible.length} of ${plural(all.length, 'file')}`);
  if (view.selected && !view.rows.has(view.selected)) view.selected = null;

  const focus = document.activeElement, focusRow = focus?.closest?.('.files-row'), focusKey = focusRow?.dataset.key, focusAction = focus?.dataset?.action;
  const focusIndex = focusRow ? [...list.children].indexOf(focusRow) : -1, inspectorFocus = inspector.contains(focus);
  const selectedIndex = [...list.children].findIndex(node => node.dataset.key === view.selected);
  const existing = new Map([...list.children].map(node => [node.dataset.key, node]));
  const wanted = visible.map(row => {
    const node = existing.get(row.key), sig = signature(row);
    if (node?.dataset.sig === sig) { updateProgress(node, row); return node; }
    const fresh = rowNode(row);
    fresh.dataset.sig = sig;
    if (node) node.replaceWith(fresh);
    return fresh;
  });
  wanted.forEach((node, index) => { if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null); });
  for (const node of [...list.children].slice(wanted.length)) node.remove();
  frame.hidden = !visible.length;
  empty.hidden = Boolean(visible.length);
  if (!visible.length) paintEmpty(empty, all.length);
  if (focusKey && !focus.isConnected) {
    const same = list.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    if (same) restoreFocus(same, focusAction); else settleFocus(focusIndex);
  }

  const selected = view.selected ? view.rows.get(view.selected) : null;
  layout.dataset.inspecting = String(Boolean(selected));
  inspector.hidden = !selected;
  if (selected) {
    const sig = signature(selected), hadFocus = inspector.contains(document.activeElement), action = document.activeElement?.dataset?.action;
    if (inspector.dataset.sig !== sig) {
      inspector.dataset.sig = sig;
      inspector.replaceChildren(...inspectorNode(selected));
      if (hadFocus) restoreFocus(inspector, action, 'h2');
    } else updateProgress(inspector, selected);
  } else inspector.dataset.sig = '';
  if (inspectorFocus && !selected) settleFocus(selectedIndex);
}

function restoreFocus(container, action, fallback = '.files-name') {
  if (!container) return;
  const target = (action && [...container.querySelectorAll(`[data-action="${CSS.escape(action)}"]`)].find(node => !node.disabled)) || container.querySelector(fallback);
  target?.focus({preventScroll:true});
}

// A row that left the list hands focus to its neighbour, never to the page body.
function settleFocus(index) {
  const {list, empty, search} = view.nodes, items = list.children;
  const target = items.length ? items[Math.min(Math.max(index, 0), items.length - 1)].querySelector('.files-name') : (!empty.hidden && empty.querySelector('button')) || search;
  target?.focus({preventScroll:true});
}

function paintEmpty(empty, total) {
  const key = total ? `none:${view.filter}:${view.query}` : 'empty';
  if (empty.dataset.key === key) return;
  empty.dataset.key = key;
  if (!total) {
    empty.replaceChildren(el('h2', {text:'No staged copies'}),
      el('p', {text:'Drop files on a terminal you control. Webterminal stages a copy, pastes its path and keeps it listed here.'}));
    return;
  }
  const clear = el('button', {class:'btn', type:'button', text:'Clear search and filter'});
  clear.addEventListener('click', () => {
    view.query = '';
    view.filter = 'all';
    view.nodes.search.value = '';
    paint();
    view.nodes.search.focus();
  });
  const filter = FILTERS.find(([key]) => key === view.filter)[1].toLowerCase();
  empty.replaceChildren(el('h2', {text:'No matching files'}), el('p', {text:view.query ? `Nothing ${view.filter === 'all' ? '' : `${filter} `}matches “${view.query.trim()}”.` : `No ${filter} files right now.`}), clear);
}

function apply(target) {
  view.target = target;
  if (FILTERS.some(([key]) => key === target?.filter)) view.filter = target.filter;
  if (target?.copy) view.selected = `c:${target.copy}`;
}

// Ages move on without a server message while the page is visible.
setInterval(() => { if (view.nodes && state.page === 'files') paint(); }, 30000);

export function show(target) { apply(target); }

export function render(topics) {
  if (topics.has('page') && state.target !== view.target) apply(state.target);
  if (!view.nodes || TOPICS.some(topic => topics.has(topic))) paint();
}
