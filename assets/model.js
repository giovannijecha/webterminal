// Central view state and derived selectors. The Rust server owns sessions
// and control; this module only projects what it reported.
import {displayPath, folderName, sessionName, setNameLimit} from './common.js';

export let PANE_LIMIT = 4, WORKSPACE_LIMIT = 16, SESSION_LIMIT = 32;
export function applyLimits(limits = {}) {
  if (!limits || typeof limits !== 'object') return;
  setNameLimit(limits.name);
  if (Number.isSafeInteger(limits.sessionsPerWorkspace) && limits.sessionsPerWorkspace > 0)
    PANE_LIMIT = Math.min(4, limits.sessionsPerWorkspace);
  if (Number.isSafeInteger(limits.workspaces) && limits.workspaces > 0) WORKSPACE_LIMIT = limits.workspaces;
  if (Number.isSafeInteger(limits.sessions) && limits.sessions > 0) SESSION_LIMIT = limits.sessions;
}

export const state = {
  socket:null, view:null, connected:false, hello:null, listed:false,
  sessions:new Map(), workspaces:[], snapshots:new Map(), attachments:new Map(),
  selected:null, focus:new Map(), maximized:new Set(),
  files:{files:[], limit:0}, settings:null,
  page:'workspace', target:null, stopping:false,
};

// Navigation: pages read `state.target` (for example the terminal to focus) once shown.
export function go(page, target = null) {
  state.page = page;
  state.target = target;
  changed('page');
}
export function showTerminal(id, {claim = false} = {}) {
  const workspace = workspaceOf(id);
  if (!workspace) return;
  state.selected = workspace.id;
  state.focus.set(workspace.id, id);
  go('workspace', {focus:id, claim});
}

// Subscribers render at most once per frame with the set of changed topics.
const subscribers = new Set();
let pending = new Set(), frame = 0;
export function subscribe(render) { subscribers.add(render); }
export function changed(...topics) {
  for (const topic of topics) pending.add(topic);
  if (!frame) frame = requestAnimationFrame(flush);
}
function flush() {
  frame = 0;
  const topics = pending;
  pending = new Set();
  for (const render of subscribers) {
    try { render(topics); } catch (error) { console.error(error); }
  }
}

export function workspaceById(id) { return state.workspaces.find(workspace => workspace.id === id) || null; }
export function workspaceOf(id) { return state.workspaces.find(workspace => workspace.sessions.includes(id)) || null; }
export function workspaceIndex(workspace) { return Math.max(0, state.workspaces.indexOf(workspace)); }
export function currentWorkspace() { return workspaceById(state.selected); }
export function workspaceLabel(workspace) {
  if (!workspace) return 'Workspace';
  if (workspace.name) return workspace.name;
  const first = state.sessions.get(workspace.sessions[0]);
  return first ? folderName(first.cwd) || 'Workspace' : `Workspace ${workspaceIndex(workspace) + 1}`;
}
export function focusedId(workspace = currentWorkspace()) {
  const ids = workspace?.sessions || [], wanted = state.focus.get(workspace?.id);
  return ids.includes(wanted) ? wanted : ids[0] || null;
}
export function terminalName(id) { return sessionName(state.sessions.get(id)); }

export function shellLabel(shell = '') {
  const command = String(shell || '').trim();
  const executable = command.startsWith('"') ? command.slice(1).split('"', 1)[0] : command.split(/\s/, 1)[0];
  const program = (executable.split(/[\\/]/).at(-1) || '').replace(/\.exe$/i, '').toLowerCase();
  if (program === 'pwsh' || program === 'powershell') return 'PowerShell';
  if (program === 'cmd') return 'Command Prompt';
  return program || 'Shell';
}
// The shell a terminal runs, such as "PowerShell".
export function sessionShell(session) { return session ? shellLabel(session.shell || state.hello?.shell) : ''; }
// "PowerShell in C:\dev\app"
export function terminalPlace(id) {
  const session = state.sessions.get(id);
  return session ? `${sessionShell(session)} in ${displayPath(session.cwd)}` : '';
}

export function failed(session) { return Boolean(session && !session.alive && Number.isInteger(session.exitCode) && session.exitCode !== 0); }
export function failedSessions() { return [...state.sessions.values()].filter(failed); }

// Status shown in pane heads, cards and the palette. Only failures carry a
// tone (red); the rest are neutral.
export function terminalStatus(id) {
  const session = state.sessions.get(id);
  if (!session) return {key:'unknown', label:'Unknown', tone:'neutral'};
  if (!session.alive) {
    return failed(session) ? {key:'failed', label:`Failed · exit ${session.exitCode}`, tone:'red'} : {key:'exited', label:'Exited', tone:'neutral'};
  }
  return {key:'active', label:'Running', tone:'neutral'};
}

export function ready(id) { return Boolean(id && state.attachments.get(id)?.ready); }
export function canInput(id) {
  const shot = state.snapshots.get(id);
  return Boolean(state.connected && ready(id) && shot?.alive && shot.controller === state.view);
}

// Control of a terminal as this view sees it.
// Only an attached terminal's snapshot is current, and detaching releases
// control, so a view never controls a terminal it is not attached to.
export function control(id) {
  const attached = ready(id), shot = attached ? state.snapshots.get(id) : null, session = state.sessions.get(id);
  const controller = (attached ? shot?.controller : session?.controller) ?? null;
  const alive = shot?.alive ?? session?.alive;
  if (!state.connected) return {mine:false, label:'Offline', can:false};
  if (!alive) return {mine:false, label:'Exited', can:false};
  if (attached && controller === state.view) return {mine:true, label:'You have control', can:true};
  return {mine:false, label:controller && controller !== state.view ? 'Observing' : 'No controller', can:false};
}

export function totalSessions() { return state.sessions.size; }
export function orderedSessions() { return state.workspaces.flatMap(workspace => workspace.sessions.filter(id => state.sessions.has(id))); }
