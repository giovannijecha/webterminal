// One draft of the server settings, edited on the Settings page.
// The server owns the saved values and their revision; this module edits a
// copy until Save, and never changes running terminals before the server
// confirms (app.js applies saved settings when they arrive).
import {ask} from './connection.js';
import {changed, go, state, subscribe} from './model.js';
import {el, plural} from './dom.js';
import {displayPath} from './common.js';
import {notify, pageHeading, toasts} from './ui.js';

// Mirrors src/settings/fields.rs.
export const FONT_MIN = 10, FONT_MAX = 20, PATH_LIMIT = 1024;
export const APPEARANCE_DEFAULTS = {fontSize:13, terminalTheme:'dark'};
export const FIELDS = {
  startFolder:{label:'Starting folder', text:value => value ? displayPath(value) : 'Server folder'},
  fontSize:{label:'Font size', text:value => `${value} px`},
  terminalTheme:{label:'Terminal colors', text:value => value === 'light' ? 'Light' : 'Dark'},
};
const KEYS = Object.keys(FIELDS);
const PAGES = new Set(['settings']);

// phase: idle | saving | invalid | error | conflict. `latest` holds saved
// values from another view that arrived while this draft had changes.
export const draft = {base:null, value:null, revision:0, phase:'idle', message:'', errors:{}, latest:null, invalidCount:0};

const clone = settings => JSON.parse(JSON.stringify(settings));
export const read = (settings, key) => settings?.[key];
function write(settings, key, value) { settings[key] = value; }
// Windows folders compare without case or a trailing separator.
const folderKey = path => {
  const visible = path ? displayPath(path) : '';
  return (visible.length > 3 ? visible.replace(/[\\/]+$/, '') : visible).toLowerCase();
};
const same = (key, a, b) => key === 'startFolder' ? folderKey(a) === folderKey(b) : a === b;
const differences = (a, b) => KEYS.filter(key => !same(key, read(a, key), read(b, key)));

export const ready = () => Boolean(draft.value);
export const changedKeys = () => draft.value ? differences(draft.value, draft.base) : [];
export const dirty = () => changedKeys().length > 0;
export const resolving = () => Boolean(draft.latest) || draft.phase === 'conflict';
export const describe = (key, value) => `${FIELDS[key].label} ${FIELDS[key].text(value)}`;

const absolute = path => /^[a-z]:[\\/]/i.test(path) || /^\\\\[^\\]/.test(path);
export function validate(value) {
  const errors = {}, size = value.fontSize, folder = value.startFolder;
  if (!Number.isInteger(size) || size < FONT_MIN || size > FONT_MAX) errors.fontSize = `Choose a size from ${FONT_MIN} to ${FONT_MAX} px.`;
  if (!['dark', 'light'].includes(value.terminalTheme)) errors.terminalTheme = 'Choose Dark or Light.';
  if (folder !== null) {
    if ([...folder].length > PATH_LIMIT) errors.startFolder = `Use a path of at most ${PATH_LIMIT} characters.`;
    else if (folder.includes('\0')) errors.startFolder = 'The path contains a character Windows does not allow.';
    else if (!absolute(folder)) errors.startFolder = 'Enter a full path, for example C:\\dev\\project.';
  }
  return errors;
}

function adopt(message) {
  draft.base = clone(message.settings);
  draft.value = clone(message.settings);
  draft.revision = message.revision;
  Object.assign(draft, {phase:'idle', message:'', errors:{}, latest:null});
  changed('preferences');
}

// Saved settings arrive with every save from any view. A clean draft follows
// them; a draft with changes is kept, and the newer values are offered.
function sync() {
  const saved = state.settings;
  if (!saved?.settings) return;
  if (!draft.value) { adopt(saved); return; }
  if (draft.phase === 'saving') return;
  if (!dirty()) { if (saved.revision !== draft.revision || differences(saved.settings, draft.base).length) adopt(saved); return; }
  if (saved.revision !== draft.revision && (!draft.latest || saved.revision > draft.latest.revision)) {
    draft.latest = {revision:saved.revision, settings:clone(saved.settings)};
    changed('preferences');
  }
}

