// Opening terminals: the Open terminal dialog, the Split menu, recent
// folders and the folder picker. Every terminal starts the server's shell;
// programs are started by typing their command in it.
import {ask} from './connection.js';
import {PANE_LIMIT, SESSION_LIMIT, WORKSPACE_LIMIT, currentWorkspace, focusedId, shellLabel, state, workspaceById, workspaceLabel} from './model.js';
import {el, icon, storage} from './dom.js';
import {displayPath} from './common.js';
import {DirectoryPicker} from './directory.js';
import {Dialogs, choice} from './overlays.js';
import {dialogs, menu, problem} from './ui.js';
import {createWorkspace} from './actions.js';

const hooks = {estimate:() => ({cols:120, rows:30}), created() {}};
export function configureLauncher(next) { Object.assign(hooks, next); }

const local = storage('local'), RECENT = 'webterminal.recentFolders';
function recentFolders() {
  let saved = [];
  try { saved = JSON.parse(local.get(RECENT) || '[]'); } catch { /* Start empty. */ }
  return [...new Set([...(Array.isArray(saved) ? saved : []), startFolder()].filter(path => typeof path === 'string' && path))].slice(0, 8);
}
function remember(path) { local.set(RECENT, JSON.stringify([path, ...recentFolders().filter(item => item !== path)].slice(0, 8))); }

export function startFolder() { return state.settings?.settings?.startFolder || state.hello?.cwd || ''; }
export function splitFolder() { return state.sessions.get(focusedId())?.cwd || startFolder(); }
const absolute = path => /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]/.test(path);

// Returns '' on success or the problem to show.
export async function launch({cwd, workspace = state.selected}) {
  if (state.sessions.size >= SESSION_LIMIT) return `Webterminal runs up to ${SESSION_LIMIT} terminals. Close one to open another.`;
  let target = workspace && workspace !== 'new' ? workspaceById(workspace) : null;
  if (target && target.sessions.length >= PANE_LIMIT) return `${workspaceLabel(target)} already holds ${PANE_LIMIT} terminals.`;
  if (!target) {
    const created = await createWorkspace({select:false});
    if (!created) return 'Could not create a workspace for the terminal.';
    target = workspaceById(created);
  }
  try {
    const reply = await ask({op:'create', cwd, workspace:target.id, updates:true, ...hooks.estimate(target.sessions.length + 1)});
    if (!reply) return 'Connection is unavailable. Reconnecting…';
    remember(cwd);
    hooks.created(reply, {cwd});
    return '';
  } catch (error) { return error.message; }
}
export async function createTerminal(options) {
  const error = await launch(options);
  if (error) problem('Could not open terminal', error);
  return !error;
}

let pick = null, from = splitFolder;
const picker = new DirectoryPicker({startDirectory:() => from(), create:path => { pick?.(path); return true; }});
// The picker only hands the chosen path to `handle`; it never opens a terminal itself.
export function chooseFolder(handle, start = splitFolder) { pick = handle; from = start; picker.open(); }

// The Open terminal dialog: folder and destination workspace.
let launcherPending = null, launcherFolder = null;
export function openLauncher({workspace = state.selected, cwd = splitFolder()} = {}) {
  if (launcherPending) {
    const dialog = launcherFolder?.closest?.('dialog');
    if (dialog && !dialog.open) { launcherPending = null; launcherFolder = null; }
    else { if (dialog?.open) launcherFolder.focus(); return launcherPending; }
  }
  if (!state.connected) { problem('Connection is unavailable', 'Reconnecting to the local server…'); return; }
  if (state.sessions.size >= SESSION_LIMIT) { problem('Limit reached', `Webterminal runs up to ${SESSION_LIMIT} terminals. Close one to open another.`); return; }
  const folder = el('input', {class:'field mono', id:'launch-folder', value:displayPath(cwd), autocomplete:'off', spellcheck:'false'});
  const recent = el('button', {type:'button', class:'btn ghost', 'aria-haspopup':'menu'}, el('span', {text:'Recent folders'}), icon('chevron-down', 'sm'));
  const browse = el('button', {type:'button', class:'btn ghost'}, icon('folder-open'), el('span', {text:'Browse…'}));
  recent.addEventListener('click', () => menu.toggle(recent, recentFolders().map(path => ({label:displayPath(path), action:() => { folder.value = displayPath(path); folder.focus(); }})), {label:'Recent folders'}));
  browse.addEventListener('click', () => chooseFolder(path => { folder.value = displayPath(path); folder.focus(); }));
  const select = el('select', {id:'launch-workspace'});
  const preferred = workspaceById(workspace);
  for (const item of state.workspaces) {
    const full = item.sessions.length >= PANE_LIMIT;
    select.append(el('option', {value:item.id, disabled:full, text:full ? `${workspaceLabel(item)} — Full` : workspaceLabel(item)}));
  }
  select.append(el('option', {value:'new', disabled:state.workspaces.length >= WORKSPACE_LIMIT, text:'New workspace'}));
  select.value = preferred && preferred.sessions.length < PANE_LIMIT ? preferred.id : [...select.options].find(option => !option.disabled)?.value || 'new';
  const destination = el('p', {class:'help', id:'launch-destination'});
  const describe = () => { destination.textContent = `Destination: ${select.value === 'new' ? 'a new workspace' : workspaceLabel(workspaceById(select.value))}`; };
  select.addEventListener('change', describe);
  describe();
  const combobox = choice(select, 'Workspace');
  const pending = dialogs.show({
    title:'Open terminal', description:`Start ${shellLabel(state.hello?.shell)} in a folder, then run any program by typing its command.`, action:'Open terminal', className:'launcher',
    initial:folder,
    body:[
      el('div', {}, el('label', {class:'lbl', for:'launch-folder', text:'Folder'}), el('div', {class:'folder-row'}, folder, recent, browse), el('p', {class:'help', text:'Choose a recent folder or enter a full Windows path.'})),
      el('div', {}, el('span', {class:'lbl', id:'launch-workspace-label', text:'Workspace'}), combobox.root, destination),
    ],
    onSubmit:async () => {
      const path = folder.value.trim();
      Dialogs.invalid(folder, '');
      if (!path) { Dialogs.invalid(folder, 'Enter a folder path.'); return false; }
      if (!absolute(path)) { Dialogs.invalid(folder, 'Enter a full path, for example C:\\dev\\webterminal.'); return false; }
      return await launch({cwd:path, workspace:select.value}) || undefined;
    },
  }).finally(() => { if (launcherPending === pending) { launcherPending = null; launcherFolder = null; } });
  launcherPending = pending;
  launcherFolder = folder;
  return pending;
}

// Split: a new terminal next to the focused one, in its folder.
export function splitMenu() {
  const workspace = currentWorkspace(), folder = splitFolder();
  const full = !workspace || workspace.sessions.length >= PANE_LIMIT;
  return [
    {head:`Opens in ${displayPath(folder)}`},
    {label:shellLabel(state.hello?.shell), icon:'square-terminal', disabled:full, action:() => createTerminal({cwd:folder, workspace:workspace?.id})},
    {separator:true},
    {label:'Choose folder…', icon:'folder-open', disabled:full, action:() => chooseFolder(path => createTerminal({cwd:path, workspace:workspace?.id}))},
  ];
}
export function showSplitMenu(anchor) {
  menu.toggle(anchor, splitMenu, {label:'Split'});
}
