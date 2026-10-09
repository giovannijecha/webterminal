import {createPanes} from './pane.js';
import {PANE_LIMIT, WORKSPACE_LIMIT, WorkspaceTabs, renderSwitcher, workspaceLabel} from './workspaces.js';
import {displayPath, nameError, sessionName} from './common.js';
import {NoticeCenter} from './notices.js';
import {DirectoryPicker} from './directory.js';
import {mergeUpdate} from './updates.js';
import {Reader} from './reader.js';

const $ = id => document.getElementById(id);
const MAX_QUEUED_INPUT = 1024 * 1024, MAX_SOCKET_BUFFER = 128 * 1024;
const encoder = new TextEncoder();
const narrow = matchMedia('(max-width:760px)');
const state = {socket:null, view:null, cwd:'', shell:'', listed:false, sessions:new Map(), workspaces:[], selected:read('webterminal.workspace'), selectedIndex:0, focus:new Map(), snapshots:new Map(), views:new Map(), attachments:new Map(), request:0, inputSeq:new Map(), inputQueue:[], inputQueuedBytes:0, inputTimer:0, reconnect:0, connectionReady:false, fontSize:14, resizeTimer:0, frame:0};
const notices = new NoticeCenter(), pendingCloses = new Set(), pendingCreates = new Map(), pendingWorkspaces = new Set();
const panes = createPanes(PANE_LIMIT, {snapshot:id => state.snapshots.get(id), connection:() => state.socket, canInput, input:sendInput, notify:toast, focus:focusPane, resize:scheduleResize, claim:pane => send({op:'claim', id:pane.id, ...pane.renderer.dimensions()}), close:closeSession, rename:renameSession, renamed:updateChrome, copied:text => reader.ignore(text), drop:(pane, id) => moveSession(id, state.selected, currentWorkspace().sessions.indexOf(pane.id))});
const tabs = new WorkspaceTabs($('workspace-tabs'), {select:selectWorkspace, rename:renameWorkspace, close:closeWorkspace, reorder:orderWorkspaces, move:(id, workspace) => moveSession(id, workspace)});
const reader = new Reader({notify:toast});
const picker = new DirectoryPicker({startDirectory:() => state.sessions.get(focusedId())?.cwd || state.cwd, create:createSession});