export function edit(key, value) {
  if (!draft.value) return;
  write(draft.value, key, value);
  delete draft.errors[key];
  if (['invalid', 'error'].includes(draft.phase) && !Object.keys(draft.errors).length) { draft.phase = 'idle'; draft.message = ''; }
  changed('preferences');
}

export function discard() { if (state.settings?.settings) adopt(state.settings); }

// Keeps this view's changes on top of the newest saved values.
export function keepMine(saveAfter) {
  const latest = draft.latest || state.settings;
  if (!latest?.settings || !draft.value) return;
  const next = clone(latest.settings);
  for (const key of changedKeys()) write(next, key, read(draft.value, key));
  draft.base = clone(latest.settings);
  draft.value = next;
  draft.revision = latest.revision;
  Object.assign(draft, {phase:'idle', message:'', latest:null});
  changed('preferences');
  if (saveAfter && dirty()) save();
}

async function loadLatest() {
  let latest = null;
  try {
    const response = await fetch('/api/settings', {cache:'no-store'});
    if (response.ok) latest = await response.json();
  } catch { /* The next settings update from the server fills this in. */ }
  if (!latest?.settings && state.settings?.revision !== draft.revision) latest = state.settings;
  if (latest?.settings && latest.revision !== draft.revision && (!draft.latest || latest.revision > draft.latest.revision)) {
    draft.latest = {revision:latest.revision, settings:clone(latest.settings)};
  }
  changed('preferences');
}

// Server messages name the field: "settings.fontSize must be …".
function failed(message) {
  const field = /^settings\.(\w+) (.*)$/s.exec(message);
  if (/changed elsewhere/i.test(message)) {
    Object.assign(draft, {phase:'conflict', message});
    loadLatest();
  } else if (field && FIELDS[field[1]]) {
    const text = field[2].charAt(0).toUpperCase() + field[2].slice(1);
    Object.assign(draft, {phase:'invalid', message:'', errors:{[field[1]]:text.endsWith('.') ? text : `${text}.`}});
    draft.invalidCount++;
  } else Object.assign(draft, {phase:'error', message});
  changed('preferences');
  return false;
}

export async function save() {
  if (!draft.value || draft.phase === 'saving' || resolving()) return false;
  if (!state.connected) return failed('The connection is unavailable. Reconnecting…');
  const errors = validate(draft.value);
  if (Object.keys(errors).length) {
    Object.assign(draft, {phase:'invalid', message:'', errors});
    draft.invalidCount++;
    changed('preferences');
    return false;
  }
  const sent = clone(draft.value), revision = draft.revision;
  Object.assign(draft, {phase:'saving', message:'', errors:{}});
  changed('preferences');
  let reply;
  // The reply is the saved settings at the next revision. Another view's save
  // cannot match it: the server would have refused this one as stale.
  const mine = message => message.type === 'settings' && message.revision === revision + 1 &&
    differences(message.settings, sent).every(key => key === 'startFolder') && Boolean(message.settings.startFolder) === Boolean(sent.startFolder);
  try { reply = await ask({op:'save-settings', revision, settings:sent}, mine); }
  catch (error) { return failed(error.message || 'The server did not save the settings.'); }
  if (!reply) return failed('The connection is unavailable. Reconnecting…');
  if (reply.type !== 'settings') return failed('The server is busy. Try again.');
  const editedMeanwhile = differences(draft.value, sent).length > 0;
  draft.base = clone(reply.settings);
  if (!editedMeanwhile) draft.value = clone(reply.settings);
  draft.revision = reply.revision;
  Object.assign(draft, {phase:'idle', message:'', errors:{}, latest:null});
  notify('Settings saved', reply.notice || 'Every browser view of this server now uses them.', null, 'settings-saved');
  changed('preferences');
  return true;
}

