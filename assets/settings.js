// Settings: General, Terminal, Notifications and About tabs over the shared
// preferences draft. Facts come from the running server, never from guesses.
import {$, el, icon, pathText, programTile, storage, uptime} from './dom.js';
import {go, shellLabel, state} from './model.js';
import {browserNotices} from './ui.js';
import {displayPath} from './common.js';
import {chooseFolder, loadPrograms} from './launcher.js';
import {FONT_MAX, FONT_MIN, draft, edit, fontStepper, problemBanner, ready, saveBar, terminalPreview, themeSegment} from './preferences.js';

const TABS = [['general', 'General'], ['terminal', 'Terminal'], ['notifications', 'Notifications'], ['about', 'About']];
const REPORTS = {requests:'Reports requests and replies', replies:'Reports replies only'};
const PERMISSIONS = {
  granted:['Allowed', 'Notices also appear while this tab is in the background, for the kinds turned on above.'],
  default:['Not allowed yet', 'Allow them to also get notices while this tab is in the background. The browser asks once.'],
  denied:['Blocked', 'This browser blocks notifications for this page. Allow them in the browser’s site settings, then reload.'],
  unsupported:['Unavailable', 'This browser cannot show notifications for this page.'],
};
const remembered = storage('session'), TAB_KEY = 'webterminal.settingsTab';
let tab = TABS.some(([id]) => id === remembered.get(TAB_KEY)) ? remembered.get(TAB_KEY) : 'general';
let view = null, info = null, invalidSeen = 0;

// A labelled settings row; the label names the control for assistive tech.
function row(label, help, control, {id = null, wide = false} = {}) {
  const helpId = id && help ? `${id}-help` : null;
  return el('div', {class:`prefs-row${wide ? ' wide' : ''}`},
    el('div', {class:'prefs-label'}, id ? el('label', {for:id, text:label}) : el('b', {text:label}), help ? el('p', {id:helpId, text:help}) : null),
    el('div', {class:'prefs-control'}, control));
}
const fact = (label, help, value) => row(label, help, el('span', {class:'prefs-fact-value'}, value));
const section = (title, description, ...rows) => el('section', {class:'prefs-section', 'aria-label':title},
  el('header', {class:'prefs-section-head'}, el('h2', {text:title}), description ? el('p', {text:description}) : null), el('div', {class:'prefs-rows'}, rows));

// Choosing a starting folder uses the launcher's picker, which only returns the path.
const chooseStart = done => chooseFolder(done, () => draft.value?.startFolder || state.hello?.serverCwd || '');

function general(updates) {
  const input = el('input', {class:'field mono', id:'settings-folder', type:'text', autocomplete:'off', spellcheck:'false', 'aria-describedby':'settings-folder-help settings-folder-error',
    oninput:() => edit('startFolder', input.value.trim() || null)});
  const error = el('p', {class:'error', id:'settings-folder-error', hidden:true});
  const browse = el('button', {class:'btn', type:'button', onclick:() => chooseStart(path => { input.value = displayPath(path); edit('startFolder', input.value); input.focus(); })}, icon('folder-open'), el('span', {text:'Browse…'}));
  const reset = el('button', {class:'btn ghost', type:'button', text:'Use server folder', onclick:() => { if (reset.getAttribute('aria-disabled') === 'true') return; input.value = ''; edit('startFolder', null); input.focus(); }});
  const help = el('p', {class:'help', id:'settings-folder-help'});
  const address = el('span'), shell = el('span'), file = el('span');
  updates.push(() => {
    const value = draft.value.startFolder, server = displayPath(state.hello?.serverCwd || info?.serverCwd || '');
    if (document.activeElement !== input && (input.value.trim() || null) !== (value ? displayPath(value) : null)) input.value = value ? displayPath(value) : '';
    input.placeholder = server ? `Server folder: ${server}` : 'Server folder';
    help.textContent = `New terminals open here unless you choose another folder; existing terminals keep theirs. Leave it empty to use the server folder${server ? `, ${server}` : ''}.`;
    reset.setAttribute('aria-disabled', String(!value));
    const problem = draft.errors.startFolder || '';
    error.textContent = problem;
    error.hidden = !problem;
    if (problem) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    address.textContent = state.hello?.port ? `127.0.0.1:${state.hello.port}` : 'Unavailable while offline';
    shell.textContent = state.hello?.shell || info?.shell || 'Unavailable while offline';
    file.replaceChildren(state.settings?.path ? pathText(state.settings.path, '') : 'Unavailable');
  });
  return section('General', 'Where new terminals start, and how this server runs.',
    el('div', {class:'prefs-row wide'},
      el('div', {class:'prefs-label'}, el('label', {for:'settings-folder', text:'Starting folder'})),
      el('div', {class:'prefs-folder'}, input, el('div', {class:'prefs-folder-actions'}, browse, reset), help, error)),
    fact('Address', 'This computer only. Choose the port when starting the server (--port).', address),
    fact('Shell', 'Every terminal starts this command.', shell),
    fact('Settings file', 'Saved settings for this server, shared by every browser view.', file));
}

