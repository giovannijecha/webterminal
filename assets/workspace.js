// The workspace page: header, pane grid and the pipeline from server
// snapshots to panes. The selected workspace stays attached while other
// pages are shown, so its control and answers keep working.
import {$, avatar, el, plural, storage} from './dom.js';
import {displayPath, editInline} from './common.js';
import {PANE_LIMIT, canInput, changed, currentWorkspace, focusedId, go, latestReply, requestsFor, state, terminalName, workspaceIndex, workspaceLabel} from './model.js';
import {createPanes} from './pane.js';
import {discardInput, nextRequest, queueInput, send} from './connection.js';
import {mergeUpdate} from './updates.js';
import {dialogs, menu, notify, problem} from './ui.js';
import {configureActions, moveTerminal, renameTerminal, renameWorkspace, showTerminalMenu, takeControl, workspaceMenu} from './actions.js';
import {configureLauncher, openLauncher, showSplitMenu} from './launcher.js';
import {stageDrop} from './transfers.js';

const narrow = matchMedia('(max-width:900px)');
const view = storage('session');
const hooks = {copied() {}};
const views = new Map();
let selectedIndex = 0, frame = 0, resizeTimer = 0;

export function configureWorkspace(next) { Object.assign(hooks, next); }

const panes = createPanes(PANE_LIMIT, {
  input:(pane, data) => { const error = queueInput(pane.id, data); if (error) problem('Input not sent', error); },
  files:stageDrop,
  notify:(message, kind) => (kind === 'error' ? problem : notify)(message),
  focus:focusPane,
  resize:() => { scheduleResize(); scheduleFrame(); },
  claim:pane => takeControl(pane.id),
  rename:pane => renameTerminal(pane.id),
  menu:(pane, anchor) => showTerminalMenu(pane.id, anchor, {here:true}),
  maximize:() => toggleMaximized(),
  review:pane => go('attention', {request:requestsFor(pane.id)[0]?.id}),
  drop:(pane, id) => moveTerminal(id, state.selected, currentWorkspace().sessions.indexOf(pane.id)),
});
export function paneFor(id) { return panes.find(pane => pane.id && pane.id === id) || null; }
export function focusedPane() { return paneFor(focusedId()); }

async function copyOutput(id) {
  const pane = paneFor(id), text = pane?.outputText() || '';
  if (!text) { problem('Nothing to copy', 'This terminal has no output yet.'); return; }
  try { await navigator.clipboard.writeText(text); hooks.copied(text); notify('Output copied', terminalName(id)); }
  catch { problem('Copy failed', 'Clipboard access was denied by the browser.'); }
}
configureActions({
  geometry:id => { const pane = paneFor(id); return pane?.visible ? pane.renderer.dimensions() : null; },
  find:id => { if (state.page !== 'workspace') go('workspace'); requestAnimationFrame(() => paneFor(id)?.showFind(true)); },
  copy:copyOutput,
  launch:options => openLauncher(options),
  reply:latestReply,
});
configureLauncher({estimate:estimateSize, created:adopt});

function attach(pane) {
  if (!pane.id || !state.connected) return;
  const request = nextRequest();
  state.attachments.set(pane.id, {request, acked:false, ready:false});
  send({op:'attach', id:pane.id, request, updates:true, ...pane.renderer.dimensions()}, {quiet:true});
}

// Binds the selected workspace's terminals to panes and attaches exactly
// those. Narrow screens and a maximized layout hide, but keep, the others.
export function synchronize(focus = false) {
  const index = state.workspaces.findIndex(workspace => workspace.id === state.selected);
  if (index >= 0) selectedIndex = index;
  // Keep a restored selection until the server has listed its workspaces.
  else if (state.listed) state.selected = state.workspaces[Math.min(selectedIndex, state.workspaces.length - 1)]?.id ?? null;
  if (state.selected) view.set('webterminal.workspace', state.selected);
  const workspace = currentWorkspace(), ids = (workspace?.sessions || []).filter(id => state.sessions.has(id)).slice(0, PANE_LIMIT);
  panes.forEach((pane, i) => pane.bind(ids[i] || null, views));
  $('panes').dataset.count = String(ids.length);
  const bound = new Set(ids);
  for (const id of state.attachments.keys()) {
    if (bound.has(id)) continue;
    discardInput(id);
    state.attachments.delete(id);
    if (state.connected && state.sessions.has(id)) send({op:'detach', id}, {quiet:true});
  }
  for (const pane of panes) if (pane.id && !state.attachments.has(pane.id)) attach(pane);
  renderChrome();
  scheduleResize();
  if (focus && state.page === 'workspace') requestAnimationFrame(() => focusedPane()?.focus());
}

