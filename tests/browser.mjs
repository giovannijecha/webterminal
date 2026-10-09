import test from 'node:test';
import assert from 'node:assert/strict';
import {TerminalInput} from '../assets/input.js';
import {TerminalRenderer, lineText} from '../assets/render.js';
import {pathCrumbs} from '../assets/directory.js';
import {mergeUpdate} from '../assets/updates.js';

const ESC = '\x1b';

test('ordered updates preserve unchanged rows and the previous immutable projection', () => {
  const first={type:'snapshot',id:'s1',seq:5,epoch:1,terminal:{cols:4,rows:2,history:[{cells:[['a']]},{cells:[['b']]}],screen:[{cells:[['x']]},{cells:[['y']]}]}};
  const row={cells:[['z']]};
  const next=mergeUpdate(first,{type:'update',id:'s1',base:5,seq:8,epoch:2,controller:'second',terminal:{cols:4,rows:2,modes:{win32:true},screenChanges:[[1,row]]}});
  assert.equal(next.terminal.history,first.terminal.history);
  assert.equal(next.terminal.screen[0],first.terminal.screen[0]);
  assert.equal(next.terminal.screen[1],row);
  assert.equal(first.terminal.screen[1].cells[0][0],'y');
  assert.equal(next.controller,'second');
  assert.deepEqual(next.terminal.modes,{win32:true});
  assert.equal(next.type,'snapshot');
});

test('history updates discard bounded heads and tails and append owned rows', () => {
  const first={id:'s1',seq:4,epoch:1,terminal:{cols:4,rows:1,history:['a','b','c'],screen:['x']}};
  const update={type:'update',id:'s1',base:4,seq:5,epoch:1,terminal:{cols:4,rows:1,historyChanges:{drop:1,keep:1,append:['new']},screenChanges:[]}};
  const next=mergeUpdate(first,update);
  assert.deepEqual(next.terminal.history,['b','new']);
  assert.deepEqual(first.terminal.history,['a','b','c']);
  assert.equal(next.terminal.historyChanges,undefined);
  assert.equal(next.terminal.screenChanges,undefined);
});

test('updates reject wrong bases, sessions, epochs and invalid row ranges', () => {
  const first={id:'s1',seq:4,epoch:2,terminal:{cols:4,rows:1,history:[],screen:['x']}};
  const update={type:'update',id:'s1',base:4,seq:5,epoch:2,terminal:{cols:4,rows:1,screenChanges:[]}};
  for(const change of [{base:3},{id:'s2'},{seq:4},{epoch:1},{terminal:{cols:4,rows:1,screenChanges:[[2,{}]]}},{terminal:{cols:4,rows:1,historyChanges:{drop:0,keep:1,append:[]}}},{terminal:{cols:5,rows:1,screenChanges:[]}}])assert.equal(mergeUpdate(first,{...update,...change}),null);
  assert.equal(mergeUpdate(null,update),null);
  assert.deepEqual(mergeUpdate(first,{...update,terminal:{cols:5,rows:2,screen:['a','b'],history:[]}}).terminal.screen,['a','b']);
});

test('folder breadcrumbs display DOS names while preserving canonical paths', () => {
  const path = '\\\\?\\C:\\Work\\日本語 📁\\Reports & notes';
  const crumbs = pathCrumbs(path);
  assert.deepEqual(crumbs.map(crumb => crumb.label), ['C:', 'Work', '日本語 📁', 'Reports & notes']);
  assert.equal(crumbs[0].path, '\\\\?\\C:\\');
  assert.equal(crumbs[2].path, '\\\\?\\C:\\Work\\日本語 📁');
  assert.equal(crumbs.at(-1).path, path);
});

test('folder breadcrumbs keep a UNC share as the root navigation target', () => {
  const path = '\\\\?\\UNC\\fixture-server\\shared files\\Projects';
  const crumbs = pathCrumbs(path);
  assert.deepEqual(crumbs.map(crumb => crumb.label), ['\\\\fixture-server\\shared files', 'Projects']);
  assert.equal(crumbs[0].path, '\\\\?\\UNC\\fixture-server\\shared files\\');
  assert.equal(crumbs.at(-1).path, path);
  assert.equal(pathCrumbs('\\\\fixture-server\\shared files')[0].path, '\\\\fixture-server\\shared files');
});

class EventSource {
  listeners = new Map();
  value = '';
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  emit(name, event = {}) { for (const callback of this.listeners.get(name) || []) callback(event); }
  focus() {}
}

function key(key, code, options = {}) {
  return {
    key, code, keyCode: options.keyCode ?? 0,
    shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false,
    ...options,
    prevented: false,
    getModifierState(name) { return Boolean(this.locks?.includes(name)); },
    preventDefault() { this.prevented = true; },
  };
}

