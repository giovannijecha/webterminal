// The Direct request card: one agent request with its exact evidence and a
// decision footer. An answer is sent at most once, only under this view's
// control; the server re-checks control, epoch and revision, and its refusal
// is shown on the card.
import {ask} from './connection.js';
import {ago, badge, clock, el, icon, patch, pathText, programTile} from './dom.js';
import {control, programLabel, requestSummary, showTerminal, state, terminalName, workspaceLabel, workspaceOf} from './model.js';

const STATES = {waiting:['Waiting', 'amber'], pending:['Sending', 'neutral'], resolved:['Done', 'neutral'], expired:['Expired', 'neutral'], gone:['Expired', 'neutral']};
const REASONS = {
  Observing:['Another view has control', 'Answer from the view that controls this terminal, or open the terminal to take control there.'],
  'No controller':['No view has control', 'Open the terminal to take control, then answer here.'],
  Offline:['Offline', 'Answers can be sent again once Webterminal reconnects.'],
  Exited:['Exited', 'The program in this terminal has stopped.'],
};
const PREVIEW_LIMIT = 200000;
let serial = 0;

export function requestRecord(id) { return state.agents.requests.find(request => request.id === id) || null; }
function programOf(request) { return request.label || programLabel(state.sessions.get(request.session)) || 'Agent'; }
export function requestTitle(request) {
  const questions = request.evidence?.questions || [];
  if (request.kind === 'question') return questions.length > 1 ? `${programOf(request)} asks ${questions.length} questions` : requestSummary(request);
  return `${programOf(request)} ${requestSummary(request)}`;
}
// Readable JSON when the evidence is serialized JSON, the exact text otherwise.
function readable(text = '') {
  try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
}
function bounded(text = '') {
  return text.length > PREVIEW_LIMIT ? {text:text.slice(0, PREVIEW_LIMIT), cut:true} : {text, cut:false};
}
function code(label, text, {target = null, lines = null} = {}) {
  const shown = bounded(text);
  return el('section', {class:'request-evidence', 'aria-label':label},
    el('div', {class:'request-code-head'}, el('span', {text:label}), target),
    el('pre', {class:'request-code', tabindex:'0', role:'region', 'aria-label':label},
      lines ? el('code', {}, lines) : el('code', {text:shown.text || ' '})),
    shown.cut ? el('p', {class:'request-code-note', text:`Showing the first ${PREVIEW_LIMIT.toLocaleString()} characters.`}) : null);
}
function diffLines(old = '', next = '') {
  const lines = [];
  if (old) for (const line of bounded(old).text.split('\n')) lines.push(el('span', {class:'request-line remove'}, el('span', {class:'sr-only', text:'Removed: '}), `- ${line}`));
  for (const line of bounded(next).text.split('\n')) lines.push(el('span', {class:'request-line add'}, el('span', {class:'sr-only', text:'Added: '}), `+ ${line}`));
  return lines;
}

export class RequestCard {
  constructor(request) {
    this.id = request.id;
    this.record = request;
    this.busy = '';
    this.sent = '';
    this.error = '';
    this.invalid = -1;
    this.choices = new Map();
    const base = `request-${++serial}`;
    this.base = base;
    this.head = el('header', {class:'request-head'});
    this.lead = el('div', {class:'request-lead'});
    this.context = el('dl', {class:'request-context'});
    this.evidence = el('div', {class:'request-proof'});
    this.status = el('div', {class:'request-status'});
    this.foot = el('footer', {class:'request-foot'});
    this.node = el('article', {class:'request-card', 'aria-labelledby':`${base}-title`, dataset:{request:request.id}},
      this.head, el('div', {class:'request-body'}, this.lead, this.context, this.evidence, this.status), this.foot);
    this.update(request);
  }