function focusPane(pane) {
  const workspace = currentWorkspace();
  if (!pane.id || !workspace || state.focus.get(workspace.id) === pane.id) return;
  state.focus.set(workspace.id, pane.id);
  changed('focus');
}
function selectPane(id) {
  state.focus.set(state.selected, id);
  changed('focus');
  requestAnimationFrame(() => paneFor(id)?.focus());
}
function toggleMaximized() {
  if (state.maximized.has(state.selected)) state.maximized.delete(state.selected); else state.maximized.add(state.selected);
  changed('focus');
  requestAnimationFrame(() => focusedPane()?.focus());
}

// Size estimate for a terminal that will become pane `count` of the layout.
function estimateSize(count) {
  const box = $('panes').getBoundingClientRect(), metrics = panes[0].renderer;
  metrics.measure();
  const columns = narrow.matches || count < 2 ? 1 : 2, rows = !narrow.matches && count > 2 ? 2 : 1;
  const width = (box.width || innerWidth - 320) / columns - 36, height = (box.height || innerHeight - 200) / rows - 140;
  return {cols:Math.max(20, Math.min(300, Math.floor(width / metrics.cellWidth))), rows:Math.max(5, Math.min(120, Math.floor(height / metrics.lineHeight)))};
}
// A terminal this view created is attached and shown at once.
function adopt(reply, {cwd, program}) {
  if (!state.sessions.has(reply.id)) {
    state.sessions.set(reply.id, {id:reply.id, cwd, shell:state.hello?.shell || '', program, created:Date.now(), title:'', name:null, alive:true, controller:state.view, exitCode:null});
  }
  const workspace = state.workspaces.find(item => item.id === reply.workspace);
  if (workspace && !workspace.sessions.includes(reply.id)) workspace.sessions.push(reply.id);
  state.attachments.set(reply.id, {request:null, acked:true, ready:false});
  state.selected = reply.workspace;
  state.focus.set(reply.workspace, reply.id);
  state.maximized.delete(reply.workspace);
  go('workspace', {focus:reply.id});
  synchronize(true);
}

async function clipboard(message) {
  if (!paneFor(message.id)) return;
  let content;
  try { content = new TextDecoder().decode(Uint8Array.from(atob(message.data), char => char.charCodeAt(0))); }
  catch { problem('Clipboard text rejected', 'The terminal sent invalid clipboard text.'); return; }
  const name = terminalName(message.id), connection = state.socket;
  const accepted = await dialogs.show({
    title:'Copy terminal text?', description:`${name} asked to replace your clipboard with ${plural(content.length, 'character')}.`,
    cancelLabel:'Don’t copy', action:'Copy text', origin:name,
  });
  if (!accepted || !paneFor(message.id) || state.socket !== connection) return;
  try { await navigator.clipboard.writeText(content); hooks.copied(content, message.id); notify('Copied to clipboard', name); }
  catch { problem('Copy failed', 'Clipboard access was denied by the browser.'); }
}

// Terminal messages; returns true when handled here.
export function handleTerminal(message) {
  if (message.type === 'update') {
    const restored = mergeUpdate(state.snapshots.get(message.id), message);
    if (!restored) {
      const pane = paneFor(message.id);
      if (pane) { discardInput(pane.id); pane.input.reset(); attach(pane); changed('focus'); }
      return true;
    }
    message = restored;
  }
  if (message.type === 'snapshot') {
    const previous = state.snapshots.get(message.id);
    if (previous && message.seq < previous.seq && message.epoch <= previous.epoch) return true;
    state.snapshots.set(message.id, message);
    const attachment = state.attachments.get(message.id);
    if (attachment?.acked) attachment.ready = true;
    const session = state.sessions.get(message.id);
    if (session) {
      const next = {...session, title:message.terminal?.title || session.title, alive:message.alive, controller:message.controller, exitCode:message.exitCode};
      const visible = next.title !== session.title || next.alive !== session.alive || next.controller !== session.controller || next.exitCode !== session.exitCode;
      state.sessions.set(message.id, next);
      if (visible) changed('sessions');
    }
    if (previous?.viewers !== message.viewers) changed('focus');
    const pane = paneFor(message.id);
    if (pane) pane.dirty = true;
    scheduleFrame();
    return true;
  }
  if (message.type === 'attached') {
    const attachment = state.attachments.get(message.id);
    if (attachment && message.request === attachment.request) { attachment.acked = true; changed('focus'); }
    return true;
  }
  if (message.type === 'clipboard') { clipboard(message); return true; }
  return false;
}
export function connected() {
  state.snapshots.clear();
  state.attachments.clear();
  for (const pane of panes) { pane.renderer.clear(); pane.input.reset(); }
  for (const pane of panes) if (pane.id) attach(pane);
}
export function disconnected() {
  state.attachments.clear();
  for (const pane of panes) pane.input.reset();
}
export function forget(ids) {
  for (const id of ids) { state.snapshots.delete(id); views.delete(id); }
}

