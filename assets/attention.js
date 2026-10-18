// Needs you: agent requests, failed programs and unread replies, each with its
// own count. Programs that cannot report requests are named honestly as
// Unknown with Open terminal as the real path.
import {$, ago, badge, counter, el, icon, patch, pathText, plural, programTile} from './dom.js';
import {failedSessions, go, programLabel, showTerminal, state, terminalName, terminalStatus, workspaceLabel, workspaceOf} from './model.js';
import {closeTerminals} from './actions.js';
import {RequestCard, requestRecord, requestTitle} from './requests.js';

const REPLY_LIMIT = 12;
const cards = new Map();
// Requests seen waiting since this page was last shown keep their card, so a
// decision made here or elsewhere settles in place instead of vanishing.
const watched = new Set();
let ui = null, target = null, handled = null, note = null;

function build() {
  const section = (id, title, intro = '') => {
    const count = el('span', {class:'needs-count'}), list = el('div', {class:'needs-list'});
    const node = el('section', {class:'needs-section', 'aria-labelledby':`needs-${id}-title`, hidden:true},
      el('header', {class:'needs-section-head'}, el('h2', {id:`needs-${id}-title`, text:title}), count),
      intro ? el('p', {class:'needs-intro', text:intro}) : null, list);
    return {node, count, list};
  };
  ui = {
    note:el('div', {class:'needs-note', hidden:true}),
    empty:el('div', {class:'state needs-empty', hidden:true},
      el('span', {class:'tile', 'aria-hidden':'true'}, icon('check')), el('h2', {text:'Nothing needs you'}),
      el('p', {text:'No agent is waiting for an answer, no program has failed and every reply is read. New ones show up here and in the sidebar.'})),
    requests:section('requests', 'Requests'),
    failures:section('failures', 'Failures'),
    replies:section('replies', 'Unread replies'),
    unknown:section('unknown', 'Status unknown', 'These programs don’t report requests to Webterminal. Check their terminal for prompts.'),
  };
  $('attention-content').replaceChildren(el('div', {class:'needs'}, ui.note, ui.empty, ui.requests.node, ui.failures.node, ui.replies.node, ui.unknown.node));
}

function where(id) {
  const session = state.sessions.get(id);
  return session ? `${programLabel(session)} · ${workspaceLabel(workspaceOf(id))}` : '';
}
// A keyed list: only changed items are rebuilt, so focus and scroll stay.
function list(container, items) {
  const active = container.contains(document.activeElement) ? document.activeElement : null;
  const was = active ? {key:active.closest('[data-item]')?.dataset.item, focus:active.dataset.focus} : null;
  const old = new Map([...container.children].map(node => [node.dataset.item, node]));
  const nodes = items.map(item => {
    const node = old.get(item.key);
    if (node?.dataset.render === item.render) return node;
    const next = item.build();
    next.dataset.item = item.key;
    next.dataset.render = item.render;
    return next;
  });
  if (nodes.length !== container.children.length || nodes.some((node, index) => container.children[index] !== node)) container.replaceChildren(...nodes);
  if (was && !active.isConnected) {
    const row = nodes.find(node => node.dataset.item === was.key);
    (row?.querySelector(`[data-focus="${was.focus}"]`) || row?.querySelector('button'))?.focus({preventScroll:true});
  }
}
function counted(section, count, tone, label) {
  section.node.hidden = !count;
  patch(section.count, `${count}:${tone}:${label}`, () => counter(count, tone, label));
}

function renderRequests() {
  const requests = state.agents.requests;
  for (const request of requests) if (request.state === 'waiting' || request.state === 'pending') watched.add(request.id);
  const order = requests.filter(request => watched.has(request.id)).sort((a, b) => (a.created || 0) - (b.created || 0));
  // A watched request the server dropped keeps its card, marked unavailable.
  const ids = new Set(order.map(request => request.id));
  const gone = [...watched].filter(id => !ids.has(id) && cards.has(id));
  for (const [id, card] of cards) if (!watched.has(id)) { card.node.remove(); cards.delete(id); }
  const nodes = [];
  for (const request of order) {
    let card = cards.get(request.id);
    if (card) card.update(request); else cards.set(request.id, card = new RequestCard(request));
    nodes.push(card.node);
  }
  for (const id of gone) { cards.get(id).update(null); nodes.push(cards.get(id).node); }
  const container = ui.requests.list;
  if (nodes.length !== container.children.length || nodes.some((node, index) => container.children[index] !== node)) {
    const active = document.activeElement;
    container.append(...nodes);
    if (active?.isConnected && document.activeElement !== active) active.focus({preventScroll:true});
  }
  const waiting = requests.filter(request => request.state === 'waiting').length, pending = requests.filter(request => request.state === 'pending').length;
  counted(ui.requests, nodes.length ? waiting : 0, waiting ? 'amber' : 'neutral', `${plural(waiting, 'request')} waiting${pending ? `, ${pending} sending` : ''}`);
  ui.requests.node.hidden = !nodes.length;
  return waiting;
}

function renderFailures() {
  const failures = failedSessions();
  list(ui.failures.list, failures.map(session => {
    const id = session.id, name = terminalName(id), place = where(id);
    return {key:id, render:JSON.stringify([name, place, session.cwd, session.exitCode]), build:() => el('article', {class:'needs-item'},
      programTile(),
      el('div', {class:'needs-item-text'}, el('b', {text:name}), el('span', {text:place}), el('span', {class:'needs-folder'}, pathText(session.cwd, ''))),
      badge(`Failed · exit ${session.exitCode}`, 'red'),
      el('div', {class:'needs-item-actions'},
        el('button', {class:'btn sm', type:'button', dataset:{focus:'open'}, onclick:() => showTerminal(id)}, icon('square-terminal'), 'Open terminal'),
        el('button', {class:'btn ghost sm', type:'button', dataset:{focus:'close'}, text:'Close…', 'aria-label':`Close ${name}`, onclick:() => closeTerminals([id])})))};
  }));
  counted(ui.failures, failures.length, 'red', plural(failures.length, 'failed terminal'));
  return failures.length;
}

