// User actions on terminals, workspaces and the server, with their
// confirmations and Dock feedback. The server re-checks every action.
import {ask, queueInput, send} from './connection.js';
import {PANE_LIMIT, WORKSPACE_LIMIT, changed, control, go, showTerminal, state, terminalName, terminalPlace, workspaceById, workspaceLabel, workspaceOf} from './model.js';
import {el, plural, storage} from './dom.js';
import {dialogs, menu, notify, problem} from './ui.js';

const hooks = {geometry:() => null, find() {}, copy() {}, launch() {}, reply:() => null};
export function configureActions(next) { Object.assign(hooks, next); }

const session = storage('session');
const muted = new Set((() => { try { return JSON.parse(session.get('webterminal.muted') || '[]'); } catch { return []; } })());
export function isMuted(id) { return muted.has(id); }
function setMuted(id, value) {
  if (value) muted.add(id); else muted.delete(id);
  session.set('webterminal.muted', JSON.stringify([...muted].filter(item => state.sessions.has(item))));
  changed('sessions');
}

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

// Moves a terminal; the Dock offers a guarded Undo back to its old place.
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

function targetList(ids) {
  return el('ul', {class:'target-list', 'aria-label':'Terminals to close'}, ids.map(id => el('li', {}, el('b', {text:terminalName(id)}), el('span', {text:terminalPlace(id)}))));
}
// Closes exactly the confirmed terminals; a set that changed is refused.
export async function closeTerminals(ids) {
  ids = [...new Set(ids)].filter(id => state.sessions.has(id));
  if (!ids.length) return false;
  const single = ids.length === 1;
  const confirmed = await dialogs.confirm({
    title:single ? 'Close terminal?' : `Close ${ids.length} terminals?`,
    description:'Closing stops their programs and removes their staged files.',
    body:targetList(ids), cancelLabel:single ? 'Keep terminal' : 'Keep terminals', action:single ? 'Close terminal' : `Close ${ids.length} terminals`,
  });
  if (!confirmed) return false;
  try {
    const key = JSON.stringify(ids);
    const reply = await ask({op:'close-sessions', ids, force:true}, message => message.type === 'closed' && JSON.stringify(message.ids) === key);
    if (!reply) return false;
    notify(single ? 'Terminal closed' : `${ids.length} terminals closed`, single ? terminalName(ids[0]) : '');
    return true;
  } catch (error) { failure('Terminals not closed', error); return false; }
}
export async function closeWorkspace(id) {
  const workspace = workspaceById(id);
  if (!workspace) return;
  const ids = [...workspace.sessions], name = workspaceLabel(workspace);
  const confirmed = await dialogs.confirm({
    title:'Close workspace?', description:'All terminals in this workspace will close and their programs will stop.',
    body:ids.length ? targetList(ids) : null, cancelLabel:'Keep workspace', action:'Close workspace', origin:name,
  });
  if (!confirmed) return;
  // Success has no direct reply; the next list no longer holds the workspace.
  const gone = message => message.type === 'sessions' && !(message.workspaces || []).some(item => item.id === id);
  const reply = await ask({op:'close-workspace', id, force:true, confirmed:ids}, gone).catch(error => { failure('Workspace not closed', error); return null; });
  if (reply?.type === 'busy') { problem('Workspace changed', 'Its terminals changed while you were confirming. Review them and try again.'); return; }
  if (reply) notify('Workspace closed', name);
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

export function workspaceMenu(id) {
  const workspace = workspaceById(id);
  if (!workspace) return [];
  const full = workspace.sessions.length >= PANE_LIMIT;
  return [
    {label:'New terminal here', icon:'plus', disabled:full, hint:full ? 'Full' : '', action:() => hooks.launch({workspace:id})},
    {label:'Rename workspace', icon:'pencil', action:() => renameWorkspaceDialog(id)},
    {separator:true},
    {label:'Close workspace…', icon:'trash-2', danger:true, action:() => closeWorkspace(id)},
  ];
}
function moveMenu(id) {
  const current = workspaceOf(id);
  return [
    ...state.workspaces.map(workspace => ({
      label:workspaceLabel(workspace), hint:`${workspace.sessions.length}/${PANE_LIMIT}`, checked:workspace === current,
      disabled:workspace !== current && workspace.sessions.length >= PANE_LIMIT, action:() => moveTerminal(id, workspace.id),
    })),
    {separator:true},
    {label:'New workspace', icon:'plus', disabled:state.workspaces.length >= WORKSPACE_LIMIT, action:async () => {
      const created = await createWorkspace({select:false});
      if (created) moveTerminal(id, created);
    }},
  ];
}
// The shared terminal menu for pane heads, cards and processes.
export function terminalMenu(id, {here = false} = {}) {
  if (!state.sessions.has(id)) return [];
  const owner = control(id), shot = state.snapshots.get(id), reply = hooks.reply(id);
  return [
    {head:terminalName(id)},
    here ? null : {label:'Open terminal', icon:'square-terminal', action:() => showTerminal(id)},
    {label:'Rename…', icon:'pencil', action:() => renameTerminal(id)},
    here ? {label:'Find in history', icon:'text-search', hint:'Ctrl Shift F', action:() => hooks.find(id)} : null,
    here ? {label:'Copy all output', icon:'copy', action:() => hooks.copy(id)} : null,
    reply ? {label:'Open latest reply', icon:'book-open-text', action:() => go('reader', {reply:reply.seq})} : null,
    {label:'Move to workspace', icon:'arrow-right-left', submenu:() => moveMenu(id)},
    shot?.alive && !owner.mine && here ? {label:'Take control', icon:'hand', disabled:!state.connected, action:() => takeControl(id)} : null,
    isMuted(id) ? {label:'Turn notifications on', icon:'bell', action:() => setMuted(id, false)} : {label:'Mute notifications', icon:'bell-off', action:() => setMuted(id, true)},
    {separator:true},
    {label:'Close terminal…', icon:'square-x', danger:true, action:() => closeTerminals([id])},
  ].filter(Boolean);
}
export function showTerminalMenu(id, anchor, options) { menu.toggle(anchor, () => terminalMenu(id, options), {label:'Terminal actions', back:'Back to terminal actions'}); }