function read(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function write(key, value) { try { sessionStorage.setItem(key, value); } catch { /* View-local convenience only. */ } }
function toast(message, kind = 'info') { notices.notify(message, kind); }
function currentWorkspace() { return state.workspaces.find(workspace => workspace.id === state.selected) || null; }
function workspaceOf(id) { return state.workspaces.find(workspace => workspace.sessions.includes(id)) || null; }
function focusedId(workspace = currentWorkspace()) {
  const ids = workspace?.sessions || [], wanted = state.focus.get(workspace?.id);
  return ids.includes(wanted) ? wanted : ids[0] || null;
}
function focusedPane() { const id = focusedId(); return panes.find(pane => pane.id && pane.id === id) || null; }
function ready(pane) { return Boolean(pane.id && state.attachments.get(pane.id)?.ready); }
function canInput(pane) { const shot = state.snapshots.get(pane.id); return Boolean(state.connectionReady && ready(pane) && shot?.alive && shot.controller === state.view); }
function send(command) {
  if (state.socket?.readyState !== WebSocket.OPEN) { toast('Connection is unavailable. Reconnecting…', 'warning'); return false; }
  const payload = JSON.stringify(command);
  if (state.socket.bufferedAmount + encoder.encode(payload).length > MAX_SOCKET_BUFFER) { toast('Connection is busy. Try again shortly.', 'warning'); return false; }
  state.socket.send(payload); return true;
}
function nextRequest() {
  if (state.request === Number.MAX_SAFE_INTEGER) state.request = 0;
  return ++state.request;
}
function attach(pane) {
  if (!pane.id || !state.connectionReady) return;
  const request = nextRequest();
  state.attachments.set(pane.id, {request, acked:false, ready:false});
  send({op:'attach', id:pane.id, request, updates:true, ...pane.renderer.dimensions()});
}

// Binds the selected workspace's sessions to panes and attaches exactly those.
// Narrow screens show and attach only the focused terminal.
function synchronize(focus = false) {
  const index = state.workspaces.findIndex(workspace => workspace.id === state.selected);
  if (index >= 0) state.selectedIndex = index;
  else state.selected = state.workspaces[Math.min(state.selectedIndex, state.workspaces.length - 1)]?.id ?? null;
  if (state.selected) write('webterminal.workspace', state.selected);
  const workspace = currentWorkspace(), ids = (workspace?.sessions || []).filter(id => state.sessions.has(id)).slice(0, PANE_LIMIT);
  const focused = focusedId(workspace);
  panes.forEach((pane, i) => pane.bind(ids[i] && (!narrow.matches || ids[i] === focused) ? ids[i] : null, state.views));
  $('panes').dataset.count = String(narrow.matches ? Math.min(ids.length, 1) : ids.length);
  const visible = new Set(panes.map(pane => pane.id).filter(Boolean));
  for (const id of state.attachments.keys()) if (!visible.has(id)) { discardInput(id); state.attachments.delete(id); if (state.connectionReady && state.sessions.has(id)) send({op:'detach', id}); }
  for (const pane of panes) if (pane.id && !state.attachments.has(pane.id)) attach(pane);
  updateChrome(); scheduleResize();
  if (focus) requestAnimationFrame(() => focusedPane()?.focus());
}
function focusPane(pane) {
  const workspace = currentWorkspace();
  if (!pane.id || !workspace || state.focus.get(workspace.id) === pane.id) return;
  state.focus.set(workspace.id, pane.id);
  updateChrome();
}
function selectWorkspace(id) {
  if (id === state.selected || !state.workspaces.some(workspace => workspace.id === id)) return;
  state.selected = id;
  synchronize(true);
}
function selectPane(id) {
  state.focus.set(state.selected, id);
  synchronize(true);
}
function clearInputQueue() {
  state.inputQueue.length = 0; state.inputQueuedBytes = 0;
  clearTimeout(state.inputTimer); state.inputTimer = 0;
}
function discardInput(id) {
  state.inputQueue = state.inputQueue.filter(message => message.id !== id);
  state.inputQueuedBytes = state.inputQueue.reduce((total, message) => total + message.bytes, 0);
}
function sendInput(pane, data) {
  const shot = state.snapshots.get(pane.id);
  if (!canInput(pane) || !data) return;
  const bytes = encoder.encode(data).length;
  if (bytes + state.inputQueuedBytes > MAX_QUEUED_INPUT) { toast('Terminal input is backed up or exceeds the 1 MiB limit.'); return; }
  let chunk = '', count = 0;
  for (const character of data) {
    chunk += character;
    if (++count === 4096) { state.inputQueue.push({id:pane.id, epoch:shot.epoch, data:chunk, bytes:encoder.encode(chunk).length}); chunk = ''; count = 0; }
  }
  if (chunk) state.inputQueue.push({id:pane.id, epoch:shot.epoch, data:chunk, bytes:encoder.encode(chunk).length});
  state.inputQueuedBytes += bytes;
  if (!state.inputTimer) pumpInput();
}
function pumpInput() {
  state.inputTimer = 0;
  const next = state.inputQueue[0]; if (!next) return;
  const pane = panes.find(pane => pane.id === next.id);
  if (!pane || !canInput(pane) || state.snapshots.get(next.id).epoch !== next.epoch) { discardInput(next.id); if (state.inputQueue.length) pumpInput(); return; }
  const seq = (state.inputSeq.get(next.id) || 0) + 1;
  const payload = JSON.stringify({op:'input', id:next.id, epoch:next.epoch, seq, data:next.data});
  if (state.socket?.readyState !== WebSocket.OPEN) { clearInputQueue(); return; }
  if (state.socket.bufferedAmount + encoder.encode(payload).length > MAX_SOCKET_BUFFER) { state.inputTimer = setTimeout(pumpInput, 20); return; }
  state.socket.send(payload); state.inputSeq.set(next.id, seq);
  state.inputQueue.shift(); state.inputQueuedBytes -= next.bytes;
  if (state.inputQueue.length) state.inputTimer = setTimeout(pumpInput, 5);
}
function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket; state.connectionReady = false;
  socket.addEventListener('open', () => { state.reconnect = 0; send({op:'list'}); });
  socket.addEventListener('message', event => {
    if (state.socket !== socket) return;
    let message; try { message = JSON.parse(event.data); } catch { return; }
    handle(message);
  });
  socket.addEventListener('close', () => {
    if (state.socket !== socket) return;
    state.connectionReady = false; state.view = null; state.attachments.clear(); pendingCreates.clear(); pendingWorkspaces.clear(); clearInputQueue();
    for (const pane of panes) pane.input.reset();
    updateChrome(); setTimeout(connect, Math.min(8000, 350 * 2 ** state.reconnect++));
  });
  socket.addEventListener('error', () => socket.close());
}
function handle(message) {
  if (message.type === 'update') {
    const restored = mergeUpdate(state.snapshots.get(message.id), message);
    if (!restored) { const pane = panes.find(pane => pane.id === message.id); if (pane) { discardInput(pane.id); pane.input.reset(); attach(pane); updateChrome(); } return; }
    message = restored;
  }
  if (message.type === 'hello') {
    state.snapshots.clear(); state.attachments.clear();
    for (const pane of panes) { pane.renderer.clear(); pane.input.reset(); }
    state.view = message.view; state.cwd = message.cwd || ''; state.shell = message.shell || '';
    state.connectionReady = true; state.inputSeq.clear(); clearInputQueue();
    for (const pane of panes) if (pane.id) attach(pane);
    updateChrome();
  } else if (message.type === 'sessions') {
    state.sessions = new Map((message.sessions || []).map(session => [session.id, session]));
    state.workspaces = (message.workspaces || []).map(workspace => ({id:workspace.id, name:workspace.name || null, sessions:workspace.sessions || []}));
    state.listed = true;
    forget([...state.snapshots.keys()].filter(id => !state.sessions.has(id)));
    synchronize();
  } else if (message.type === 'created') {
    const creation = pendingCreates.get(message.request);
    if (!creation) return;
    pendingCreates.delete(message.request);
    state.sessions.set(message.id, {id:message.id, cwd:creation.cwd, shell:state.shell, title:'', name:null, alive:true, controller:state.view, exitCode:null});
    const workspace = state.workspaces.find(item => item.id === message.workspace);
    if (workspace && !workspace.sessions.includes(message.id)) workspace.sessions.push(message.id);
    state.selected = message.workspace;
    state.focus.set(message.workspace, message.id);
    state.attachments.set(message.id, {request:null, acked:true, ready:false});
    synchronize(true);
  } else if (message.type === 'workspace-created') {
    if (!pendingWorkspaces.delete(message.request)) return;
    if (!state.workspaces.some(workspace => workspace.id === message.id)) state.workspaces.push({id:message.id, name:null, sessions:[]});
    state.selected = message.id;
    synchronize();
  } else if (message.type === 'snapshot') {
    const previous = state.snapshots.get(message.id);
    if (previous && message.seq < previous.seq && message.epoch <= previous.epoch) return;
    state.snapshots.set(message.id, message);
    const attachment = state.attachments.get(message.id);
    if (attachment?.acked) attachment.ready = true;
    const session = state.sessions.get(message.id);
    if (session) state.sessions.set(message.id, {...session, title:message.terminal?.title || session.title, alive:message.alive, controller:message.controller, exitCode:message.exitCode});
    const pane = panes.find(pane => pane.id === message.id);
    if (pane) pane.dirty = true;
    scheduleFrame();
  } else if (message.type === 'attached') {
    const attachment = state.attachments.get(message.id);
    if (attachment && message.request === attachment.request) { attachment.acked = true; updateChrome(); }
  } else if (message.type === 'error') {
    if (message.op === 'create') pendingCreates.delete(message.request);
    if (message.op === 'create-workspace') pendingWorkspaces.delete(message.request);
    toast(message.message || 'Terminal request failed.', 'error');
  } else if (message.type === 'busy') confirmClose(message);
  else if (message.type === 'clipboard') writeTerminalClipboard(message);
}
async function writeTerminalClipboard(message) {
  if (!panes.some(pane => pane.id === message.id)) return;
  let content;
  try { content = new TextDecoder().decode(Uint8Array.from(atob(message.data), char => char.charCodeAt(0))); }
  catch { toast('The terminal sent invalid clipboard text.', 'error'); return; }
  reader.capture(content, sessionName(state.sessions.get(message.id)));
  reader.ignore(content);
  const connection = state.socket;
  const accepted = await notices.ask({kind:'clipboard', heading:'Copy terminal text to the clipboard?', description:`This terminal requested permission to replace your clipboard with ${content.length} characters.`, details:[['Terminal', sessionName(state.sessions.get(message.id))]], confirm:'Allow copy'});
  if (!accepted || !panes.some(pane => pane.id === message.id) || state.socket !== connection) return;
  try { await navigator.clipboard.writeText(content); toast('Terminal text copied to clipboard.'); }
  catch { toast('Clipboard access was denied by the browser.', 'error'); }
}

