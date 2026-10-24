// Boot and message dispatch. Pages are persistent sections; each page module
// loads on first visit and renders only while shown, so a failing page never
// takes the terminals down with it.
import {$, el} from './dom.js';
import {applyLimits, changed, go, state, subscribe, workspaceLabel, currentWorkspace} from './model.js';
import {configure, connect, resetInput, settle} from './connection.js';
import {problem} from './ui.js';
import {renderSidebar, configureSidebar} from './sidebar.js';
import {connected, disconnected, forget, handleTerminal, renderWorkspace, restoreSelection, setFontSize, synchronize} from './workspace.js';
import {PAGES, openPalette, showShortcuts} from './palette.js';

const MODULES = {overview:'./overview.js', processes:'./processes.js', files:'./files.js', settings:'./settings.js'};
const loaded = new Map();
let shown = null;
function applyPalettes(palettes) {
  const color = value => typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
  for (const theme of ['dark', 'light']) {
    const palette = palettes?.[theme];
    if (!palette || !color(palette.fg) || !color(palette.bg) || !Array.isArray(palette.ansi) ||
      palette.ansi.length !== 16 || !palette.ansi.every(color)) continue;
    const style = document.documentElement.style;
    style.setProperty(`--palette-${theme}-fg`, palette.fg);
    style.setProperty(`--palette-${theme}-bg`, palette.bg);
    palette.ansi.forEach((value, index) => style.setProperty(`--palette-${theme}-ansi-${index}`, value));
  }
}

function receive(message, answered) {
  if (handleTerminal(message)) return;
  switch (message.type) {
    case 'hello':
      state.hello = message;
      applyPalettes(message.palettes);
      applyLimits(message.limits);
      state.view = message.view;
      state.connected = true;
      resetInput();
      connected();
      changed('connection', 'focus');
      break;
    case 'sessions': {
      state.sessions = new Map((message.sessions || []).map(session => [session.id, session]));
      state.workspaces = (message.workspaces || []).map(workspace => ({id:workspace.id, name:workspace.name || null, sessions:workspace.sessions || []}));
      state.listed = true;
      forget([...state.snapshots.keys()].filter(id => !state.sessions.has(id)));
      const ids = new Set(state.workspaces.map(workspace => workspace.id));
      for (const id of [...state.focus.keys()]) if (!ids.has(id)) state.focus.delete(id);
      for (const id of [...state.maximized]) if (!ids.has(id)) state.maximized.delete(id);
      changed('sessions');
      break;
    }
    case 'settings':
      state.settings = message;
      applySettings();
      changed('settings');
      break;
    case 'files':
      state.files = {files:message.files || [], limit:message.limit || 0};
      changed('files');
      break;
    case 'server-stopping':
      state.stopping = true;
      changed('connection');
      break;
    case 'error':
      if (!answered) problem('Request failed', message.message || 'The server rejected the request.');
      break;
  }
}

function applySettings() {
  const settings = state.settings?.settings || {};
  if (Number.isInteger(settings.fontSize)) setFontSize(settings.fontSize);
  document.documentElement.dataset.terminalTheme = settings.terminalTheme === 'light' ? 'light' : 'dark';
}

configure({
  // An answered command's own error is reported by the action that sent it.
  message(message) { receive(message, settle(message)); },
  closed() {
    disconnected();
    changed('connection', 'focus');
  },
  problem(text) { problem('Not sent', text, null, 'connection'); },
});
configureSidebar({shortcuts:showShortcuts, palette:openPalette});

// Page switching: sections stay in the document, so a page keeps its scroll
// and draft state while hidden.
function title() {
  if (state.page === 'workspace') return `${workspaceLabel(currentWorkspace())} · Webterminal`;
  return `${PAGES.find(page => page.page === state.page)?.label || 'Webterminal'} · Webterminal`;
}
function failed(page, error) {
  console.error(error);
  const content = $(`${page}-content`);
  content?.replaceChildren(el('div', {class:'state', 'data-tone':'error', role:'alert'},
    el('h2', {text:'This view could not load'}), el('p', {text:'Terminals keep running. Reload the page to try again.'}),
    el('button', {class:'btn', type:'button', text:'Reload', onclick:() => location.reload()})));
}
async function module(page) {
  if (!MODULES[page]) return null;
  if (!loaded.has(page)) loaded.set(page, import(MODULES[page]).catch(error => { failed(page, error); return null; }));
  return loaded.get(page);
}
async function show(page, topics) {
  // A page this version does not have, such as a retired one, falls back to the terminals.
  if (!$(`page-${page}`)) { go('workspace'); return; }
  const changedPage = shown !== page;
  if (changedPage) {
    for (const section of document.querySelectorAll('#main > .page')) section.hidden = section.dataset.page !== page;
    $('main').scrollTop = 0;
  }
  const visit = state.target;
  const view = await module(page);
  if (state.page !== page) return;
  try {
    if (view) {
      if (changedPage) view.show?.(visit);
      view.render?.(changedPage ? new Set([...topics, 'page', 'sessions', 'settings', 'files', 'connection']) : topics);
    }
  } catch (error) { failed(page, error); }
  if (changedPage && shown !== null && page !== 'workspace' && !document.querySelector('dialog[open]')) {
    const heading = $(`${page}-title`);
    if (heading && !$(`page-${page}`).contains(document.activeElement)) heading.focus({preventScroll:true});
  }
  shown = page;
}

subscribe(topics => {
  // The workspace settles the selection first; the sidebar then marks it.
  renderWorkspace(topics);
  renderSidebar();
  if (topics.has('page') || shown !== state.page || state.page !== 'workspace') show(state.page, topics);
  document.title = title();
});

restoreSelection();
synchronize();
changed('page', 'connection');
connect();