// Updates arrive faster than the display refreshes; paint the latest state
// once per frame, and only for panes the layout shows.
function scheduleFrame() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    for (const pane of panes) {
      if (!pane.id) continue;
      const visible = pane.visible;
      // Restore a newly shown pane's position before new output measures it.
      if (visible && !pane.shown) pane.reveal();
      pane.shown = visible;
      if (visible && pane.dirty) {
        pane.dirty = false;
        const shot = state.snapshots.get(pane.id);
        if (shot) pane.render(shot);
      }
    }
    scheduleResize();
    renderPanes();
  });
}
function scheduleResize() {
  // Throttled rather than debounced: continuous output must not postpone a
  // resize. Hidden panes keep their geometry.
  if (resizeTimer) return;
  resizeTimer = setTimeout(() => {
    resizeTimer = 0;
    for (const pane of panes) {
      if (!pane.id || !pane.visible || !canInput(pane.id)) continue;
      const shot = state.snapshots.get(pane.id), size = pane.renderer.dimensions();
      if (size.cols !== shot.terminal.cols || size.rows !== shot.terminal.rows) send({op:'resize', id:pane.id, epoch:shot.epoch, ...size}, {quiet:true});
    }
  }, 50);
}
export function setFontSize(size) {
  document.documentElement.style.setProperty('--font-size', `${size}px`);
  document.documentElement.style.setProperty('--line-height', `${Math.ceil(size * 1.2)}px`);
  for (const pane of panes) { pane.renderer.measure(); pane.dirty = Boolean(pane.id); }
  scheduleFrame();
}

function renderPanes() {
  const workspace = currentWorkspace(), focused = focusedId(workspace), maximized = state.maximized.has(state.selected) && (workspace?.sessions.length || 0) > 1;
  $('panes').classList.toggle('maximized', maximized);
  for (const pane of panes) if (pane.id) pane.update({focused:pane.id === focused, maximized});
}
function renderChrome() {
  const workspace = currentWorkspace(), ids = workspace?.sessions || [], focused = focusedId(workspace), count = ids.length;
  const label = workspaceLabel(workspace), full = count >= PANE_LIMIT;
  const title = $('workspace-title');
  if (title.isConnected) {
    if (title.textContent !== label) title.textContent = label;
    title.setAttribute('aria-label', `Rename workspace ${label}`);
  }
  const mark = avatar(workspaceIndex(workspace), label, 'lg');
  mark.id = 'workspace-avatar';
  if ($('workspace-avatar').textContent !== mark.textContent || $('workspace-avatar').dataset.family !== mark.dataset.family) $('workspace-avatar').replaceWith(mark);
  for (const id of ['split', 'new']) {
    $(id).setAttribute('aria-disabled', String(full || !workspace));
    $(id).title = full ? `Workspace full · ${PANE_LIMIT} terminals` : id === 'split' ? 'Add a terminal next to the others' : 'Open a terminal in this workspace';
  }
  const context = $('workspace-context'), pathSlot = context.parentElement;
  const contextText = () => full ? `Workspace full · ${PANE_LIMIT} terminals` : count ? `${count} of ${PANE_LIMIT} terminals in ` : `No terminals yet · up to ${PANE_LIMIT}`;
  const contextNodes = cwd => cwd && !full ? [contextText(), ...pathParts(cwd)] : [contextText()];
  context.replaceChildren(...contextNodes(state.sessions.get(focused)?.cwd));
  const pathSamples = full ? [] : ids.map(id => state.sessions.get(id)?.cwd).filter(Boolean).map(cwd => {
    const sample = el('span', {class:'header-context-sizer', 'aria-hidden':'true'});
    sample.replaceChildren(...contextNodes(cwd));
    return sample;
  });
  pathSlot.replaceChildren(context, ...pathSamples);
  const viewerStatus = id => {
    const shot = state.snapshots.get(id), watchers = Math.max(0, (shot?.viewers || 0) - 1);
    const watched = Boolean(state.connected && shot?.alive && shot.controller && shot.controller !== state.view);
    return watched ? 'Another view has control' : watchers ? `${plural(watchers, 'other view')} watching` : '';
  };
  const viewers = $('workspace-viewers'), viewerSlot = $('workspace-viewers-slot');
  const status = viewerStatus(focused);
  viewers.hidden = !status;
  viewers.querySelector('.status-label').textContent = status;
  const viewerSamples = ids.map(viewerStatus).filter(Boolean).map(label => {
    const sample = viewers.cloneNode(true);
    sample.removeAttribute('id');
    sample.removeAttribute('title');
    sample.hidden = false;
    sample.classList.add('header-context-sizer');
    sample.setAttribute('aria-hidden', 'true');
    sample.querySelector('.status-label').textContent = label;
    return sample;
  });
  viewerSlot.replaceChildren(viewers, ...viewerSamples);
  viewerSlot.hidden = viewerSamples.length === 0;
  $('empty-state').hidden = !state.listed || count > 0;
  const tabs = $('pane-tabs');
  tabs.hidden = count < 2;
  const key = JSON.stringify([ids.map(id => terminalName(id)), focused]);
  if (tabs.dataset.key !== key) {
    tabs.dataset.key = key;
    tabs.replaceChildren(...ids.map(id => el('button', {type:'button', 'aria-pressed':String(id === focused), text:terminalName(id), onclick:() => selectPane(id)})));
  }
  renderPanes();
}
function pathParts(path) {
  const parts = displayPath(path).split(/(?<=[\\/])/);
  return parts.flatMap((part, index) => index < parts.length - 1 ? [part, el('wbr')] : [part]);
}

