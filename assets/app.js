import {TerminalPane, createSecondGroup} from './pane.js';
import {WorkspaceLayout} from './workspace.js';
import {Workbench, displayPath, sessionName} from './workbench.js';
import {NoticeCenter} from './notices.js';
import {ApplicationMenus} from './menus.js';
import {DirectoryPicker} from './directory.js';
import {mergeUpdate} from './updates.js';

const $ = id => document.getElementById(id);
const MAX_QUEUED_INPUT = 1024 * 1024, MAX_SOCKET_BUFFER = 128 * 1024;
const encoder = new TextEncoder();
const state = {socket:null, view:null, cwd:'', shell:'', sessions:new Map(), snapshots:new Map(), views:new Map(), attachments:new Map(), active:null, attachRequest:0, inputSeq:new Map(), inputQueue:[], inputQueuedBytes:0, inputTimer:0, reconnect:0, connectionReady:false, fontSize:14, resizeFrame:0};
const notices = new NoticeCenter(), pendingCloses = new Set(), pendingCreates = new Map();
const secondaryRoot = createSecondGroup();
const callbacks = {snapshot:id => state.snapshots.get(id), connection:() => state.socket, canInput, input:sendInput, notify:toast, focus:pane => layout.focus(panes.indexOf(pane)), resize:scheduleResize, claim:pane => send({op:'claim', id:pane.id, ...pane.renderer.dimensions()}), close:closeSession, create:pane => openDirectoryDialog(panes.indexOf(pane))};
const panes = [new TerminalPane($('editor-primary'), '', callbacks), new TerminalPane(secondaryRoot, 'secondary-', callbacks)];
let creationGroup = 0, renameId = null, renameConnection = null;
const directoryPicker = new DirectoryPicker({startDirectory:() => currentSession()?.cwd || state.cwd, create:path => {
  const request = nextRequest();
  pendingCreates.set(request, {group:creationGroup, cwd:path});
  if (send({op:'create', request, cwd:path, updates:true, ...panes[creationGroup].renderer.dimensions()})) return true;
  pendingCreates.delete(request); return false;
}});
const layout = new WorkspaceLayout({change:synchronize, create:openDirectoryDialog, close:closeSession, rename:renameSession, reorder:ids => send({op:'reorder', ids}), context:index => { menus.show($(index ? 'secondary-editor-more' : 'editor-more')); menus.buttons()[0]?.focus(); }});
const workbench = new Workbench({select:selectSession, create:() => openDirectoryDialog(), find:() => focusedPane().showFind(true), layout:scheduleResize, actions:() => [
  {label:'Terminal: New terminal', menus:['File','Terminal'], icon:'plus', run:() => openDirectoryDialog()},
  {label:'Terminal: Rename terminal', menus:['Terminal'], disabled:!state.active, run:() => renameSession()},
  {label:'View: Split terminal layout', menus:['View','Terminal'], icon:'split', disabled:!state.active, run:() => layout.splitLayout()},
  {label:'View: Single group layout', menus:['View','Terminal'], disabled:!layout.split, run:() => layout.single()},
  {label:'Terminal: Move terminal to other group', menus:['Terminal'], disabled:state.sessions.size < 2 || !state.active, run:() => layout.move()},
  {label:'Terminal: Move tab left', menus:['Terminal'], disabled:layout.groups[layout.focused].sessions.indexOf(state.active) <= 0, run:() => layout.moveTab(-1)},
  {label:'Terminal: Move tab right', menus:['Terminal'], disabled:layout.groups[layout.focused].sessions.indexOf(state.active) >= layout.groups[layout.focused].sessions.length - 1, run:() => layout.moveTab(1)},
  {label:'Go: Focus other group', menus:['Go','Terminal'], disabled:!layout.split, run:() => { layout.focus(1 - layout.focused); focusedPane().focus(); }},
  {label:'Terminal: Find in terminal', menus:['Edit'], shortcut:'Ctrl+Shift+F', icon:'search', disabled:!state.active, run:() => focusedPane().showFind(true)},
  {label:'View: Toggle session sidebar', menus:['View'], icon:'sidebar', run:() => workbench.toggleSidebar()},
  {label:'Terminal: Increase font size', menus:['View'], run:() => $('larger').click()},
  {label:'Terminal: Decrease font size', menus:['View'], run:() => $('smaller').click()},
  {label:'Terminal: Copy selection', menus:['Edit'], shortcut:'Ctrl+Shift+C', icon:'copy', disabled:!state.active, run:() => focusedPane().copy()},
  {label:'Terminal: Paste', menus:['Edit'], shortcut:'Ctrl+V', icon:'paste', disabled:!canInput(focusedPane()), run:() => focusedPane().paste()},
  {label:'Selection: Select all terminal text', menus:['Selection'], disabled:!state.active, run:() => focusedPane().selectAll()},
  {label:'Go: Previous terminal', menus:['Go'], disabled:state.sessions.size < 2, run:() => workbench.neighbor(-1)},
  {label:'Go: Next terminal', menus:['Go'], disabled:state.sessions.size < 2, run:() => workbench.neighbor(1)},
  {label:'Terminal: Take control', menus:['Terminal'], disabled:focusedPane().ui['take-control'].hidden, run:() => focusedPane().ui['take-control'].click()},
  {label:'Terminal: Close terminal', menus:['File','Terminal'], icon:'trash', disabled:!state.active, run:() => closeSession()},
  {label:'View: Terminal settings', menus:['View'], icon:'settings', run:() => menus.settings()},
  {label:'View: Toggle fullscreen', menus:['View'], icon:'expand', run:() => $('fullscreen').click()},
]});
const menus = new ApplicationMenus(() => workbench.actions());