function inputFixture(modes = {}, controlling = true) {
  const keyboard = new EventSource();
  const scroll = new EventSource();
  const sent = [];
  let ownsSession = controlling;
  globalThis.document = {getSelection: () => ({isCollapsed:true})};
  const renderer = {setFrozen() {}, cellAt() { return {x:5,y:3}; }};
  const input = new TerminalInput({
    keyboard, scroll, renderer,
    snapshot: () => ({terminal:{modes}}),
    canInput: () => ownsSession,
    send: data => sent.push(data), notify() {},
  });
  return {input, keyboard, scroll, sent, observe() { ownsSession = false; }};
}

test('Win32 records keep Shift+Enter and Ctrl+Space distinct', () => {
  const {input, sent} = inputFixture({win32:true});
  const enter = key('Enter','Enter',{keyCode:13,shiftKey:true});
  const space = key(' ','Space',{keyCode:32,ctrlKey:true});
  input.keydown(enter); input.keyup(enter);
  input.keydown(space); input.keyup(space);
  assert.deepEqual(sent, [
    `${ESC}[13;28;13;1;16;1_`, `${ESC}[13;28;13;0;16;1_`,
    `${ESC}[32;57;0;1;8;1_`, `${ESC}[32;57;0;0;8;1_`,
  ]);
  assert.equal(enter.prevented, true);
  assert.equal(space.prevented, true);
});

test('Win32 repeats and Ctrl+Alt retain scan codes and key transitions', () => {
  const {input, sent} = inputFixture({win32:true});
  const letter = key('x','KeyX',{keyCode:88});
  const repeat = key('x','KeyX',{keyCode:88,repeat:true});
  const ctrlAlt = key('a','KeyA',{keyCode:65,ctrlKey:true,altKey:true});
  input.keydown(letter); input.keydown(repeat); input.keyup(letter);
  input.keydown(ctrlAlt); input.keyup(ctrlAlt);
  assert.deepEqual(sent, [
    `${ESC}[88;45;120;1;0;1_`, `${ESC}[88;45;120;1;0;1_`, `${ESC}[88;45;120;0;0;1_`,
    `${ESC}[65;30;0;1;10;1_`, `${ESC}[65;30;0;0;10;1_`,
  ]);
});

test('Win32 reports right-side modifier state and keypad scan codes', () => {
  const {input, sent} = inputFixture({win32:true});
  const rightCtrl = key('Control','ControlRight',{keyCode:17,ctrlKey:true});
  const rightAlt = key('Alt','AltRight',{keyCode:18,ctrlKey:true,altKey:true});
  const letter = key('a','KeyA',{keyCode:65,ctrlKey:true,altKey:true});
  const keypadEnter = key('Enter','NumpadEnter',{keyCode:13});
  input.keydown(rightCtrl); input.keydown(rightAlt); input.keydown(letter);
  input.keyup(key('Alt','AltRight',{keyCode:18,ctrlKey:true,altKey:false}));
  input.keyup(key('Control','ControlRight',{keyCode:17,ctrlKey:false}));
  input.keydown(keypadEnter);
  assert.deepEqual(sent, [
    `${ESC}[17;29;0;1;260;1_`, `${ESC}[18;56;0;1;261;1_`,
    `${ESC}[65;30;0;1;5;1_`, `${ESC}[18;56;0;0;260;1_`,
    `${ESC}[17;29;0;0;256;1_`, `${ESC}[13;28;13;1;256;1_`,
  ]);
});

test('focus loss and session switch do not carry Win32 keys into later input', () => {
  const {input, keyboard, sent} = inputFixture({win32:true});
  input.keydown(key('Control','ControlRight',{keyCode:17,ctrlKey:true}));
  keyboard.emit('blur');
  input.keydown(key('Control','ControlLeft',{keyCode:17,ctrlKey:true}));
  input.keydown(key('a','KeyA',{keyCode:65,ctrlKey:true}));
  assert.equal(sent.at(-1), `${ESC}[65;30;1;1;8;1_`);
  input.reset();
  const count = sent.length;
  input.keyup(key('a','KeyA',{keyCode:65,ctrlKey:false}));
  assert.equal(sent.length, count);
});

test('classic mode encodes modified navigation, function keys and keypad', () => {
  const {input, sent} = inputFixture({appCursor:true,appKeypad:true});
  for (const event of [
    key('ArrowUp','ArrowUp',{shiftKey:true,ctrlKey:true}),
    key('F1','F1',{shiftKey:true}),
    key('F12','F12',{ctrlKey:true}),
    key('1','Numpad1'),
    key('Enter','Enter',{shiftKey:true}),
    key(' ','Space',{ctrlKey:true}),
    key('a','KeyA',{ctrlKey:true,altKey:true}),
  ]) input.keydown(event);
  assert.deepEqual(sent, [
    `${ESC}[1;6A`, `${ESC}[1;2P`, `${ESC}[24;5~`, `${ESC}Oq`,
    `${ESC}[27;2;13~`, '\0', `${ESC}\x01`,
  ]);
});

test('paste preserves multiline boundaries and bracketed paste exactly once', () => {
  const modes = {bracketedPaste:true};
  const {input, sent} = inputFixture(modes);
  input.pasteText('first\r\nsecond\nthird\rfourth');
  assert.deepEqual(sent, [`${ESC}[200~first\nsecond\nthird\nfourth${ESC}[201~`]);
  modes.bracketedPaste = false;
  input.pasteText('a\nb');
  assert.equal(sent[1], 'a\rb');
});