  // `request` is the latest server record, or null once it left the list.
  update(request) {
    if (request) this.record = request;
    const record = this.record, gone = !request, stateName = gone ? 'gone' : record.state;
    const session = state.sessions.get(record.session), program = programOf(record);
    const own = control(record.session), shot = state.snapshots.get(record.session);
    const can = own.can && Boolean(shot), open = stateName === 'waiting' && !this.sent;
    const enabled = open && can && !this.busy;
    const reason = !can ? REASONS[own.label] || (own.can ? ['Not attached', 'Open the terminal in this view, then answer here.'] : ['Unavailable', '']) : null;
    const name = session ? terminalName(record.session) : 'Closed terminal', place = session ? workspaceLabel(workspaceOf(record.session)) : '';
    const active = this.node.contains(document.activeElement) ? document.activeElement : null, focus = active?.dataset.focus;
    this.node.dataset.state = stateName;
    this.node.toggleAttribute('aria-busy', Boolean(this.busy));

    const [label, tone] = this.sent && stateName === 'waiting' ? ['Sent', 'neutral'] : STATES[stateName] || STATES.expired;
    patch(this.head, JSON.stringify([program, name, place, label, tone]), () => [
      el('div', {class:'request-identity'}, programTile(), el('div', {}, el('b', {text:program}), el('span', {text:place ? `${name} · ${place}` : name}))),
      badge(label, tone),
    ]);
    const description = record.kind === 'command' ? record.evidence?.description || '' : '';
    patch(this.lead, JSON.stringify([requestTitle(record), description]), () => [
      el('h3', {id:`${this.base}-title`, tabindex:'-1', text:requestTitle(record)}),
      description ? el('p', {text:description}) : null,
    ]);
    const created = record.created ? `${clock(record.created)} · ${ago(record.created)}` : '';
    patch(this.context, JSON.stringify([name, place, session?.cwd, created]), () => [
      el('div', {}, el('dt', {text:'Terminal'}), el('dd', {text:name})),
      place ? el('div', {}, el('dt', {text:'Workspace'}), el('dd', {text:place})) : null,
      session ? el('div', {class:'request-context-wide'}, el('dt', {text:'Folder'}), el('dd', {}, pathText(session.cwd))) : null,
      created ? el('div', {class:'request-context-wide'}, el('dt', {text:'Requested'}), el('dd', {text:created})) : null,
    ]);
    const proof = JSON.stringify([record.kind, record.tool, record.evidence]);
    if (this.evidence.dataset.key !== proof) this.choices.clear();
    patch(this.evidence, proof, () => this.proof(record));
    for (const input of this.evidence.querySelectorAll('input')) input.disabled = !enabled;
    this.evidence.querySelectorAll('fieldset').forEach((set, index) => set.toggleAttribute('aria-invalid', index === this.invalid));

    patch(this.status, JSON.stringify([stateName, record.outcome, this.sent, this.busy, this.error, open && reason]), () => this.notes(record, stateName, open && reason, program));
    patch(this.foot, JSON.stringify([open, enabled, this.busy, record.scope, record.kind, Boolean(session), program]), () => this.actions(record, {open, enabled, session}));

    // Keep keyboard users on the card when the control they used was rebuilt.
    if (active && !active.isConnected) {
      const next = (focus && this.node.querySelector(`[data-focus="${focus}"]:not(:disabled)`)) || this.status.querySelector('[tabindex="-1"]') || this.lead.querySelector('h3');
      next?.focus({preventScroll:true});
    }
  }

  focus() { this.lead.querySelector('h3')?.focus({preventScroll:true}); }

  proof(record) {
    const evidence = record.evidence || {};
    if (record.kind === 'command') return code('Command', evidence.command || '');
    if (record.kind === 'edit') {
      const target = evidence.path ? el('code', {}, pathText(evidence.path, '')) : null;
      if (typeof evidence.input === 'string') return code('Edit', readable(evidence.input), {target});
      return code(evidence.old ? 'Edit' : 'New content', '', {target, lines:diffLines(evidence.old, evidence.new)});
    }
    if (record.kind === 'question') return this.questions(evidence.questions || []);
    return code('Tool input', readable(evidence.input || ''), {target:record.tool ? el('code', {text:record.tool}) : null});
  }

  questions(questions) {
    return el('div', {class:'request-questions'}, questions.map((item, index) => {
      const name = `${this.base}-q${index}`, chosen = this.choices.get(index) || new Set();
      const help = item.multiSelect ? 'Choose one or more.' : 'Choose one.';
      return el('fieldset', {class:'request-question', 'aria-describedby':`${name}-help`},
        el('legend', {}, item.header ? el('span', {class:'request-question-header', text:item.header}) : null, el('span', {class:'request-question-text', text:item.question})),
        el('p', {class:'request-question-help', id:`${name}-help`, text:help}),
        el('div', {class:'request-choices'}, (item.options || []).map((option, position) => {
          const id = `${name}-o${position}`;
          const input = el('input', {type:item.multiSelect ? 'checkbox' : 'radio', class:item.multiSelect ? 'check' : null, name, id, value:option.label, checked:chosen.has(option.label),
            dataset:{focus:`${index}:${position}`}, 'aria-describedby':option.description ? `${id}-description` : null,
            onchange:event => this.choose(index, option.label, event.target.checked, item.multiSelect)});
          return el('label', {class:'request-choice', for:id}, input,
            el('span', {}, el('b', {text:option.label}), option.description ? el('small', {id:`${id}-description`, text:option.description}) : null));
        })));
    }));
  }

  choose(index, label, checked, multiple) {
    const chosen = multiple ? new Set(this.choices.get(index)) : new Set();
    if (checked) chosen.add(label); else chosen.delete(label);
    this.choices.set(index, chosen);
    if (this.invalid === index) { this.invalid = -1; this.error = ''; this.update(requestRecord(this.id)); }
  }