function toast(message, kind = 'info') { notices.notify(message, kind); }
function focusedPane() { return panes[layout.focused]; }
function currentSnapshot() { return state.snapshots.get(state.active); }
function currentSession() { return state.sessions.get(state.active); }
function ready(pane) { return Boolean(pane.id && state.attachments.get(pane.id)?.ready); }
function canInput(pane) { const shot = state.snapshots.get(pane.id); return Boolean(state.connectionReady && ready(pane) && shot?.alive && shot.controller === state.view); }
function send(command) {
  if (state.socket?.readyState !== WebSocket.OPEN) { toast('Connection is unavailable. Reconnecting…', 'warning'); return false; }
  const payload = JSON.stringify(command);
  if (state.socket.bufferedAmount + encoder.encode(payload).length > MAX_SOCKET_BUFFER) { toast('Connection is busy. Try again shortly.', 'warning'); return false; }
  state.socket.send(payload); return true;
}
function nextRequest() {
  if (state.attachRequest === Number.MAX_SAFE_INTEGER) state.attachRequest = 0;
  return ++state.attachRequest;
}
function attach(pane) {
  if (!pane.id || !state.connectionReady) return;
  const request = nextRequest();
  state.attachments.set(pane.id, {request, acked:false, ready:false});
  send({op:'attach', id:pane.id, request, updates:true, ...pane.renderer.dimensions()});
}
function synchronize(focus = false) {
  const before = state.active, former = panes.map(pane => pane.id);
  layout.sync(state.sessions); layout.render();
  for (let i = 0; i < panes.length; i++) panes[i].bind(i === 1 && !layout.split ? null : layout.groups[i].active, state.views);
  state.active = layout.active;
  if (before !== state.active || former.some((id, index) => id !== panes[index].id)) for (const pane of panes) pane.input.reset();
  const visible = new Set(panes.map(pane => pane.id).filter(Boolean));
  for (const id of state.attachments.keys()) if (!visible.has(id)) { discardInput(id); state.attachments.delete(id); if (state.connectionReady) send({op:'detach', id}); }
  for (const pane of panes) if (pane.id && !state.attachments.has(pane.id)) attach(pane);
  updateChrome(); scheduleResize();
  if (focus) requestAnimationFrame(() => focusedPane().focus());
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
    state.connectionReady = false; state.view = null; state.attachments.clear(); pendingCreates.clear(); clearInputQueue();
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
    synchronize();
  } else if (message.type === 'created') {
    const creation = pendingCreates.get(message.request);
    if (!creation) return;
    pendingCreates.delete(message.request);
    state.sessions.set(message.id, {id:message.id, cwd:creation.cwd, shell:state.shell, title:'', name:null, alive:true, controller:state.view, exitCode:null});
    layout.place(message.id, creation.group);
    state.attachments.set(message.id, {request:null, acked:true, ready:false});
    synchronize(true);
  } else if (message.type === 'snapshot') {
    const previous = state.snapshots.get(message.id);
    if (previous && message.seq < previous.seq && message.epoch <= previous.epoch) return;
    state.snapshots.set(message.id, message);
    const attachment = state.attachments.get(message.id);
    if (attachment?.acked) attachment.ready = true;
    const session = state.sessions.get(message.id);
    if (session) state.sessions.set(message.id, {...session, title:message.terminal?.title || session.title, alive:message.alive, controller:message.controller, exitCode:message.exitCode});
    const pane = panes.find(pane => pane.id === message.id);
    if (pane) { pane.render(message); scheduleResize(); }
    updateChrome();
  } else if (message.type === 'attached') {
    const attachment = state.attachments.get(message.id);
    if (attachment && message.request === attachment.request) { attachment.acked = true; updateChrome(); }
  } else if (message.type === 'error') { if (message.op === 'create') pendingCreates.delete(message.request); toast(message.message || 'Terminal request failed.', 'error'); }
  else if (message.type === 'clipboard') writeTerminalClipboard(message);
}
async function writeTerminalClipboard(message) {
  if (message.id !== state.active) return;
  let content;
  try { content = new TextDecoder().decode(Uint8Array.from(atob(message.data), char => char.charCodeAt(0))); }
  catch { toast('The terminal sent invalid clipboard text.', 'error'); return; }
  const connection = state.socket;
  const accepted = await notices.ask({kind:'clipboard', heading:'Copy terminal text to the clipboard?', description:`This terminal requested permission to replace your clipboard with ${content.length} characters.`, details:[['Terminal', sessionName(currentSession())]], confirm:'Allow copy'});
  if (!accepted || state.active !== message.id || state.socket !== connection) return;
  try { await navigator.clipboard.writeText(content); toast('Terminal text copied to clipboard.'); }
  catch { toast('Clipboard access was denied by the browser.', 'error'); }
}
function selectSession(id) { if (state.sessions.has(id)) layout.select(id); }
async function closeSession(id = state.active) {
  if (!id || pendingCloses.has(id)) return;
  const session = state.sessions.get(id); if (!session) return;
  const connection = state.socket; pendingCloses.add(id);
  let accepted;
  try { accepted = await notices.ask({heading:session.alive ? 'Close terminal?' : 'Remove exited terminal?', description:session.alive ? 'The running program and its child processes will stop. The screen and scrollback for this terminal will be removed.' : 'The program has exited. Remove its retained screen and scrollback from Webterminal.', details:[['Terminal', `${sessionName(session)} · ${id}`],['Directory', displayPath(session.cwd)]], confirm:session.alive ? 'Close terminal' : 'Remove terminal'}); }
  finally { pendingCloses.delete(id); }
  if (!accepted) return;
  if (state.socket !== connection || !state.connectionReady) { toast('The connection changed. Review the terminal before closing it.', 'warning'); return; }
  if (!state.sessions.has(id)) { toast('This terminal has already been closed.'); return; }
  if (!send({op:'close', id})) return;
  state.snapshots.delete(id); state.sessions.delete(id); state.views.delete(id);
  synchronize(true);
}
function renameSession(id = state.active) {
  const session = state.sessions.get(id); if (!session) return;
  renameId = id; renameConnection = state.socket;
  $('rename-input').value = session.name || sessionName(session); $('rename-error').hidden = true;
  $('rename-dialog').showModal(); $('rename-input').focus(); $('rename-input').select();
}
function saveName() {
  const name = $('rename-input').value;
  if ([...name.trim()].length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(name)) { $('rename-error').textContent = 'Use at most 80 characters without control characters.'; $('rename-error').hidden = false; return; }
  if (renameConnection !== state.socket || !state.connectionReady || !state.sessions.has(renameId)) { $('rename-error').textContent = 'The connection changed. Close this dialog and review the terminal.'; $('rename-error').hidden = false; return; }
  if (send({op:'rename', id:renameId, name})) $('rename-dialog').close();
}
function updateChrome() {
  layout.render();
  const shot = currentSnapshot(), session = currentSession();
  workbench.update({sessions:state.sessions, active:state.active, cwd:state.cwd, shell:session?.shell || state.shell, connected:state.connectionReady, fontSize:state.fontSize, groups:layout.split ? layout.groups : [layout.groups[0]], focusedGroup:String(layout.focused + 1), view:state.view});
  $('tabs-empty').hidden = Boolean(layout.groups[0].sessions.length);
  for (const pane of panes) {
    const snapshot = state.snapshots.get(pane.id);
    const status = !pane.id ? '' : !state.connectionReady ? 'Reconnecting…' : !ready(pane) || !snapshot ? 'Connecting…' : !snapshot.alive ? `Exited${snapshot.exitCode === null ? '' : ` (${snapshot.exitCode})`}` : snapshot.controller === state.view ? 'Controlling' : 'Observing';
    pane.update(state.sessions.get(pane.id), snapshot, status, ready(pane), state.view);
  }
  $('view-status').textContent = focusedPane().root.dataset.status;
  $('terminal-size').textContent = shot?.terminal ? `${shot.terminal.cols} × ${shot.terminal.rows}` : '';
  document.title = state.active ? `${sessionName(session)} · Webterminal` : 'Webterminal';
}
function scheduleResize() {
  if (state.resizeFrame) cancelAnimationFrame(state.resizeFrame);
  state.resizeFrame = requestAnimationFrame(() => {
    state.resizeFrame = 0;
    for (const tab of document.querySelectorAll('.tabs .tab.active')) tab.scrollIntoView({block:'nearest', inline:'nearest'});
    for (const pane of panes) {
      if (!canInput(pane)) continue;
      const shot = state.snapshots.get(pane.id), size = pane.renderer.dimensions();
      if (size.cols !== shot.terminal.cols || size.rows !== shot.terminal.rows) send({op:'resize', id:pane.id, epoch:shot.epoch, ...size});
    }
  });
}
function openDirectoryDialog(group = layout.focused) { creationGroup = group; directoryPicker.open(); }
for (const [index, prefix] of ['', 'secondary-'].entries()) {
  $(prefix + 'new').addEventListener('click', () => openDirectoryDialog(index));
  $(prefix + 'split-terminal').addEventListener('click', () => layout.splitLayout());
}
$('rename-save').addEventListener('click', saveName);
$('rename-input').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); saveName(); } });
for (const [id,delta] of [['smaller',-1],['larger',1]]) $(id).addEventListener('click', () => {
  state.fontSize = Math.max(10, Math.min(26, state.fontSize + delta));
  document.documentElement.style.setProperty('--font-size', `${state.fontSize}px`);
  document.documentElement.style.setProperty('--line-height', `${Math.ceil(state.fontSize * 1.38)}px`);
  localStorage.setItem('webterminal.fontSize', state.fontSize);
  for (const pane of panes) pane.renderer.measure();
  scheduleResize(); updateChrome();
});
$('fullscreen').addEventListener('click', async () => {
  $('preferences-dialog').close();
  try { if (document.fullscreenElement) { await document.exitFullscreen(); navigator.keyboard?.unlock?.(); } else { await document.documentElement.requestFullscreen(); try { await navigator.keyboard?.lock?.(); } catch { toast('The browser did not grant keyboard lock.'); } } }
  catch { toast('Fullscreen is unavailable.'); }
  focusedPane().focus();
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) navigator.keyboard?.unlock?.(); scheduleResize(); });
document.addEventListener('keydown', event => {
  if (event.target.closest?.('dialog[open]')) return;
  const pane = focusedPane();
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
  if (text && event.clipboardData) { event.clipboardData.setData('text/plain', text); event.preventDefault(); }
});
document.fonts?.ready.then(scheduleResize);
const savedSize = Number(localStorage.getItem('webterminal.fontSize'));
if (savedSize >= 10 && savedSize <= 26) { state.fontSize = savedSize; document.documentElement.style.setProperty('--font-size', `${savedSize}px`); document.documentElement.style.setProperty('--line-height', `${Math.ceil(savedSize * 1.38)}px`); for (const pane of panes) pane.renderer.measure(); }
// Reconcile saved groups only after this connection delivers its session list.
// An empty pre-connection registry must not erase the restored layout.
for (let i = 0; i < panes.length; i++) panes[i].bind(i === 1 && !layout.split ? null : layout.groups[i].active, state.views);
state.active = layout.active;
updateChrome(); connect();