// The sticky Save bar; each page owns one instance over the same draft.
export function saveBar(page) {
  const title = el('p', {class:'prefs-status', id:`${page}-save-status`});
  const detail = el('p', {class:'prefs-detail'});
  const button = (text, kind, run) => el('button', {class:`btn${kind}`, type:'button', text, onclick:event => { if (event.currentTarget.getAttribute('aria-disabled') !== 'true') run(); }});
  const load = button('Load saved values', '', discard);
  const keep = button('Keep my changes', ' primary', () => keepMine(draft.phase === 'conflict'));
  const drop = button('Discard', ' ghost', discard);
  const submit = button('Save changes', ' primary', save);
  const actions = el('div', {class:'prefs-save-actions'}, load, keep, drop, submit);
  const node = el('footer', {class:'prefs-footer', 'aria-labelledby':title.id, hidden:true}, el('div', {class:'prefs-footer-text', role:'status'}, title, detail), actions);
  function update() {
    const hadFocus = node.contains(document.activeElement);
    const conflict = resolving(), saving = draft.phase === 'saving', errors = Object.entries(draft.errors);
    node.hidden = !ready() || !(dirty() || conflict || draft.phase === 'error');
    if (node.hidden) { if (hadFocus) pageHeading()?.focus(); return; }
    const other = draft.latest ? differences(draft.latest.settings, draft.base).map(key => describe(key, read(draft.latest.settings, key))) : [];
    const pending = changedKeys();
    let heading = plural(pending.length, 'unsaved change'), text = pending.map(key => `${describe(key, read(draft.base, key))} → ${FIELDS[key].text(read(draft.value, key))}`).join(' · ');
    if (saving) [heading, text] = ['Saving…', text];
    else if (draft.phase === 'conflict') [heading, text] = ['Not saved. Another view saved settings first.', draft.latest ? `Saved now: ${other.join(' · ') || 'the same values'}.` : 'Loading the saved values…'];
    else if (draft.latest) [heading, text] = ['Another view saved settings. Your changes are kept.', `Saved now: ${other.join(' · ') || 'the same values'}.`];
    else if (draft.phase === 'invalid') [heading, text] = ['Not saved. Check the highlighted setting.', errors.map(([key, error]) => `${FIELDS[key]?.label || key}: ${error}`).join(' ')];
    else if (draft.phase === 'error') [heading, text] = ['Not saved.', draft.message];
    else if (!state.connected) [heading, text] = ['Offline. Your changes are kept.', 'Save becomes available when the connection returns.'];
    title.textContent = heading;
    detail.textContent = text;
    node.dataset.tone = ['invalid', 'error', 'conflict'].includes(draft.phase) ? 'error' : '';
    load.hidden = keep.hidden = !conflict;
    drop.hidden = submit.hidden = conflict;
    keep.textContent = draft.phase === 'conflict' ? 'Keep my changes and save again' : 'Keep my changes';
    keep.setAttribute('aria-disabled', String(draft.phase === 'conflict' && !draft.latest));
    submit.textContent = draft.phase === 'error' ? 'Try again' : 'Save changes';
    submit.setAttribute('aria-busy', String(saving));
    submit.setAttribute('aria-disabled', String(saving || !state.connected));
    drop.setAttribute('aria-disabled', String(saving));
    // Keep keyboard focus in the bar when the offered actions change.
    if (hadFocus && (!node.contains(document.activeElement) || document.activeElement.hidden)) (conflict ? keep : submit).focus();
  }
  return {node, update};
}

// Shared controls; `update()` reads the draft without rebuilding them.
export function fontStepper(id) {
  const output = el('output', {id:`${id}-value`, 'aria-live':'polite'});
  const step = delta => {
    const size = (draft.value?.fontSize ?? APPEARANCE_DEFAULTS.fontSize) + delta;
    if (size >= FONT_MIN && size <= FONT_MAX) edit('fontSize', size);
  };
  const smaller = el('button', {class:'stepper-btn', type:'button', 'aria-label':'Smaller terminal text', title:'Smaller', text:'−', onclick:() => step(-1)});
  const larger = el('button', {class:'stepper-btn', type:'button', 'aria-label':'Larger terminal text', title:'Larger', text:'+', onclick:() => step(1)});
  const node = el('div', {class:'stepper', role:'group', 'aria-label':`Terminal font size, ${FONT_MIN} to ${FONT_MAX} px`}, smaller, output, larger);
  function update() {
    const size = draft.value?.fontSize ?? APPEARANCE_DEFAULTS.fontSize;
    output.textContent = `${size} px`;
    // aria-disabled keeps a focused button focusable at the limit.
    smaller.setAttribute('aria-disabled', String(size <= FONT_MIN));
    larger.setAttribute('aria-disabled', String(size >= FONT_MAX));
  }
  return {node, update};
}
// Each choice shows a swatch of its terminal background.
export function themeSegment(id) {
  const buttons = ['dark', 'light'].map(theme => el('button', {type:'button', id:`${id}-${theme}`, onclick:() => edit('terminalTheme', theme)},
    el('span', {class:'swatch', 'data-theme':theme, 'aria-hidden':'true'}), el('span', {text:FIELDS.terminalTheme.text(theme)})));
  const node = el('div', {class:'segment', role:'group', 'aria-label':'Terminal colors'}, buttons);
  const update = () => buttons.forEach((button, index) => button.setAttribute('aria-pressed', String((draft.value?.terminalTheme || 'dark') === ['dark', 'light'][index])));
  return {node, update};
}

