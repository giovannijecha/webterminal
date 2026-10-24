// Command palette, keyboard shortcut help and the few documented global keys.
// Keys typed inside a terminal reach the program, except the "Anywhere" ones.
import {avatar, badge, el, icon, plural} from './dom.js';
import {displayPath} from './common.js';
import {PANE_LIMIT, go, orderedSessions, sessionShell, shellLabel, showTerminal, state, terminalName, terminalStatus, workspaceById, workspaceIndex, workspaceLabel, workspaceOf} from './model.js';
import {dialogs, menu} from './ui.js';
import {createWorkspace} from './actions.js';
import {createTerminal, openLauncher, splitFolder} from './launcher.js';

export const PAGES = [
  {page:'overview', label:'Overview'},
  {page:'processes', label:'Processes'},
  {page:'files', label:'Dropped files'},
  {page:'settings', label:'Settings'},
];

function items(query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const match = text => words.every(word => text.toLowerCase().includes(word));
  const terminals = orderedSessions().map(id => {
    const session = state.sessions.get(id), workspace = workspaceOf(id), status = terminalStatus(id);
    return {group:'Terminals', status, title:terminalName(id), sub:`${sessionShell(session)} in ${workspaceLabel(workspace)}, ${displayPath(session.cwd)}`, run:() => showTerminal(id)};
  });
  const workspaces = state.workspaces.map(workspace => ({group:'Workspaces', workspace, title:workspaceLabel(workspace), sub:plural(workspace.sessions.length, 'terminal'),
    run:() => { state.selected = workspace.id; go('workspace'); }}));
  const here = state.page === 'workspace' ? workspaceById(state.selected) : null, folder = splitFolder();
  const actions = [
    {title:'New terminal', sub:'Choose a folder and a workspace', run:() => openLauncher({workspace:state.selected})},
    ...(here && here.sessions.length < PANE_LIMIT ? [
      {title:`New ${shellLabel(state.hello?.shell)} terminal here`, sub:displayPath(folder), run:() => createTerminal({cwd:folder, workspace:here.id})},
    ] : []),
    {title:'New workspace', sub:`An empty workspace for up to ${PANE_LIMIT} terminals`, run:() => createWorkspace()},
    {title:'Keyboard shortcuts', sub:'', run:() => showShortcuts()},
  ].map(item => ({group:'Actions', ...item}));
  const pages = PAGES.map(page => ({group:'Go to', title:page.label, sub:'', run:() => go(page.page)}));
  return [...terminals, ...workspaces, ...actions, ...pages].filter(item => !words.length || match(`${item.title} ${item.sub}`));
}