function terminal(updates) {
  const stepper = fontStepper('settings-font'), colors = themeSegment('settings-colors'), preview = terminalPreview('Terminal preview');
  const history = el('span');
  updates.push(stepper.update, colors.update, preview.update, () => {
    history.textContent = Number.isFinite(info?.history) ? `${info.history.toLocaleString('en-US')} rows` : 'Loading…';
  });
  return section('Terminal', 'Text size and colors for every terminal, applied when you save.',
    row('Font size', `Cascadia Mono, ${FONT_MIN}–${FONT_MAX} px. The interface keeps its own size.`, stepper.node),
    row('Terminal colors', 'Independent of the dark interface. Program colors stay as programs send them.', colors.node),
    el('div', {class:'prefs-row wide'}, preview.node),
    fact('History', 'Rows each terminal keeps in memory for scrolling back. Nothing is written to disk.', history),
    el('div', {class:'prefs-row wide'}, el('button', {class:'btn ghost', type:'button', onclick:() => go('appearance')}, icon('palette'), el('span', {text:'Open Themes & Appearance'}))));
}

function toggle(updates, key, label, help) {
  const id = `settings-notify-${key}`;
  const button = el('button', {class:'switch', id, type:'button', role:'switch', 'aria-describedby':`${id}-help`, onclick:() => edit(key, !draft.value.notifications[key])});
  updates.push(() => button.setAttribute('aria-checked', String(draft.value.notifications[key] !== false)));
  return row(label, help, button, {id});
}

function notifications(updates) {
  const badge = el('span', {class:'status-badge'}, el('span', {class:'status-label'}));
  const help = el('p', {id:'settings-browser-help'});
  const allow = el('button', {class:'btn', type:'button', 'aria-describedby':'settings-browser-help', onclick:async () => {
    if (allow.getAttribute('aria-busy') === 'true') return;
    allow.setAttribute('aria-busy', 'true');
    // Only this click asks the browser; nothing requests permission on load.
    await browserNotices.request();
    allow.removeAttribute('aria-busy');
    refresh();
  }}, icon('bell'), el('span', {text:'Allow browser notifications'}));
  updates.push(() => {
    const permission = browserNotices.permission, [label, text] = PERMISSIONS[permission] || PERMISSIONS.unsupported;
    badge.firstChild.textContent = label;
    help.textContent = `${text} The Dock in this page shows notices either way.`;
    allow.hidden = permission !== 'default';
  });
  return section('Notifications', 'Which events show a notice in the Dock, for every view of this server.',
    toggle(updates, 'input', 'When an agent asks', 'A request from Claude Code for permission or an answer. Needs you lists every request either way.'),
    toggle(updates, 'reply', 'When an agent replies', 'A reply from an agent that reports replies. Reader keeps every reply either way.'),
    toggle(updates, 'failure', 'When a program fails', 'A terminal whose program exits with a non-zero code.'),
    el('div', {class:'prefs-row'}, el('div', {class:'prefs-label'}, el('b', {text:'Browser notifications in this browser'}), help), el('div', {class:'prefs-control prefs-permission'}, badge, allow)));
}

