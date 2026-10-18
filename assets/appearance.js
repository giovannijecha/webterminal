// Themes & Appearance: terminal text controls beside a preview of the shared
// draft. The preview has its own colors and metrics, so running terminals
// change only when the server confirms a save.
import {$, el, icon, programTile} from './dom.js';
import {state} from './model.js';
import {APPEARANCE_DEFAULTS, FIELDS, FONT_MAX, FONT_MIN, changedKeys, draft, edit, fontStepper, problemBanner, ready, saveBar, terminalPreview, themeSegment} from './preferences.js';

const LOOKS = ['fontSize', 'terminalTheme'];
let view = null;

const row = (label, help, control) => el('div', {class:'prefs-row'},
  el('div', {class:'prefs-label'}, el('b', {text:label}), help ? el('p', {text:help}) : null), el('div', {class:'prefs-control'}, control));
const panel = (title, ...rows) => el('section', {class:'prefs-section', 'aria-label':title}, el('header', {class:'prefs-section-head'}, el('h2', {text:title})), el('div', {class:'prefs-rows'}, rows));

function build() {
  const stepper = fontStepper('appearance-font'), colors = themeSegment('appearance-colors'), preview = terminalPreview('Appearance preview');
  const bar = saveBar('appearance'), banner = problemBanner();
  const restore = el('button', {class:'btn ghost', type:'button', onclick:() => {
    if (restore.getAttribute('aria-disabled') === 'true') return;
    for (const key of LOOKS) edit(key, APPEARANCE_DEFAULTS[key]);
  }}, icon('undo'), el('span', {text:'Restore appearance defaults'}));
  const status = el('span', {class:'appearance-status'});
  const figure = el('figure', {class:'appearance-preview', 'aria-labelledby':'appearance-preview-title'},
    el('figcaption', {}, el('b', {id:'appearance-preview-title', text:'Preview'}), status),
    el('div', {class:'appearance-sample'},
      el('div', {class:'appearance-sample-head', 'aria-hidden':'true'}, programTile(), el('b', {text:'PowerShell'}), el('span', {class:'muted mono', text:'Sample output'})),
      preview.node));
  const controls = el('div', {class:'appearance-controls'},
    panel('Interface',
      row('Interface theme', 'The workbench interface is always dark.', el('span', {class:'prefs-fact-value', text:'Dark'})),
      row('Interface font', 'For navigation, labels and actions.', el('span', {class:'prefs-fact-value', text:'Nunito'}))),
    panel('Terminal',
      row('Terminal colors', 'Independent of the dark interface.', colors.node),
      row('Terminal font size', `Cascadia Mono · ${FONT_MIN}–${FONT_MAX} px.`, stepper.node),
      el('div', {class:'prefs-row wide'}, el('div', {class:'appearance-restore'}, restore,
        el('p', {class:'help', text:`${APPEARANCE_DEFAULTS.fontSize} px, ${FIELDS.terminalTheme.text(APPEARANCE_DEFAULTS.terminalTheme)} colors. Save to apply.`})))));
  const update = () => {
    const looks = changedKeys().filter(key => LOOKS.includes(key));
    const saved = state.settings?.settings;
    status.textContent = looks.length && saved ? `Not saved · terminals use ${saved.fontSize} px, ${FIELDS.terminalTheme.text(saved.terminalTheme)}` : 'Matches your terminals';
    restore.setAttribute('aria-disabled', String(LOOKS.every(key => draft.value[key] === APPEARANCE_DEFAULTS[key])));
  };
  const root = el('form', {class:'prefs-root appearance-root', novalidate:true, onsubmit:event => event.preventDefault()},
    banner.node, el('div', {class:'appearance-split'}, controls, figure), bar.node);
  view = {updates:[stepper.update, colors.update, preview.update, banner.update, update, bar.update]};
  $('appearance-content').replaceChildren(root);
}

export function show() {
  $('appearance-content').classList.add('prefs-content');
  $('appearance-subtitle').textContent = 'Terminal text and colors. Preview here, then save to apply them to every terminal.';
}

export function render(topics) {
  if (!ready()) {
    view = null;
    $('appearance-content').replaceChildren(el('div', {class:'state', role:'status'}, el('span', {class:'spinner', 'aria-hidden':'true'}), el('h2', {text:'Loading appearance…'}), el('p', {text:state.connected ? 'Waiting for the server.' : 'Connecting to the local server…'})));
    return;
  }
  if (!view) build();
  if (['settings', 'preferences', 'connection', 'page'].some(topic => topics.has(topic))) for (const update of view.updates) update();
}
