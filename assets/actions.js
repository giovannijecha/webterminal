// User actions on terminals, workspaces and the server, with their
// confirmations and toast feedback. The server re-checks every action.
import {ask, queueInput, send} from './connection.js';
import {PANE_LIMIT, WORKSPACE_LIMIT, changed, control, go, sessionShell, showTerminal, state, terminalName, terminalPlace, terminalStatus, workspaceById, workspaceIndex, workspaceLabel, workspaceOf} from './model.js';
import {el, plural} from './dom.js';
import {dialogs, menu, notify, problem} from './ui.js';

const hooks = {geometry:() => null, find() {}, copy() {}, launch() {}};
export function configureActions(next) { Object.assign(hooks, next); }

export function nameProblem(name) {
  if ([...name.trim()].length > 80) return 'Use 80 characters or fewer.';
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return 'Use a single line without control characters.';
  return '';
}
function failure(title, error) { problem(title, error?.message || String(error || 'The server refused the request.')); }

export async function createWorkspace({select = true} = {}) {
  if (state.workspaces.length >= WORKSPACE_LIMIT) { problem('Limit reached', `Webterminal keeps up to ${WORKSPACE_LIMIT} workspaces.`); return null; }
  try {
    const reply = await ask({op:'create-workspace'});
    if (!reply) return null;
    if (!workspaceById(reply.id)) state.workspaces.push({id:reply.id, name:null, sessions:[]});
    if (select) { state.selected = reply.id; go('workspace'); }
    changed('sessions');
    return reply.id;
  } catch (error) { failure('Could not create workspace', error); return null; }
}

// Renames through a dialog; `inline` editors call `rename*` directly.
export function renameTerminal(id) {
  const current = state.sessions.get(id);
  if (!current) return;
  const field = el('input', {class:'field', id:'rename-terminal', value:current.name || terminalName(id), maxlength:'200', autocomplete:'off', spellcheck:'false'});
  dialogs.show({
    title:'Rename terminal', description:'Choose the name shown in the sidebar and pane header.', action:'Save name', initial:field,
    body:el('div', {}, el('label', {class:'lbl', for:'rename-terminal', text:'Terminal name'}), field, el('p', {class:'help', text:'Leave empty to use the program’s title.'})),
    onSubmit:() => {
      const error = nameProblem(field.value);
      if (error) { field.setAttribute('aria-invalid', 'true'); return error; }
      return renameSession(id, field.value) ? undefined : false;
    },
  });
}
export function renameSession(id, name) {
  const current = state.sessions.get(id);
  if (!current || nameProblem(name)) return false;
  if (!send({op:'rename', id, name})) return false;
  state.sessions.set(id, {...current, name:name.trim() || null});
  changed('sessions');
  return true;
}
export function renameWorkspaceDialog(id) {
  const workspace = workspaceById(id);
  if (!workspace) return;
  const field = el('input', {class:'field', id:'rename-workspace', value:workspaceLabel(workspace), maxlength:'200', autocomplete:'off', spellcheck:'false'});
  dialogs.show({
    title:'Rename workspace', description:'Choose the name shown in the sidebar and header.', action:'Save name', initial:field,
    body:el('div', {}, el('label', {class:'lbl', for:'rename-workspace', text:'Workspace name'}), field, el('p', {class:'help', text:'Leave empty to name it after its first folder.'})),
    onSubmit:() => nameProblem(field.value) || (renameWorkspace(id, field.value) ? undefined : false),
  });
}
export function renameWorkspace(id, name) {
  const workspace = workspaceById(id);
  if (!workspace || nameProblem(name)) return false;
  if (name.trim() === workspaceLabel(workspace) && !workspace.name) return true;
  if (!send({op:'rename-workspace', id, name})) return false;
  workspace.name = name.trim() || null;
  changed('sessions');
  return true;
}

export function orderWorkspaces(ids) {
  if (!send({op:'order-workspaces', ids})) return;
  state.workspaces.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  changed('sessions');
}

// Moves a terminal; a toast offers a guarded Undo back to its old place.
export function moveTerminal(id, target, position, {undo = true} = {}) {
  const source = workspaceOf(id), destination = workspaceById(target);
  if (!source || !destination) return false;
  if (source !== destination && destination.sessions.length >= PANE_LIMIT) { problem('Workspace full', `${workspaceLabel(destination)} already holds ${PANE_LIMIT} terminals.`); return false; }
  const from = source.sessions.indexOf(id);
  position = Math.max(0, Math.min(position ?? destination.sessions.length, destination.sessions.length - (source === destination ? 1 : 0)));
  if (source === destination && position === from) return true;
  if (!send({op:'move', id, workspace:target, position})) return false;
  source.sessions = source.sessions.filter(item => item !== id);
  destination.sessions.splice(Math.min(position, destination.sessions.length), 0, id);
  changed('sessions');
  if (undo && source !== destination) {
    notify(`Moved to ${workspaceLabel(destination)}`, terminalName(id), {label:'Undo', run:() => {
      const back = workspaceById(source.id);
      if (!state.sessions.has(id) || !back || back.sessions.length >= PANE_LIMIT || !moveTerminal(id, source.id, from, {undo:false})) {
        problem('Could not undo move', 'The previous workspace is full or no longer available.');
        return;
      }
      notify('Move undone', `${terminalName(id)} · ${workspaceLabel(back)}`);
    }});
  }
  return true;
}