// Size estimate for a terminal that will become pane `index` of `count`.
function estimateSize(count) {
  const box = $('panes').getBoundingClientRect(), metrics = panes[0].renderer;
  metrics.measure();
  const columns = narrow.matches || count < 2 ? 1 : 2, rows = !narrow.matches && count > 2 ? 2 : 1;
  const width = (box.width || window.innerWidth) / columns - 36, height = (box.height || window.innerHeight - 100) / rows - 52;
  return {cols:Math.max(20, Math.min(300, Math.floor(width / metrics.cellWidth))), rows:Math.max(5, Math.min(120, Math.floor(height / metrics.lineHeight)))};
}
function openTerminal() {
  const workspace = currentWorkspace();
  if (!state.connectionReady || !workspace) { toast('Connection is unavailable. Reconnecting…', 'warning'); return; }
  if (workspace.sessions.length >= PANE_LIMIT) { toast(`A workspace holds at most ${PANE_LIMIT} terminals. Create a new workspace for more.`); return; }
  picker.open();
}
function createSession(path) {
  const workspace = currentWorkspace();
  if (!workspace) return false;
  const request = nextRequest();
  pendingCreates.set(request, {cwd:path});
  if (send({op:'create', request, cwd:path, workspace:workspace.id, updates:true, ...estimateSize(workspace.sessions.length + 1)})) return true;
  pendingCreates.delete(request); return false;
}
function createWorkspace() {
  if (state.workspaces.length >= WORKSPACE_LIMIT) { toast(`Close a workspace first; at most ${WORKSPACE_LIMIT} are open at once.`); return; }
  const request = nextRequest();
  if (send({op:'create-workspace', request})) pendingWorkspaces.add(request);
}
function validName(name) {
  const error = nameError(name);
  if (error) toast(error, 'error');
  return !error;
}
function renameSession(id, name) {
  const session = state.sessions.get(id);
  if (!session || !validName(name)) return false;
  if (name.trim() === sessionName(session) && !session.name) return true;
  if (!send({op:'rename', id, name})) return false;
  state.sessions.set(id, {...session, name:name.trim() || null});
  return true;
}
function renameWorkspace(id, name) {
  const workspace = state.workspaces.find(item => item.id === id);
  if (!workspace || !validName(name)) return false;
  if (name.trim() === workspaceLabel(workspace, state.sessions) && !workspace.name) return true;
  if (!send({op:'rename-workspace', id, name})) return false;
  workspace.name = name.trim() || null;
  return true;
}
function orderWorkspaces(ids) {
  if (!send({op:'order-workspaces', ids})) return;
  state.workspaces.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  synchronize();
}
function moveSession(id, target, position) {
  const source = workspaceOf(id), destination = state.workspaces.find(item => item.id === target);
  if (!source || !destination) return;
  if (source !== destination && destination.sessions.length >= PANE_LIMIT) { toast(`A workspace holds at most ${PANE_LIMIT} terminals.`); return; }
  position = Math.max(0, Math.min(position ?? destination.sessions.length, destination.sessions.length));
  if (!send({op:'move', id, workspace:target, position})) return;
  source.sessions = source.sessions.filter(item => item !== id);
  destination.sessions.splice(Math.min(position, destination.sessions.length), 0, id);
  synchronize();
}
// The server closes terminals idle at their shell at once and answers `busy`
// while a program runs; only then does the view ask before forcing it.
function closeSession(id) { if (state.sessions.has(id)) send({op:'close', id}); }
function closeWorkspace(id) { if (state.workspaces.some(item => item.id === id)) send({op:'close-workspace', id}); }
async function confirmClose({op, id, sessions = [], targets = []}) {
  const key = `${op}:${id}`;
  if (pendingCloses.has(key)) return;
  const connection = state.socket, names = sessions.map(item => sessionName(state.sessions.get(item)));
  const workspace = state.workspaces.find(item => item.id === id);
  pendingCloses.add(key);
  let accepted;
  try {
    accepted = await notices.ask(op === 'close'
      ? {heading:'Stop the running program?', description:'A program is still running in this terminal. Closing it stops the program and its child processes.', details:[['Terminal', names[0]], ['Folder', displayPath(state.sessions.get(id)?.cwd)]], confirm:'Close terminal'}
      : {heading:'Close workspace?', description:`${names.length === 1 ? 'One terminal is' : `${names.length} terminals are`} still running a program. Closing the workspace stops every terminal in it.`, details:[['Workspace', workspaceLabel(workspace, state.sessions)], ['Running', names.join(', ')]], confirm:'Close workspace'});
  } finally { pendingCloses.delete(key); }
  if (accepted && state.socket === connection) send({op, id, force:true, ...(op === 'close-workspace' ? {confirmed:targets} : {})});
}
function forget(ids) {
  for (const id of ids) {
    state.snapshots.delete(id); state.sessions.delete(id); state.views.delete(id);
    const workspace = workspaceOf(id);
    if (workspace) workspace.sessions = workspace.sessions.filter(item => item !== id);
  }
}
function paneStatus(pane) {
  const snapshot = state.snapshots.get(pane.id);
  if (!pane.id) return '';
  if (!state.connectionReady) return 'Reconnecting…';
  if (!ready(pane) || !snapshot) return 'Connecting…';
  if (!snapshot.alive) return `Exited${snapshot.exitCode === null ? '' : ` (${snapshot.exitCode})`}`;
  return snapshot.controller === state.view ? 'Controlling' : 'Observing';
}
function updateChrome() {
  const workspace = currentWorkspace(), ids = workspace?.sessions || [], focused = focusedId(workspace);
  tabs.render(state.workspaces, state.sessions, state.selected);
  $('empty-state').hidden = !state.listed || ids.length > 0;
  // The terminal action previews the layout it will produce.
  const count = ids.length;
  $('new').setAttribute('aria-disabled', String(count >= PANE_LIMIT));
  $('new-icon').setAttribute('href', count >= PANE_LIMIT ? '#icon-layout-full' : `#icon-layout-${count + 1}`);
  $('new-label').textContent = count ? 'Split' : 'Terminal';
  $('new').title = count >= PANE_LIMIT ? `This workspace has ${PANE_LIMIT} terminals` : count ? `Split — add terminal ${count + 1} of ${PANE_LIMIT}` : 'Open a terminal in this workspace';
  $('new-workspace').setAttribute('aria-disabled', String(state.workspaces.length >= WORKSPACE_LIMIT));
  $('connection').classList.toggle('connected', state.connectionReady);
  $('connection-status').textContent = state.connectionReady ? 'Connected' : 'Reconnecting…';
  $('connection').title = state.connectionReady ? `Local server · ${state.shell}` : 'Waiting for the local Webterminal server';
  renderSwitcher($('pane-switcher'), narrow.matches ? ids : [], state.sessions, focused, selectPane);
  for (const pane of panes) {
    pane.root.classList.toggle('focused', Boolean(pane.id) && pane.id === focused);
    if (pane.id) pane.update(state.sessions.get(pane.id), state.snapshots.get(pane.id), paneStatus(pane), ready(pane), state.view);
  }
  document.title = workspace ? `${workspaceLabel(workspace, state.sessions)} · Webterminal` : 'Webterminal';
}
// Updates arrive faster than the display refreshes; paint the latest state once per frame.
function scheduleFrame() {
  if (state.frame) return;
  state.frame = requestAnimationFrame(() => {
    state.frame = 0;
    for (const pane of panes) {
      if (!pane.dirty) continue;
      pane.dirty = false;
      const shot = state.snapshots.get(pane.id);
      if (shot) pane.render(shot);
    }
    scheduleResize();
    updateChrome();
  });
}
function scheduleResize() {
  // Throttled rather than debounced: continuous output must not postpone a
  // resize, and dragging the window reflows terminals while it moves.
  if (state.resizeTimer) return;
  state.resizeTimer = setTimeout(() => {
    state.resizeTimer = 0;
    for (const pane of panes) {
      if (!canInput(pane)) continue;
      const shot = state.snapshots.get(pane.id), size = pane.renderer.dimensions();
      if (size.cols !== shot.terminal.cols || size.rows !== shot.terminal.rows) send({op:'resize', id:pane.id, epoch:shot.epoch, ...size});
    }
  }, 50);
}
function setFontSize(size) {
  state.fontSize = Math.max(10, Math.min(26, size));
  document.documentElement.style.setProperty('--font-size', `${state.fontSize}px`);
  document.documentElement.style.setProperty('--line-height', `${Math.ceil(state.fontSize * 1.2)}px`);
  $('preferences-font').textContent = `${state.fontSize} px`;
  for (const pane of panes) pane.renderer.measure();
}

