// Central view state and derived selectors. The Rust server owns sessions,
// control and agent events; this module only projects what it reported.
import {displayPath, folderName, sessionName} from './common.js';

export const PANE_LIMIT = 4, WORKSPACE_LIMIT = 16, SESSION_LIMIT = 32;
export const PROGRAM_LABELS = {claude:'Claude Code', codex:'Codex', jecode:'Jecode'};

export const state = {
  socket:null, view:null, connected:false, hello:null, listed:false,
  sessions:new Map(), workspaces:[], snapshots:new Map(), attachments:new Map(),
  selected:null, focus:new Map(), maximized:new Set(), expanded:new Set(),
  agents:{revision:0, sources:[], requests:[]}, replies:[],
  files:{files:[], limit:0}, settings:null, programs:null,
  page:'workspace', target:null, stopping:false, copies:[],
};

// Navigation: pages read `state.target` (for example a request ID) once shown.
export function go(page, target = null) {
  state.page = page;
  state.target = target;
  changed('page');
}
export function showTerminal(id) {
  const workspace = workspaceOf(id);
  if (!workspace) return;
  state.selected = workspace.id;
  state.focus.set(workspace.id, id);
  go('workspace', {focus:id});
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
  const program = (shell.match(/[^\\/"]+?(?:\.exe)?(?="|\s|$)/i)?.[0] || shell).replace(/\.exe$/i, '').toLowerCase();
  if (program === 'pwsh' || program === 'powershell') return 'PowerShell';
  if (program === 'cmd') return 'Command Prompt';
  return program || 'Shell';
}
export function programLabel(session) {
  if (!session) return '';
  return PROGRAM_LABELS[session.program] || shellLabel(session.shell || state.hello?.shell);
}
// "Codex in C:\dev\app"
export function terminalPlace(id) {
  const session = state.sessions.get(id);
  return session ? `${programLabel(session)} in ${displayPath(session.cwd)}` : '';
}

export function sourceOf(id) { return state.agents.sources.find(source => source.session === id) || null; }
export function requestsFor(id) { return state.agents.requests.filter(request => request.session === id && request.state === 'waiting'); }
// One line naming what an agent asks: "wants to run npm test".
export function requestSummary(request) {
  const evidence = request?.evidence || {};
  if (request?.kind === 'question') return evidence.questions?.[0]?.question || 'asks a question';
  if (request?.kind === 'command') return `wants to run ${evidence.command || 'a command'}`;
  if (request?.kind === 'edit') return `wants to edit ${folderName(evidence.path || '') || 'a file'}`;
  return `wants to use ${request?.tool || 'a tool'}`;
}
export function waitingRequests() { return state.agents.requests.filter(request => request.state === 'waiting'); }
export function failed(session) { return Boolean(session && !session.alive && Number.isInteger(session.exitCode) && session.exitCode !== 0); }
export function failedSessions() { return [...state.sessions.values()].filter(failed); }

// Status shown in pane heads, cards and the palette. Only priority statuses
// carry a tone: Needs you (amber) and failures (red); the rest are neutral.
export function terminalStatus(id) {
  const session = state.sessions.get(id);
  if (!session) return {key:'unknown', label:'Unknown', tone:'neutral'};
  if (requestsFor(id).length) return {key:'needs', label:'Needs you', tone:'amber'};
  if (!session.alive) {
    return failed(session) ? {key:'failed', label:`Failed · exit ${session.exitCode}`, tone:'red'} : {key:'exited', label:'Exited', tone:'neutral'};
  }
  const source = sourceOf(id);
  if (source) {
    const activity = {working:['active', 'Working'], ready:['quiet', 'Ready'], waiting:['quiet', 'Ready'], idle:['quiet', 'Idle'], ended:['quiet', 'Ended'], failed:['failed', 'Failed']}[source.activity];
    if (activity) return {key:activity[0], label:activity[1], tone:activity[0] === 'failed' ? 'red' : 'neutral'};
  }
  if (session.program === 'jecode' || (session.program && !state.programs?.programs?.some(program => program.id === session.program && program.bridge !== 'none'))) {
    return {key:'quiet', label:'Unknown', tone:'neutral', unknown:true};
  }
  return {key:'active', label:'Running', tone:'neutral'};
}
export function needsYou(id) { const key = terminalStatus(id).key; return key === 'needs' || key === 'failed'; }

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

export function unreadReplies() { return state.replies.filter(reply => !reply.read).length; }
export function latestReply(id) { return state.replies.findLast(reply => reply.id === id) || null; }
export function totalSessions() { return state.sessions.size; }
export function orderedSessions() { return state.workspaces.flatMap(workspace => workspace.sessions.filter(id => state.sessions.has(id))); }

// Replies stay in this browser tab only, deduplicated by server sequence.
export const REPLY_LIMIT = 200;
export function addReply(message) {
  if (state.replies.some(reply => reply.seq === message.seq)) return false;
  const {seq, id, program, label, text, at, replayed} = message;
  // The terminal's name and workspace outlive it, so a reply read later still names its source.
  const place = state.sessions.has(id) ? {name:terminalName(id), workspace:workspaceLabel(workspaceOf(id))} : {};
  state.replies.push({seq, id, program, label, text, at, replayed:Boolean(replayed), read:false, ...place});
  if (state.replies.length > REPLY_LIMIT) state.replies.splice(0, state.replies.length - REPLY_LIMIT);
  changed('replies');
  return true;
}

// Text Webterminal itself put on the clipboard, newest last, so a clipboard
// follower can tell it apart and name the terminal it came from.
export function noteCopied(text, id = null) {
  if (!text) return;
  state.copies.push({text, id, at:Date.now()});
  if (state.copies.length > 20) state.copies.shift();
}