// The exact terminals a confirmation names; busy ones say why they need it.
function targetList(ids, busy = []) {
  return el('ul', {class:'target-list', 'aria-label':'Terminals to close'}, ids.map(id => {
    const place = busy.includes(id) ? `Running a program · ${terminalPlace(id)}` : terminalPlace(id);
    return el('li', {}, el('b', {text:terminalName(id), title:terminalName(id)}), el('span', {text:place, title:place}));
  }));
}
const sameSet = (a, b) => a.length === b.length && a.every(id => b.includes(id));
const RECONFIRM_LIMIT = 3;

// Closes exactly `ids`. Terminals idle at their shell close at once; a
// program still running, or an explicit bulk selection (`confirm`), asks
// first. The confirmed set is revalidated and only ever shrinks.
export async function closeTerminals(ids, {confirm = false} = {}) {
  ids = [...new Set(ids)].filter(id => state.sessions.has(id));
  if (!ids.length) return false;
  const request = (targets, force) => {
    const key = JSON.stringify(targets);
    return ask({op:'close-sessions', ids:targets, force}, message => message.type === 'closed' && JSON.stringify(message.ids) === key);
  };
  try {
    let reply = confirm ? {type:'busy', sessions:[]} : await request(ids, false);
    for (let round = 0; reply?.type === 'busy'; round++) {
      if (round >= RECONFIRM_LIMIT) { problem('Terminals not closed', 'They kept changing while you were confirming. Try again.'); return false; }
      const busy = reply.sessions || [], single = ids.length === 1;
      const confirmed = await dialogs.confirm({
        title:single ? 'Close terminal?' : `Close ${ids.length} terminals?`,
        description:busy.length ? `${busy.length === 1 ? 'A program is' : 'Programs are'} still running. Closing stops ${busy.length === 1 ? 'it' : 'them'} and removes staged files.` : 'Closing stops their programs and removes their staged files.',
        body:targetList(ids, busy), cancelLabel:single ? 'Keep terminal' : 'Keep terminals', action:single ? 'Close terminal' : `Close ${ids.length} terminals`,
      });
      if (!confirmed) return false;
      // Terminals closed elsewhere meanwhile drop out; the rest are confirmed again.
      const remaining = ids.filter(id => state.sessions.has(id));
      if (!remaining.length) return false;
      if (remaining.length !== ids.length) { ids = remaining; reply = {type:'busy', sessions:busy.filter(id => remaining.includes(id))}; continue; }
      reply = await request(ids, true);
    }
    if (!reply) return false;
    notify(ids.length === 1 ? 'Terminal closed' : `${ids.length} terminals closed`, ids.length === 1 ? terminalName(ids[0]) : '');
    return true;
  } catch (error) { failure('Terminals not closed', error); return false; }
}
// Closes an unchanged empty or idle workspace at once. Busy or changed
// workspaces need confirmation of the server's exact target set.
export async function closeWorkspace(id) {
  const workspace = workspaceById(id);
  if (!workspace) return false;
  const name = workspaceLabel(workspace);
  // Success has no direct reply; the next list no longer holds the workspace.
  const gone = message => message.type === 'sessions' && !(message.workspaces || []).some(item => item.id === id);
  try {
    let reply = await ask({op:'close-workspace', id, targets:[...workspace.sessions]}, gone);
    for (let round = 0; reply?.type === 'busy'; round++) {
      if (round >= RECONFIRM_LIMIT) { problem('Workspace not closed', 'Its terminals kept changing while you were confirming. Try again.'); return false; }
      const targets = reply.targets || [], busy = reply.sessions || [];
      const confirmed = await dialogs.confirm({
        title:round || !busy.length ? 'Workspace changed' : 'Close workspace?',
        description:busy.length ? `${round ? 'Its terminals changed. ' : ''}${busy.length === 1 ? 'A program is' : 'Programs are'} still running. Closing the workspace stops ${plural(targets.length, 'terminal')}.` : `Its terminals changed. Closing the workspace stops ${plural(targets.length, 'terminal')}.`,
        body:targetList(targets, busy), cancelLabel:'Keep workspace', action:'Close workspace', origin:name,
      });
      if (!confirmed) return false;
      const current = workspaceById(id);
      if (!current) return false;
      if (!sameSet(targets, current.sessions)) { problem('Workspace changed', 'Its terminals changed while you were confirming. Review them and try again.'); return false; }
      reply = await ask({op:'close-workspace', id, targets, force:true}, gone);
    }
    if (!reply) return false;
    notify('Workspace closed', name);
    return true;
  } catch (error) { failure('Workspace not closed', error); return false; }
}

