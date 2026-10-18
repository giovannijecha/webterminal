// Opening terminals: the Open terminal dialog, the Split menu, recent
// folders and the folder picker. Program availability comes from the server.
import {ask} from './connection.js';
import {PANE_LIMIT, SESSION_LIMIT, WORKSPACE_LIMIT, changed, currentWorkspace, focusedId, shellLabel, state, workspaceById, workspaceLabel} from './model.js';
import {el, icon, programTile, storage} from './dom.js';
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

let programLoad = null;
export function loadPrograms() {
  if (programLoad) return programLoad;
  programLoad = (async () => {
    try {
      const response = await fetch('/api/programs', {cache:'no-store'});
      if (!response.ok) throw new Error();
      state.programs = await response.json();
    } catch {
      state.programs = {...(state.programs || {hosted:false, programs:[]}), error:'Could not check installed programs.'};
    }
    changed('programs');
    return state.programs;
  })();
  void programLoad.finally(() => { programLoad = null; });
  return programLoad;
}
// PowerShell first, then each optional program with its real availability.
function choices() {
  const hosted = Boolean(state.programs?.hosted);
  return [{id:'', label:shellLabel(state.hello?.shell), available:true}, ...(state.programs?.programs || []).map(program => ({
    id:program.id, label:program.label, available:hosted && program.available,
    reason:!hosted ? 'Needs Windows PowerShell as the shell' : program.available ? '' : 'Not found on PATH',
  }))];
}