function excerpt(text = '') {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 180 ? `${line.slice(0, 180)}…` : line;
}
function renderReplies() {
  const unread = state.replies.filter(reply => !reply.read).reverse(), shown = unread.slice(0, REPLY_LIMIT);
  const items = shown.map(reply => {
    const open = state.sessions.has(reply.id), name = open ? terminalName(reply.id) : 'Closed terminal';
    return {key:`reply:${reply.seq}`, render:JSON.stringify([name, reply.label, reply.at ? ago(reply.at) : '', open]), build:() => el('article', {class:'needs-item'},
      programTile(),
      el('div', {class:'needs-item-text'}, el('b', {text:`${reply.label || 'Agent'} replied`}),
        el('span', {text:`${name}${open ? ` · ${workspaceLabel(workspaceOf(reply.id))}` : ''}${reply.at ? ` · ${ago(reply.at)}` : ''}`}),
        el('p', {class:'needs-excerpt', text:excerpt(reply.text)})),
      el('div', {class:'needs-item-actions'},
        el('button', {class:'btn sm', type:'button', dataset:{focus:'read'}, onclick:() => go('reader', {reply:reply.seq})}, icon('book-open-text'), 'Read reply')))};
  });
  if (unread.length > shown.length) items.push({key:'more', render:String(unread.length - shown.length), build:() => el('div', {class:'needs-more'},
    el('button', {class:'btn ghost sm', type:'button', dataset:{focus:'more'}, text:`${unread.length - shown.length} more in Reader`, onclick:() => go('reader')}))});
  list(ui.replies.list, items);
  counted(ui.replies, unread.length, 'neutral', plural(unread.length, 'unread reply', 'unread replies'));
  return unread.length;
}

// Running programs whose requests Webterminal cannot see: an honest Unknown.
function renderUnknown() {
  const bridge = id => state.programs?.programs?.find(program => program.id === id)?.bridge;
  const hidden = session => {
    const status = terminalStatus(session.id), kind = bridge(session.program);
    return session.alive && session.program && status.key !== 'needs' && (status.unknown || (kind && kind !== 'requests'));
  };
  const ids = [...state.sessions.values()].filter(hidden).map(session => session.id);
  list(ui.unknown.list, ids.map(id => {
    const name = terminalName(id), place = where(id);
    return {key:id, render:JSON.stringify([name, place]), build:() => el('article', {class:'needs-item quiet'},
      programTile(),
      el('div', {class:'needs-item-text'}, el('b', {text:name}), el('span', {text:place})),
      badge('Unknown'),
      el('div', {class:'needs-item-actions'}, el('button', {class:'btn sm', type:'button', dataset:{focus:'open'}, onclick:() => showTerminal(id)}, icon('square-terminal'), 'Open terminal')))};
  }));
  counted(ui.unknown, ids.length, 'neutral', plural(ids.length, 'terminal'));
}

// Scrolls only the page's own content; scrollIntoView would also shift
// overflow-hidden ancestors and push the top bar out of view.
function scrollTo(node) {
  const content = $('attention-content');
  content.scrollTop += node.getBoundingClientRect().top - content.getBoundingClientRect().top - 16;
}
// A deep link to a request scrolls to its card, or says it is gone.
function reveal() {
  if (!target) return;
  const id = target.request;
  if (id === undefined || id === null) { target = null; return; }
  const card = cards.get(id);
  if (card) {
    target = null;
    setNote(null);
    scrollTo(card.node);
    card.focus();
    return;
  }
  if (!state.connected) return;
  target = null;
  const record = requestRecord(id);
  setNote(record ? `${requestTitle(record)}: ${record.state === 'resolved' ? record.outcome || 'answered' : record.outcome || 'expired'}.` : '');
  $('attention-content').scrollTop = 0;
}
function setNote(text) {
  note = text;
  ui.note.hidden = note === null;
  if (note === null) { ui.note.replaceChildren(); return; }
  ui.note.replaceChildren(el('div', {role:'status'}, el('b', {text:'That request is no longer waiting.'}), note ? el('p', {text:note}) : null),
    el('button', {class:'icon-btn ghost sm', type:'button', 'aria-label':'Dismiss', onclick:() => { setNote(null); $('attention-title').focus(); }}, icon('x')));
}

export function show(next) {
  if (!ui) build();
  // Settled cards from an earlier visit are history, not something to do.
  watched.clear();
  setNote(null);
  handled = state.target;
  target = next;
}
export function render(topics) {
  if (!ui) build();
  if (topics.has('page') && state.target !== handled) { handled = state.target; target = state.target; }
  const requests = renderRequests(), failures = renderFailures(), replies = renderReplies();
  renderUnknown();
  ui.empty.hidden = Boolean(cards.size || failures || replies);
  $('attention-subtitle').textContent = requests || failures || replies
    ? [`${plural(requests, 'request')} waiting`, plural(failures, 'failure'), plural(replies, 'unread reply', 'unread replies')].join(' · ')
    : 'Agents waiting for an answer, programs that failed and replies you haven’t read.';
  reveal();
}

// Times move on without a server message while the page is visible.
setInterval(() => { if (ui && state.page === 'attention') render(new Set(['clock'])); }, 30000);