test('composition commits Unicode once even when a final beforeinput follows', () => {
  const {input, keyboard, sent} = inputFixture();
  keyboard.emit('compositionstart');
  input.keydown(key('Process','KeyA',{isComposing:true}));
  keyboard.emit('beforeinput', {inputType:'insertCompositionText',data:'漢',isComposing:true});
  keyboard.emit('compositionend', {data:'漢'});
  const finalInput = {inputType:'insertText',data:'漢',isComposing:false,prevented:false,preventDefault() {this.prevented=true;}};
  keyboard.emit('beforeinput', finalInput);
  input.keydown(key('x','KeyX'));
  assert.deepEqual(sent, ['漢','x']);
  assert.equal(finalInput.prevented, true);
});

test('late IME completion after a tab switch cannot enter the new session', () => {
  const {input, keyboard, sent} = inputFixture();
  keyboard.emit('compositionstart');
  input.reset();
  keyboard.emit('compositionend', {data:'漢'});
  const late = {inputType:'insertText',data:'漢',prevented:false,preventDefault() {this.prevented=true;}};
  keyboard.emit('beforeinput', late);
  assert.deepEqual(sent, []);
  assert.equal(late.prevented, true);
  keyboard.emit('compositionstart');
  keyboard.emit('compositionend', {data:'新'});
  keyboard.emit('beforeinput', {inputType:'insertText',data:'新',preventDefault() {}});
  assert.deepEqual(sent, ['新']);
});

test('IME commit before late compositionend is discarded after a tab switch', () => {
  const {input, keyboard, sent} = inputFixture();
  keyboard.emit('compositionstart');
  input.reset();
  const early = {inputType:'insertFromComposition',data:'漢',prevented:false,preventDefault() {this.prevented=true;}};
  keyboard.emit('beforeinput', early);
  keyboard.emit('compositionend', {data:'漢'});
  const duplicate = {inputType:'insertText',data:'漢',prevented:false,preventDefault() {this.prevented=true;}};
  keyboard.emit('beforeinput', duplicate);
  assert.deepEqual(sent, []);
  assert.equal(early.prevented, true);
  assert.equal(duplicate.prevented, true);
  keyboard.emit('beforeinput', {inputType:'insertText',data:'x',preventDefault() {}});
  keyboard.emit('compositionstart');
  keyboard.emit('compositionend', {data:'新'});
  assert.deepEqual(sent, ['x','新']);
});

test('observer cannot write keys, paste, focus or mouse reports', () => {
  const {input, sent, observe} = inputFixture({win32:true,bracketedPaste:true,focus:true,mouse:1003,mouseSgr:true});
  observe();
  input.keydown(key('x','KeyX',{keyCode:88}));
  input.keyup(key('x','KeyX',{keyCode:88}));
  input.pasteText('text');
  input.focusReport(true);
  input.wheel({deltaY:-1,shiftKey:false,altKey:false,ctrlKey:false});
  assert.deepEqual(sent, []);
});

test('classic mouse stops at ConPTY UTF-8 boundary while SGR keeps column 96', () => {
  const modes = {mouse:1000,mouseSgr:false};
  const {input} = inputFixture(modes);
  const event = {shiftKey:false,altKey:false,ctrlKey:false};
  input.renderer.cellAt = () => ({x:95,y:95});
  assert.equal(input.mouseSequence(event,0), `${ESC}[M ${String.fromCharCode(127,127)}`);
  input.renderer.cellAt = () => ({x:96,y:95});
  assert.equal(input.mouseSequence(event,0), null);
  input.renderer.cellAt = () => ({x:95,y:96});
  assert.equal(input.mouseSequence(event,0), null);
  modes.mouseSgr = true;
  input.renderer.cellAt = () => ({x:96,y:96});
  assert.equal(input.mouseSequence(event,0), `${ESC}[<0;96;96M`);
});

test('wide grapheme cells omit continuation and selection joins wrapped rows', () => {
  const line = {cells:[['e\u0301',1,'','','',''],['🙂',2,'','','',''],['',0,'','','',''],['続',2,'','','',''],['',0,'','','','']]};
  assert.equal(lineText(line), 'e\u0301🙂続');
  const rows = [
    {dataset:{index:'0',wrapped:'true'}},
    {dataset:{index:'1',wrapped:'false'}},
    {dataset:{index:'2',wrapped:'false'}},
  ];
  const renderer = Object.create(TerminalRenderer.prototype);
  renderer.lines = {children:rows,contains:row => rows.includes(row)};
  globalThis.document = {getSelection: () => ({
    isCollapsed:false,
    toString: () => 'e\u0301🙂\n続\nfinal',
    getRangeAt: () => ({
      startContainer:{parentElement:{closest:() => rows[0]}},
      endContainer:{parentElement:{closest:() => rows[2]}},
    }),
  })};
  assert.equal(renderer.selectionText(), 'e\u0301🙂続\nfinal');
});