function about(updates) {
  const version = el('span'), server = el('span'), programs = el('ul', {class:'prefs-programs', 'aria-label':'Agent programs'}), note = el('p', {class:'help'});
  updates.push(() => {
    const hello = state.hello || info;
    version.textContent = hello?.version ? `Webterminal ${hello.version}` : 'Unavailable';
    const started = hello?.started || info?.started;
    server.textContent = hello?.pid ? `PID ${hello.pid}${started ? ` · ${uptime(Date.now() - started)}` : ''}` : 'Unavailable';
    const list = state.programs?.programs;
    note.textContent = !state.programs ? 'Looking for agent programs…' : state.programs.hosted ? 'Found on this computer’s PATH. Each starts inside PowerShell when you choose it in Open terminal.'
      : `Agent programs need Windows PowerShell as the shell; this server runs ${shellLabel(state.hello?.shell)}.`;
    programs.replaceChildren(...(list || []).map(program => el('li', {class:'prefs-program'}, programTile(),
      el('div', {}, el('b', {text:program.label}), el('span', {class:'muted', text:`${program.available ? 'Found' : 'Not found on PATH'} · ${REPORTS[program.bridge] || 'Unknown status'}`}),
        program.path ? pathText(program.path) : null))));
  });
  return section('About', 'This server and the programs it can start.',
    fact('Version', '', version),
    fact('Server', 'The process that owns every terminal.', server),
    el('div', {class:'prefs-row wide'}, el('div', {class:'prefs-label'}, el('b', {text:'Agent programs'}), note), programs));
}

function build() {
  const updates = [], bar = saveBar('settings'), banner = problemBanner();
  const tabs = TABS.map(([id, label]) => el('button', {class:'prefs-tab', id:`settings-tab-${id}`, type:'button', role:'tab', 'aria-controls':`settings-panel-${id}`, text:label, onclick:() => select(id),
    onkeydown:event => {
      const index = TABS.findIndex(([item]) => item === id), last = TABS.length - 1;
      const next = {ArrowLeft:index - 1, ArrowRight:index + 1, Home:0, End:last}[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(TABS[(next + TABS.length) % TABS.length][0], true);
    }}));
  const builders = {general, terminal, notifications, about};
  const panels = TABS.map(([id]) => el('div', {class:'prefs-panel', id:`settings-panel-${id}`, role:'tabpanel', 'aria-labelledby':`settings-tab-${id}`}, builders[id](updates)));
  updates.push(banner.update, bar.update);
  const root = el('form', {class:'prefs-root', novalidate:true, onsubmit:event => event.preventDefault()}, banner.node, el('div', {class:'prefs-tabs', role:'tablist', 'aria-label':'Settings sections'}, tabs), panels, bar.node);
  view = {root, tabs, panels, updates};
  $('settings-content').replaceChildren(root);
  select(tab);
}

function select(id, focus = false) {
  tab = id;
  remembered.set(TAB_KEY, id);
  if (!view) return;
  TABS.forEach(([item], index) => {
    const selected = item === id;
    view.tabs[index].setAttribute('aria-selected', String(selected));
    view.tabs[index].tabIndex = selected ? 0 : -1;
    view.panels[index].hidden = !selected;
  });
  if (focus) view.tabs[TABS.findIndex(([item]) => item === id)].focus();
}

function refresh() { if (view && ready()) for (const update of view.updates) update(); }

async function loadInfo() {
  try {
    const response = await fetch('/api/info', {cache:'no-store'});
    if (response.ok) info = await response.json();
  } catch { /* The live hello message still provides most facts. */ }
  refresh();
}

export function show(target) {
  $('settings-content').classList.add('prefs-content');
  $('settings-subtitle').textContent = 'Saved on this server and shared by every browser view. Save several changes together.';
  if (TABS.some(([id]) => id === target?.tab)) select(target.tab);
  loadInfo();
  loadPrograms();
}

export function render(topics) {
  if (!ready()) {
    view = null;
    $('settings-content').replaceChildren(el('div', {class:'state', role:'status'}, el('span', {class:'spinner', 'aria-hidden':'true'}), el('h2', {text:'Loading settings…'}), el('p', {text:state.connected ? 'Waiting for the server.' : 'Connecting to the local server…'})));
    return;
  }
  if (!view) build();
  // A refused starting folder brings its tab forward and its field into focus.
  if (draft.invalidCount !== invalidSeen) {
    invalidSeen = draft.invalidCount;
    if (draft.errors.startFolder) { select('general'); $('settings-folder')?.focus(); }
  }
  if (['settings', 'preferences', 'connection', 'programs', 'page'].some(topic => topics.has(topic))) refresh();
}
