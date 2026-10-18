// Notifications for real agent events: new requests, failed programs and
// replies. What exists when a connection opens is the baseline, so nothing is
// announced again after a reconnect, and each event notifies at most once.
import {currentWorkspace, failed, go, programLabel, requestSummary, showTerminal, state, terminalName, workspaceLabel, workspaceOf} from './model.js';
import {isMuted} from './actions.js';
import {attention, browserNotices, notify, problem} from './ui.js';

const seen = {requests:new Set(), failures:new Set(), replies:new Set()};
let requestsBaseline = false, failuresBaseline = false;

function enabled(kind) { return state.settings?.settings?.notifications?.[kind] !== false; }
function remember(set, key) {
  set.add(key);
  if (set.size > 1024) set.delete(set.values().next().value);
}
// The Dock stays quiet for a terminal already on screen; its pane shows it.
function onScreen(id) { return state.page === 'workspace' && currentWorkspace()?.sessions.includes(id) && document.hasFocus(); }

export function connectionOpened() { requestsBaseline = false; failuresBaseline = false; }

export function agentsChanged() {
  const waiting = state.agents.requests.filter(request => request.state === 'waiting');
  const fresh = waiting.filter(request => !seen.requests.has(request.id));
  for (const request of fresh) remember(seen.requests, request.id);
  if (!requestsBaseline) { requestsBaseline = true; return; }
  for (const request of fresh) {
    const id = request.session;
    if (!enabled('input') || isMuted(id) || !state.sessions.has(id)) continue;
    const program = request.label || programLabel(state.sessions.get(id)), where = workspaceLabel(workspaceOf(id));
    const review = () => go('attention', {request:request.id});
    browserNotices.show(`request:${request.id}`, `${program} needs you`, `${program} ${requestSummary(request)} · ${where}`, review);
    if (!onScreen(id)) attention(`${program} needs you in ${where}`, `${terminalName(id)} ${requestSummary(request)}`, {label:'Review request', run:review}, `request:${request.id}`);
  }
}

export function sessionsChanged() {
  if (!state.listed) return;
  const fresh = [...state.sessions.values()].filter(session => failed(session) && !seen.failures.has(session.id));
  for (const session of fresh) remember(seen.failures, session.id);
  if (!failuresBaseline) { failuresBaseline = true; return; }
  for (const session of fresh) {
    if (!enabled('failure') || isMuted(session.id)) continue;
    const name = terminalName(session.id), where = workspaceLabel(workspaceOf(session.id)), text = `Exited with code ${session.exitCode}`;
    const open = () => showTerminal(session.id);
    browserNotices.show(`failure:${session.id}`, `${name} failed`, `${text} · ${where}`, open);
    if (!onScreen(session.id)) problem(`${name} failed in ${where}`, text, {label:'Open terminal', run:open}, `failure:${session.id}`);
  }
}

export function replyReceived(reply) {
  if (seen.replies.has(reply.seq)) return;
  remember(seen.replies, reply.seq);
  if (reply.replayed || !enabled('reply') || isMuted(reply.id)) return;
  const name = state.sessions.has(reply.id) ? terminalName(reply.id) : reply.label;
  const read = () => go('reader', {reply:reply.seq});
  browserNotices.show(`reply:${reply.seq}`, `${reply.label} replied`, `${name} · ${reply.text.slice(0, 140)}`, read);
  notify(`${reply.label} replied in ${name}`, reply.text.replace(/\s+/g, ' ').slice(0, 160), {label:'Read reply', run:read}, `reply:${reply.seq}`);
}