$('workspace-title').addEventListener('click', () => {
  const workspace = currentWorkspace(), label = $('workspace-title');
  if (!workspace) return;
  editInline(label, {value:workspaceLabel(workspace), accessibleName:'Workspace name', save:name => renameWorkspace(workspace.id, name), closed:() => changed('sessions')});
});
$('split').addEventListener('click', event => { if (event.currentTarget.getAttribute('aria-disabled') !== 'true') showSplitMenu(event.currentTarget); });
$('new').addEventListener('click', event => { if (event.currentTarget.getAttribute('aria-disabled') !== 'true') openLauncher({workspace:state.selected}); });
$('empty-new').addEventListener('click', () => openLauncher({workspace:state.selected}));
$('workspace-options').addEventListener('click', event => { if (state.selected) menu.toggle(event.currentTarget, workspaceMenu(state.selected), {label:'Workspace options'}); });

// Terminal keys while focus is inside a pane; nothing else is intercepted.
document.addEventListener('keydown', event => {
  if (state.page !== 'workspace' || event.target.closest?.('dialog[open]')) return;
  const pane = panes.find(item => item.id && item.root.contains(event.target)) || (event.target === document.body ? focusedPane() : null);
  if (!pane) return;
  const key = event.key.toLowerCase();
  if (event.ctrlKey && event.shiftKey && key === 'f') { event.preventDefault(); pane.showFind(true); }
  else if (event.key === 'Escape' && !pane.ui.findbar.hidden) pane.showFind(false);
  else if (event.ctrlKey && event.shiftKey && key === 'c' && !document.getSelection()?.isCollapsed) { event.preventDefault(); copySelection(pane); }
}, true);
async function copySelection(pane) {
  const text = pane.selectionText();
  if (!text) return;
  try { await navigator.clipboard.writeText(text); hooks.copied(text); notify('Copied selection', terminalName(pane.id)); }
  catch { problem('Copy failed', 'Clipboard access was denied by the browser.'); }
}
document.addEventListener('selectionchange', () => {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed) return;
  for (const pane of panes) if (pane.ui['terminal-lines'].contains(selection.anchorNode) || pane.ui['terminal-lines'].contains(selection.focusNode)) pane.renderer.setFrozen(true);
});
document.addEventListener('copy', event => {
  const selection = document.getSelection();
  const pane = panes.find(item => item.ui['terminal-lines'].contains(selection?.anchorNode) && item.ui['terminal-lines'].contains(selection?.focusNode));
  const text = pane?.selectionText();
  hooks.copied(text || selection?.toString());
  if (text && event.clipboardData) { event.clipboardData.setData('text/plain', text); event.preventDefault(); }
});
// A file dropped outside a terminal must not navigate away from the sessions.
for (const name of ['dragover', 'drop']) addEventListener(name, event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('dragend', () => { for (const element of document.querySelectorAll('.pane.drop-target')) element.classList.remove('drop-target'); });
document.addEventListener('fullscreenchange', scheduleResize);
document.fonts?.ready.then(scheduleResize);
narrow.addEventListener('change', () => { scheduleResize(); scheduleFrame(); });

export function restoreSelection() { state.selected = view.get('webterminal.workspace'); }
export function renderWorkspace(topics) {
  // Selecting a workspace arrives as a page change, so it rebinds the panes.
  if (topics.has('sessions') || topics.has('connection') || topics.has('page')) synchronize();
  else if (topics.has('focus') || topics.has('agents')) renderChrome();
  if (topics.has('page') && state.page === 'workspace') {
    scheduleFrame();
    const target = state.target?.focus || focusedId();
    requestAnimationFrame(() => { if (!document.querySelector('dialog[open]')) paneFor(target)?.focus(); });
  }
}