export function takeControl(id) {
  const size = hooks.geometry(id);
  if (!size) { problem('Open the terminal first', 'Take control from its workspace so the terminal can match your window.'); return; }
  if (send({op:'claim', id, ...size})) notify('You have control', 'Your keyboard now reaches this terminal. The other view is watching.');
}
// Ctrl+C reaches the program only through this view's control.
export function interrupt(id) {
  if (!control(id).can) { problem('Take control first', 'Only the view that controls a terminal can interrupt it.'); return false; }
  const error = queueInput(id, '\x03');
  if (error) { problem('Interrupt not sent', error); return false; }
  notify('Interrupt sent', terminalName(id));
  return true;
}

export async function stopServer() {
  const count = state.sessions.size;
  const confirmed = await dialogs.confirm({
    title:'Stop server?', description:`${count ? `${plural(count, 'terminal')} will close and their programs will stop.` : 'No terminals are open.'} Every browser view disconnects, and the server exits.`,
    cancelLabel:'Keep running', action:'Stop server',
  });
  if (!confirmed) return;
  const reply = await ask({op:'stop-server', confirmed:true}, message => message.type === 'server-stopping').catch(error => { failure('Server not stopped', error); return null; });
  if (reply) { state.stopping = true; changed('connection'); notify('Server stopping', 'Start Webterminal again from its console to reconnect.'); }
}

// Menus name their target in a header, put the state action first and the
// destructive action last, after a separator.
export function workspaceMenu(id) {
  const workspace = workspaceById(id);
  if (!workspace) return [];
  const label = workspaceLabel(workspace), count = workspace.sessions.length, full = count >= PANE_LIMIT;
  return [
    {head:label, detail:`${count} of ${PANE_LIMIT} terminals`, avatar:[workspaceIndex(workspace), label]},
    {label:'New terminal here', disabled:full, hint:full ? 'Full' : '', action:() => hooks.launch({workspace:id})},
    {label:'Rename workspace…', action:() => renameWorkspaceDialog(id)},
    {separator:true},
    {label:'Close workspace', danger:true, action:() => closeWorkspace(id)},
  ];
}
// Moves between workspaces, and earlier or later inside the current one, so
// the keyboard reaches what pane-header dragging does.
function moveMenu(id) {
  const current = workspaceOf(id), index = current ? current.sessions.indexOf(id) : -1, count = current?.sessions.length || 0;
  return [
    ...count > 1 ? [
      {label:'Earlier in this workspace', disabled:index <= 0, action:() => moveTerminal(id, current.id, index - 1)},
      {label:'Later in this workspace', disabled:index >= count - 1, action:() => moveTerminal(id, current.id, index + 1)},
      {separator:true},
    ] : [],
    ...state.workspaces.map(workspace => ({
      label:workspaceLabel(workspace), hint:`${workspace.sessions.length}/${PANE_LIMIT}`, checked:workspace === current,
      disabled:workspace !== current && workspace.sessions.length >= PANE_LIMIT, action:() => moveTerminal(id, workspace.id),
    })),
    {separator:true},
    {label:'New workspace', disabled:state.workspaces.length >= WORKSPACE_LIMIT, action:async () => {
      const created = await createWorkspace({select:false});
      if (created) moveTerminal(id, created);
    }},
  ];
}
// The shared terminal menu for pane heads, Overview rows and Processes.
export function terminalMenu(id, {here = false} = {}) {
  if (!state.sessions.has(id)) return [];
  const owner = control(id), shot = state.snapshots.get(id), status = terminalStatus(id);
  const claim = shot?.alive && !owner.mine && here;
  return [
    {head:terminalName(id), detail:`${sessionShell(state.sessions.get(id))} · ${status.label}`},
    claim ? {label:'Take control', disabled:!state.connected, title:state.connected ? '' : 'Reconnect before taking control', action:() => takeControl(id)} : null,
    claim ? {separator:true} : null,
    here ? null : {label:'Open terminal', action:() => showTerminal(id)},
    {label:'Rename…', action:() => renameTerminal(id)},
    here ? {label:'Find in history', hint:'Ctrl Shift F', action:() => hooks.find(id)} : null,
    here ? {label:'Copy all output', action:() => hooks.copy(id)} : null,
    {label:'Move to workspace', submenu:() => moveMenu(id)},
    {separator:true},
    {label:'Close terminal', danger:true, action:() => closeTerminals([id])},
  ].filter(Boolean);
}
export function showTerminalMenu(id, anchor, options) { menu.toggle(anchor, () => terminalMenu(id, options), {label:'Terminal actions'}); }