  notes(record, stateName, reason, program) {
    const result = (title, text) => el('div', {class:'request-result', role:'status', tabindex:'-1'}, el('b', {text:title}), text ? el('p', {text}) : null);
    const items = [];
    if (this.busy) items.push(el('p', {class:'request-sending', role:'status'}, el('span', {class:'spinner', 'aria-hidden':'true'}), 'Sending your answer…'));
    else if (stateName === 'waiting' && this.sent) items.push(result('Answer sent', `Waiting for ${program} to receive it.`));
    else if (stateName === 'pending') items.push(result('Answer accepted', `${record.outcome ? `${record.outcome}. ` : ''}Waiting for ${program} to receive it.`));
    else if (stateName === 'resolved') items.push(result(record.outcome || 'Resolved', record.outcome === 'Answer in the terminal' ? 'Continue in the terminal.' : 'This request no longer needs you.'));
    else if (stateName === 'expired') items.push(result('No longer waiting', record.outcome || 'The request expired.'));
    else if (stateName === 'gone') items.push(result('No longer available', 'The server no longer lists this request.'));
    else if (reason) items.push(el('div', {class:'request-control'}, icon('eye', 'sm'), el('p', {}, el('b', {text:reason[0]}), reason[1] ? ` ${reason[1]}` : '')));
    if (this.error) items.push(el('p', {class:'request-error', role:'alert', text:this.error}));
    return items;
  }

  actions(record, {open, enabled, session}) {
    const button = (answer, text, primary = false) => el('button', {
      class:`btn${primary ? ' primary' : ''}`, type:'button', dataset:{focus:answer}, disabled:!open || (!enabled && !this.busy),
      'aria-disabled':this.busy ? 'true' : null, 'aria-busy':this.busy === answer ? 'true' : null,
      onclick:() => this.respond(answer),
    }, this.busy === answer ? 'Sending…' : text);
    const question = record.kind === 'question';
    const decisions = !open ? [] : question
      ? [button('terminal', 'Answer in terminal'), button('answers', 'Submit answers', true)]
      : [button('terminal', 'Answer in terminal'), button('deny', 'Deny'), record.scope ? button('allow-session', 'Allow for this session') : null, button('allow', 'Allow once', true)];
    const note = !open ? null : question ? 'Answers go to this terminal’s program only.'
      : record.scope ? `Allow for this session covers ${record.scope} in this program session only.` : 'Allow once covers this request only.';
    return [
      el('button', {class:'btn ghost request-open', type:'button', dataset:{focus:'open'}, disabled:!session, onclick:() => showTerminal(record.session)}, icon('square-terminal'), 'Open terminal'),
      decisions.length ? el('div', {class:'request-buttons'}, decisions) : null,
      note ? el('p', {class:'request-scope', text:note}) : null,
    ];
  }

  // Validates every question has an offered answer; multi-select joins labels.
  answers() {
    const result = {};
    for (const [index, item] of (this.record.evidence?.questions || []).entries()) {
      const chosen = (item.options || []).map(option => option.label).filter(label => this.choices.get(index)?.has(label));
      if (!chosen.length) {
        this.invalid = index;
        this.error = `Answer every question: ${item.question}`;
        this.update(requestRecord(this.id));
        this.evidence.querySelectorAll('fieldset')[index]?.querySelector('input')?.focus();
        return null;
      }
      result[item.question] = item.multiSelect ? chosen.join(', ') : chosen[0];
    }
    return result;
  }

  async respond(answer) {
    // The revision sent is the one on screen; a newer one is refused by the server.
    const record = this.record;
    if (this.busy || this.sent || requestRecord(this.id)?.state !== 'waiting') return;
    const answers = answer === 'answers' ? this.answers() : null;
    if (answer === 'answers' && !answers) return;
    const shot = state.snapshots.get(record.session);
    if (!control(record.session).can || !shot) {
      this.error = 'This view does not control the terminal. Open it and take control to answer.';
      this.update(record);
      return;
    }
    this.busy = answer;
    this.error = '';
    this.invalid = -1;
    this.update(record);
    try {
      const reply = await ask({op:'respond', id:record.id, revision:record.revision, epoch:shot.epoch, answer, ...(answers ? {answers} : {})},
        message => message.type === 'responded' && message.id === record.id);
      if (!reply) this.error = 'Not sent: the connection is unavailable.';
      else if (reply.type === 'responded') this.sent = answer;
      else this.error = 'The server is busy. Try again.';
    } catch (error) {
      this.error = error?.message || 'The server refused the answer.';
    }
    this.busy = '';
    this.update(requestRecord(this.id));
  }
}