// A sample drawn with the real renderer classes. Program colors are the
// renderer's ANSI palette and stay the same in both themes, as in terminals.
const GREEN = '#0dbc79', RED = '#cd3131', YELLOW = '#e5e510', BLUE = '#2472c8';
const SAMPLE = [
  [['PS C:\\dev\\project> '], ['cargo test']],
  [['   Compiling', GREEN], [' project v0.1.0']],
  [['warning', YELLOW], [': unused variable `size`']],
  [['running 2 tests']],
  [['test parse ... '], ['ok', GREEN]],
  [['test render ... '], ['FAILED', RED]],
  [['See '], ['docs\\TESTS.md', BLUE]],
  [['PS C:\\dev\\project> '], [' ', null, true]],
];
let measure = null;
export function terminalPreview(label) {
  const lines = el('div', {class:'terminal-lines'}, SAMPLE.map(line => el('div', {class:'term-line'}, line.map(([text, color, cursor]) => {
    const cell = el('span', {class:`term-cell${cursor ? ' cursor block' : ''}`, text});
    cell.style.width = `calc(${[...text].length} * var(--cell-width))`;
    if (color) cell.style.color = color;
    if (cursor) { cell.style.setProperty('--cursor-cell-fg', 'var(--terminal-fg)'); cell.style.setProperty('--cursor-cell-bg', 'var(--terminal-bg)'); }
    return cell;
  }))));
  const node = el('div', {class:'prefs-terminal', role:'img'}, lines);
  function update() {
    const size = draft.value?.fontSize ?? APPEARANCE_DEFAULTS.fontSize, theme = draft.value?.terminalTheme === 'light' ? 'light' : 'dark';
    node.dataset.theme = theme;
    node.setAttribute('aria-label', `${label}: ${size} px terminal text, ${theme} colors`);
    // The same metrics workspace.js and render.js give real terminals.
    lines.style.setProperty('--font-size', `${size}px`);
    lines.style.setProperty('--line-height', `${Math.ceil(size * 1.2)}px`);
    measure ??= document.createElement('canvas').getContext('2d');
    measure.font = `${size}px ${getComputedStyle(document.documentElement).getPropertyValue('--mono')}`;
    lines.style.setProperty('--cell-width', `${measure.measureText('M').width || size * 0.6}px`);
  }
  return {node, update};
}

// Saved settings that could not be read: defaults are in use until a save.
export function problemBanner() {
  const text = el('p');
  const repair = el('button', {class:'btn sm', type:'button', text:'Save a new settings file', onclick:() => { if (repair.getAttribute('aria-disabled') !== 'true') save(); }});
  const node = el('div', {class:'prefs-problem', role:'alert', hidden:true}, el('div', {}, el('h2', {text:'Saved settings could not be read'}), text, repair));
  const update = () => {
    const problem = state.settings?.problem;
    node.hidden = !problem;
    text.textContent = problem || '';
    repair.setAttribute('aria-disabled', String(draft.phase === 'saving' || !state.connected));
  };
  return {node, update};
}

// Leaving Settings with changes keeps the draft and says so.
let lastPage = state.page;
subscribe(topics => {
  if (topics.has('settings') || topics.has('connection')) sync();
  if (state.page === lastPage) return;
  const from = lastPage;
  lastPage = state.page;
  if (PAGES.has(state.page)) toasts.clear('settings-draft');
  else if (PAGES.has(from) && (dirty() || resolving())) {
    notify('Settings not saved yet', 'Your changes stay as a draft in this tab until you save or discard them.', {label:'Review changes', run:() => go(from)}, 'settings-draft');
  }
});
sync();