$('new').addEventListener('click', openTerminal);
$('empty-new').addEventListener('click', openTerminal);
$('new-workspace').addEventListener('click', createWorkspace);
$('settings').addEventListener('click', () => $('preferences-dialog').showModal());
$('preferences-close').addEventListener('click', () => $('preferences-dialog').close());
for (const [id, delta] of [['smaller', -1], ['larger', 1]]) $(id).addEventListener('click', () => {
  setFontSize(state.fontSize + delta);
  try { localStorage.setItem('webterminal.fontSize', state.fontSize); } catch { /* Not persisted. */ }
  scheduleResize();
});
$('fullscreen').addEventListener('click', async () => {
  $('preferences-dialog').close();
  try { if (document.fullscreenElement) { await document.exitFullscreen(); navigator.keyboard?.unlock?.(); } else { await document.documentElement.requestFullscreen(); try { await navigator.keyboard?.lock?.(); } catch { toast('The browser did not grant keyboard lock.'); } } }
  catch { toast('Fullscreen is unavailable.'); }
  focusedPane()?.focus();
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) navigator.keyboard?.unlock?.(); scheduleResize(); });
narrow.addEventListener('change', () => synchronize());
document.addEventListener('keydown', event => {
  if (event.target.closest?.('dialog[open]')) return;
  const pane = panes.find(pane => pane.id && pane.root.contains(event.target)) || focusedPane();
  if (!pane) return;
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); pane.showFind(true); }
  else if (event.key === 'Escape' && !pane.ui.findbar.hidden) pane.showFind(false);
  else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c' && !document.getSelection()?.isCollapsed) { event.preventDefault(); pane.copy(); }
}, true);
document.addEventListener('selectionchange', () => {
  const selection = document.getSelection(); if (!selection || selection.isCollapsed) return;
  for (const pane of panes) if (pane.ui['terminal-lines'].contains(selection.anchorNode) || pane.ui['terminal-lines'].contains(selection.focusNode)) pane.renderer.setFrozen(true);
});
document.addEventListener('copy', event => {
  const selection = document.getSelection();
  const pane = panes.find(pane => pane.ui['terminal-lines'].contains(selection?.anchorNode) && pane.ui['terminal-lines'].contains(selection?.focusNode));
  const text = pane?.renderer.selectionText();
  reader.ignore(text || selection?.toString());
  if (text && event.clipboardData) { event.clipboardData.setData('text/plain', text); event.preventDefault(); }
});
document.addEventListener('dragend', () => { for (const element of document.querySelectorAll('.drop-target,.drop-before,.drop-after')) element.classList.remove('drop-target', 'drop-before', 'drop-after'); });
document.fonts?.ready.then(scheduleResize);
let savedSize = 0;
try { savedSize = Number(localStorage.getItem('webterminal.fontSize')); } catch { /* Default size. */ }
setFontSize(savedSize >= 10 && savedSize <= 26 ? savedSize : 14);
updateChrome(); connect();