let palette = null;
export function openPalette() {
  if (palette?.open) { palette.querySelector('input').select(); return; }
  menu.close(false);
  const origin = document.activeElement;
  const input = el('input', {type:'text', id:'palette-input', autocomplete:'off', spellcheck:'false', placeholder:'Search terminals, workspaces, folders and actions', 'aria-label':'Search terminals, workspaces, folders and actions',
    role:'combobox', 'aria-expanded':'true', 'aria-controls':'palette-list', 'aria-autocomplete':'list'});
  const list = el('div', {class:'pal-list', id:'palette-list', role:'listbox', 'aria-label':'Results'});
  const dialog = el('dialog', {class:'palette', 'aria-label':'Search and commands'},
    el('div', {class:'pal-input'}, icon('search'), input, el('kbd', {text:'Esc'})), list,
    el('div', {class:'pal-foot'}, el('span', {text:'↑ ↓ to move · Enter to open'}), el('span', {text:'Ctrl K'})));
  let results = [], active = 0;
  const run = index => {
    const item = results[index];
    if (!item) return;
    dialog.close();
    item.run();
  };
  const draw = () => {
    let group = null;
    const nodes = [];
    results.forEach((item, index) => {
      if (item.group !== group) { group = item.group; nodes.push(el('div', {class:'pal-group', role:'presentation', text:group})); }
      const mark = item.workspace ? avatar(workspaceIndex(item.workspace), item.title, 'xs') : null;
      nodes.push(el('button', {class:'pal-item', type:'button', role:'option', id:`palette-item-${index}`, tabindex:'-1', 'aria-selected':String(index === active),
        onpointermove:() => { if (active !== index) { active = index; highlight(); } }, onclick:() => run(index)},
      mark, el('span', {class:'t'}, el('b', {text:item.title}), item.sub ? el('span', {text:item.sub}) : null),
      item.status && item.status.tone !== 'neutral' ? badge(item.status.label, item.status.tone) : null, el('kbd', {text:'↵'})));
    });
    if (!results.length) nodes.push(el('div', {class:'pal-empty', role:'status'}, el('b', {text:'No results'}), el('span', {text:'Try a terminal, workspace, folder or page name.'})));
    list.replaceChildren(...nodes);
    highlight();
  };
  const highlight = () => {
    for (const node of list.querySelectorAll('.pal-item')) node.setAttribute('aria-selected', String(node.id === `palette-item-${active}`));
    if (results.length) { input.setAttribute('aria-activedescendant', `palette-item-${active}`); list.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest'}); }
    else input.removeAttribute('aria-activedescendant');
  };
  input.addEventListener('input', () => { results = items(input.value); active = 0; draw(); });
  input.addEventListener('keydown', event => {
    const last = results.length - 1;
    if (event.key === 'ArrowDown') active = Math.min(last, active + 1);
    else if (event.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (event.key === 'Home' && event.ctrlKey) active = 0;
    else if (event.key === 'End' && event.ctrlKey) active = Math.max(0, last);
    else if (event.key === 'Enter') { event.preventDefault(); run(active); return; }
    else return;
    event.preventDefault();
    highlight();
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (palette === dialog) palette = null;
    // Return focus only when the chosen action did not move it.
    requestAnimationFrame(() => { if (document.activeElement === document.body && origin?.isConnected) origin.focus(); });
  });
  palette = dialog;
  document.body.append(dialog);
  results = items('');
  draw();
  dialog.showModal();
  input.focus();
}

const SHORTCUTS = [
  ['Anywhere', [['Search and commands', 'Ctrl', 'Shift', 'P']]],
  ['Outside a terminal', [['Search', 'Ctrl', 'K'], ['Search', '/'], ['Keyboard shortcuts', '?'], ['New terminal', 'N'], ['Reorder a workspace in the sidebar', 'Alt', '↑ ↓']]],  ['In a terminal', [['Find in history', 'Ctrl', 'Shift', 'F'], ['Copy selection', 'Ctrl', 'Shift', 'C'], ['Paste', 'Ctrl', 'V'], ['Select text while an app uses the mouse', 'Shift', 'drag']]],
];
export function showShortcuts() {
  menu.close(false);
  return dialogs.show({
    title:'Keyboard shortcuts', description:'Outside a terminal. Inside one, keys go to the program.', action:'Done', cancel:false, className:'shortcuts',
    body:el('div', {class:'key-groups'}, SHORTCUTS.map(([heading, rows]) => el('section', {}, el('h3', {text:heading}),
      rows.map(([label, ...keys]) => el('div', {class:'key-row'}, el('span', {text:label}), el('span', {}, keys.map(key => el('kbd', {text:key})))))))),
  });
}

// A key belongs to the page only outside terminals, fields and open overlays.
function pageOwnsKey(target) {
  return !document.querySelector('dialog[open]') && !menu.open && !target.closest?.('.pane, input, textarea, select, [contenteditable], [role="combobox"], [role="menu"]');
}
document.addEventListener('keydown', event => {
  const key = event.key.toLowerCase();
  if (event.ctrlKey && event.shiftKey && !event.altKey && key === 'p') {
    if (document.querySelector('dialog[open]:not(.palette)')) return;
    event.preventDefault();
    event.stopPropagation();
    openPalette();
    return;
  }
  if (event.defaultPrevented || event.altKey || event.metaKey || !pageOwnsKey(event.target)) return;
  if ((event.ctrlKey && !event.shiftKey && key === 'k') || (!event.ctrlKey && event.key === '/')) { event.preventDefault(); openPalette(); }
  else if (!event.ctrlKey && event.key === '?') { event.preventDefault(); showShortcuts(); }
  else if (!event.ctrlKey && !event.shiftKey && key === 'n') { event.preventDefault(); openLauncher({workspace:state.selected}); }
}, true);