// Returns '' on success or the problem to show.
export async function launch({cwd, program = '', workspace = state.selected}) {
  if (state.sessions.size >= SESSION_LIMIT) return `Webterminal runs up to ${SESSION_LIMIT} terminals. Close one to open another.`;
  let target = workspace && workspace !== 'new' ? workspaceById(workspace) : null;
  if (target && target.sessions.length >= PANE_LIMIT) return `${workspaceLabel(target)} already holds ${PANE_LIMIT} terminals.`;
  if (!target) {
    const created = await createWorkspace({select:false});
    if (!created) return 'Could not create a workspace for the terminal.';
    target = workspaceById(created);
  }
  try {
    const command = {op:'create', cwd, workspace:target.id, updates:true, ...hooks.estimate(target.sessions.length + 1)};
    if (program) command.program = program;
    const reply = await ask(command);
    if (!reply) return 'Connection is unavailable. Reconnecting…';
    remember(cwd);
    hooks.created(reply, {cwd, program:program || null});
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

function programCards(selected) {
  const group = el('div', {class:'overlay-programs', role:'radiogroup', 'aria-labelledby':'launch-programs-label'});
  const cards = choices().map(item => el('button', {
    type:'button', class:'overlay-program', role:'radio', 'aria-checked':String(item.id === selected), 'aria-disabled':item.available ? null : 'true',
    tabindex:item.id === selected ? '0' : '-1', title:item.reason || null, dataset:{program:item.id},
  }, programTile(), el('span', {text:item.label}), item.available ? null : el('span', {class:'muted', text:'Unavailable'})));
  const enabled = () => cards.filter(card => card.getAttribute('aria-disabled') !== 'true');
  const select = card => {
    for (const other of cards) { other.setAttribute('aria-checked', String(other === card)); other.tabIndex = other === card ? 0 : -1; }
    card.focus();
  };
  for (const card of cards) {
    card.addEventListener('click', () => { if (card.getAttribute('aria-disabled') !== 'true') select(card); });
    card.addEventListener('keydown', event => {
      const list = enabled(), index = list.indexOf(card);
      const step = {ArrowRight:1, ArrowDown:1, ArrowLeft:-1, ArrowUp:-1}[event.key];
      if (!step || index < 0) return;
      event.preventDefault();
      select(list[(index + step + list.length) % list.length]);
    });
  }
  group.append(...cards);
  return {group, value:() => cards.find(card => card.getAttribute('aria-checked') === 'true')?.dataset.program || ''};
}

// The Open terminal dialog: program, folder and destination workspace.
let launcherPending = null;
export function openLauncher({workspace = state.selected, program = '', cwd = splitFolder()} = {}) {
  if (launcherPending) { document.querySelector('dialog.launcher[open] .overlay-program[aria-checked="true"]')?.focus(); return launcherPending; }
  if (!state.connected) { problem('Connection is unavailable', 'Reconnecting to the local server…'); return; }
  if (state.sessions.size >= SESSION_LIMIT) { problem('Limit reached', `Webterminal runs up to ${SESSION_LIMIT} terminals. Close one to open another.`); return; }
  let programs = programCards(choices().some(item => item.id === program && item.available) ? program : '');
  const programArea = el('div', {}, programs.group);
  const programStatus = el('p', {class:'help', role:'status'});
  const retryPrograms = el('button', {class:'btn ghost sm', type:'button', text:'Retry program check'});
  const updateProgramStatus = loading => {
    programStatus.textContent = loading ? 'Checking installed programs…' : state.programs?.error || '';
    retryPrograms.hidden = loading || !state.programs?.error;
  };
  let live = true;
  const refreshPrograms = async () => {
    updateProgramStatus(true);
    await loadPrograms();
    if (!live) return;
    const selected = programs.value();
    const focused = programArea.contains(document.activeElement);
    programs = programCards(choices().some(item => item.id === selected && item.available) ? selected : '');
    programArea.replaceChildren(programs.group);
    updateProgramStatus(false);
    if (focused) programs.group.querySelector('[aria-checked="true"]')?.focus();
  };
  retryPrograms.addEventListener('click', refreshPrograms);
  updateProgramStatus(!state.programs);
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
  launcherPending = dialogs.show({
    title:'Open terminal', description:'Start PowerShell, or an agent inside it.', action:'Open terminal', className:'launcher',
    initial:'.overlay-program[aria-checked=true]',
    body:[
      el('div', {}, el('span', {class:'lbl', id:'launch-programs-label', text:'Start with'}), programArea, programStatus, retryPrograms),
      el('div', {}, el('label', {class:'lbl', for:'launch-folder', text:'Folder'}), el('div', {class:'folder-row'}, folder, recent, browse), el('p', {class:'help', text:'Choose a recent folder or enter a full Windows path.'})),
      el('div', {}, el('span', {class:'lbl', id:'launch-workspace-label', text:'Workspace'}), combobox.root, destination),
    ],
    onSubmit:async () => {
      const path = folder.value.trim();
      Dialogs.invalid(folder, '');
      if (!path) { Dialogs.invalid(folder, 'Enter a folder path.'); return false; }
      if (!absolute(path)) { Dialogs.invalid(folder, 'Enter a full path, for example C:\\dev\\webterminal.'); return false; }
      return await launch({cwd:path, program:programs.value(), workspace:select.value}) || undefined;
    },
  }).finally(() => { live = false; launcherPending = null; });
  void refreshPrograms();
  return launcherPending;
}

// Split: a new terminal next to the focused one, in its folder.
export function splitMenu() {
  const workspace = currentWorkspace(), folder = splitFolder();
  const full = !workspace || workspace.sessions.length >= PANE_LIMIT;
  const start = program => () => createTerminal({cwd:folder, program, workspace:workspace?.id});
  return [
    {head:`Opens in ${displayPath(folder)}`},
    ...choices().map(item => ({
      label:item.id ? `${choices()[0].label} with ${item.label}` : item.label, icon:item.id ? 'sparkles' : 'square-terminal',
      disabled:full || !item.available, hint:item.available ? '' : 'Unavailable', title:item.reason, action:start(item.id),
    })),
    {separator:true},
    {label:'Choose folder…', icon:'folder-open', disabled:full, action:() => chooseFolder(path => createTerminal({cwd:path, workspace:workspace?.id}))},
  ];
}
export function showSplitMenu(anchor) {
  loadPrograms();
  menu.toggle(anchor, splitMenu, {label:'Split'});
}
