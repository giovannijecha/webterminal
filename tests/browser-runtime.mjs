import {findChrome} from './cli-browser-support.mjs';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFile, mkdir, rm} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const forceReducedMotion = process.env.WEBTERMINAL_TEST_REDUCED_MOTION === '1';
const scratch = resolve(root, '.tmp');
const profile = resolve(scratch, 'browser-runtime-' + process.pid + '-' + Date.now());
if (!profile.startsWith(scratch + sep)) throw new Error('Profile path escaped .tmp');
const chrome = await findChrome();

const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/terminal.css"><title>Browser fixture</title></head><body><div id="scroll" class="terminal-scroll" style="position:relative;inset:auto;width:800px;height:400px;padding:14px 18px;overflow:auto"><div id="lines" class="terminal-lines"></div></div><textarea id="keyboard"></textarea><script type="module" src="/harness.js"></script></body></html>';
const harness = String.raw`
import {TerminalRenderer} from '/render.js';
import {TerminalInput} from '/input.js';

const ESC = '\x1b';
const scroll = document.getElementById('scroll');
const lines = document.getElementById('lines');
const keyboard = document.getElementById('keyboard');
const renderer = new TerminalRenderer(scroll, lines);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const results = [];
function check(name, run) {
  try { run(); results.push({name, pass:true}); }
  catch (error) { results.push({name, pass:false, error:String(error && error.message || error)}); }
}
function expect(value, message) { if (!value) throw new Error(message); }
function equal(actual, expected, message) { if (actual !== expected) throw new Error(message + ': got ' + JSON.stringify(actual) + ', expected ' + JSON.stringify(expected)); }
function cell(text, width, fg='#dce4ed', bg='#10151c', attrs=0, link='') { return [text,width,fg,bg,attrs,link]; }
function line(text, wrapped=false) { return {wrapped,cells:[...text].map(character => cell(character,1))}; }
const revisions = new Map();
function wireLine(line) {
  if (line.runs) return line;
  const key = JSON.stringify(line);
  if (!revisions.has(key)) revisions.set(key,revisions.size + 1);
  return {rev:revisions.get(key),wrapped:line.wrapped,runs:line.cells.map(([text,width,fg,bg,attrs,link]) => [fg,bg,attrs,link,[[text,width]]])};
}
function shot(history, screen, options={}) { history=history.map(wireLine);screen=screen.map(wireLine);return {id:'fixture',seq:options.seq || 1,epoch:1,controller:'view',alive:true,terminal:{cols:80,rows:screen.length,cursor:[0,0,false,'block'],title:'fixture',alternate:false,modes:{},history,screen}}; }

if (${forceReducedMotion}) check('reduced motion is enabled in the browser', () => {
  expect(reducedMotion,'the browser honors the reduced-motion test flag');
});

check('DOM width, style, safe link, Unicode cells', () => {
  const first = {wrapped:true,cells:[cell('e\u0301',1,'#ff0000','#10151c',1),cell('🙂',2),cell('',0),cell('Z',1,'#dce4ed','#10151c',0,'javascript:alert(1)')]};
  const second = {wrapped:false,cells:[cell('続',2),cell('',0),cell('X',1,'#dce4ed','#10151c',0,'https://example.test/')]};
  renderer.render(shot([], [first,second,line('last')]), true);
  equal(lines.children[0].textContent, 'e\u0301🙂Z', 'wide continuation should not duplicate text');
  expect(Math.abs(lines.children[0].children[1].getBoundingClientRect().width - 2 * renderer.cellWidth) < 1, 'wide cell width');
  equal(getComputedStyle(lines.children[0].children[0]).color, 'rgb(255, 0, 0)', 'cell foreground');
  equal(lines.querySelectorAll('a').length, 1, 'unsafe hyperlink must not render');
  expect(lines.querySelector('a').href.startsWith('https://example.test/'), 'safe hyperlink');
});

check('native selection joins wrapped Unicode rows', () => {
  const range = document.createRange();
  range.setStart(lines.children[0].children[0].firstChild, 0);
  range.setEnd(lines.children[2].lastChild.firstChild, 4);
  const selection = document.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  equal(renderer.selectionText(), 'e\u0301🙂Z続X\nlast', 'wrapped copy');
  selection.removeAllRanges();
});

check('cursor on wide continuation highlights its glyph', () => {
  const screen = [{wrapped:false,cells:[cell('界',2),cell('',0),cell('Z',1)]}];
  const first = shot([],screen,{seq:5});
  first.terminal.cursor=[1,0,true,'block'];
  renderer.render(first);
  equal(lines.querySelector('.cursor')?.textContent,'界','continuation cursor glyph');
  const next = shot([],screen,{seq:6});
  next.terminal.cursor=[2,0,true,'block'];
  renderer.render(next);
  equal(lines.querySelector('.cursor')?.textContent,'Z','cursor moves off wide glyph');
});

check('blank colored bands and style-only updates paint whole cells', () => {
  const band = text => ({wrapped:false,cells:[...text.padEnd(8)].map(character => cell(character,1,'#cccccc','#303030'))});
  const styled = attrs => ({wrapped:false,cells:[cell('F',1,'#cccccc','#1e1e1e',attrs),cell(' ',1,'#cccccc','#303030')]});
  const first = shot([band('')],[band('> msg'),styled(2)],{seq:7});
  first.terminal.cursor=[6,0,true,'block'];
  renderer.render(first);
  for (const row of [0,1]) {
    const nodes = [...lines.children[row].children];
    const width = nodes.reduce((sum,node) => sum + node.getBoundingClientRect().width,0);
    expect(nodes.every(node => node.classList.contains('cursor') || getComputedStyle(node).backgroundColor === 'rgb(48, 48, 48)'),'band background on row '+row);
    expect(Math.abs(width - 8 * renderer.cellWidth) < 1,'band spans every column on row '+row);
  }
  const faint = getComputedStyle(lines.children[2].children[0]);
  equal(faint.backgroundColor,'rgb(30, 30, 30)','faint keeps its cell background');
  expect(faint.color !== 'rgb(204, 204, 204)','faint dims the glyph');
  equal(lines.querySelector('.cursor.block')?.textContent,' ','block cursor inside a band');
  const kept = lines.children[1];
  const next = shot([band('')],[band('> msg'),styled(32)],{seq:8});
  next.terminal.cursor=first.terminal.cursor;
  renderer.render(next);
  equal(lines.children[1],kept,'unchanged band row stays attached');
  equal(getComputedStyle(lines.children[2].children[0]).backgroundColor,'rgb(204, 204, 204)','style-only inverse update repaints');
});

check('blinking text preserves its cell background', () => {
  renderer.clear();
  renderer.render(shot([], [{wrapped:false,cells:[cell('B',1,'#112233','#304050',16)]}]));
  const node=lines.querySelector('.term-cell');
  const animation=node.getAnimations().find(item=>item.animationName==='text-blink');
  expect(Boolean(animation)!==reducedMotion,'text animation follows the motion preference');
  if(animation){animation.pause();animation.currentTime=750;}
  const style=getComputedStyle(node);
  equal(style.opacity,'1','blink never attenuates the cell background');
  equal(style.backgroundColor,'rgb(48, 64, 80)','blink retains the background color');
  equal(style.color,reducedMotion?'rgb(17, 34, 51)':'rgba(0, 0, 0, 0)','glyph visibility follows the motion preference');
});

check('block cursor blinks back to the original cell colors', () => {
  renderer.clear();
  const snapshot=shot([], [{wrapped:false,cells:[cell('C',1,'#112233','#304050')]}]);
  snapshot.terminal.cursor=[0,0,true,'block'];
  renderer.render(snapshot);
  const node=lines.querySelector('.cursor.block');
  const animation=node.getAnimations().find(item=>item.animationName==='cursor-blink');
  if(reducedMotion){
    expect(!animation,'reduced motion disables cursor animation');
    equal(getComputedStyle(node).backgroundColor,'rgb(204, 204, 204)','static cursor keeps its rectangular highlight');
    equal(getComputedStyle(node).color,'rgb(30, 30, 30)','static cursor keeps its contrasting glyph');
    return;
  }
  expect(animation,'block cursor has an animation');
  animation.pause();animation.currentTime=0;
  equal(getComputedStyle(node).backgroundColor,'rgb(204, 204, 204)','cursor keeps its rectangular highlight');
  animation.currentTime=750;
  const style=getComputedStyle(node);
  equal(style.backgroundColor,'rgb(48, 64, 80)','cursor blink restores the original background');
  equal(style.color,'rgb(17, 34, 51)','cursor blink restores the original foreground');
});

check('underline and strikethrough remain visible together', () => {
  renderer.clear();
  renderer.render(shot([], [{wrapped:false,cells:[cell('U',1,'#112233','#304050',8|128)]}]));
  const decoration=getComputedStyle(lines.querySelector('.term-cell')).textDecorationLine;
  expect(decoration.includes('underline')&&decoration.includes('line-through'),'both text decorations are drawn');
});

check('history search and frozen viewport', () => {
  const history = Array.from({length:55}, (_,index) => line(index === 18 ? 'needle row' : 'history row ' + index));
  renderer.clear(); renderer.setSearch('needle');
  renderer.render(shot(history,[line('old output'),line('prompt')],{seq:2}));
  equal(renderer.matches.length,1,'search should include history');
  renderer.nextMatch(1);
  const position = scroll.scrollTop;
  expect(position > 0, 'match should scroll into view');
  renderer.setFrozen(true);
  renderer.render(shot(history,[line('new output'),line('prompt')],{seq:3}));
  expect(!lines.textContent.includes('new output'), 'selection freeze should hold DOM');
  equal(scroll.scrollTop,position,'frozen viewport position');
  renderer.setFrozen(false);
  expect(lines.textContent.includes('new output'), 'pending snapshot should render after unfreeze');
});

check('unchanged DOM rows stay attached while ASCII runs retain exact cursor and search columns', () => {
  renderer.clear();renderer.setSearch('');
  const first=shot([], [line('unchanged row'),line('abcd'),line('aaaa')],{seq:10});
  first.terminal.cursor=[2,1,true,'block'];
  renderer.render(first);
  const row=lines.children[0];
  expect(row.children.length===1,'ASCII row should use one styled run');
  equal(lines.querySelector('.cursor').textContent,'c','cursor spans exactly one cell');
  const observer=new MutationObserver(()=>{});observer.observe(lines,{childList:true});
  const next=shot([], [first.terminal.screen[0],line('abXd'),first.terminal.screen[2]],{seq:11});
  next.terminal.cursor=[3,1,true,'bar'];renderer.render(next);
  equal(lines.children[0],row,'unchanged row identity');
  expect(!observer.takeRecords().some(record=>[...record.removedNodes].includes(row)),'unchanged row must not be detached');
  observer.disconnect();
  equal(lines.querySelector('.cursor').textContent,'d','cursor preserves the new column');
  renderer.setSearch('aa');equal(renderer.matches.length,2,'adjacent search matches');renderer.nextMatch(1);
  equal(lines.querySelectorAll('.active-match').length,1,'only one adjacent match is active');
  equal(lines.querySelector('.active-match').textContent,'aa','active match has exact text');
  renderer.setSearch('');
});

check('resize dimensions remain inside protocol bounds', () => {
  scroll.style.width='10000px'; scroll.style.height='4000px';
  const size = renderer.dimensions();
  equal(size.cols,300,'column cap'); equal(size.rows,120,'row cap');
  scroll.style.width='800px'; scroll.style.height='400px';
  expect(renderer.dimensions().cols > 50, 'restored width');
  scroll.style.height='1px';equal(renderer.dimensions().rows,1,'one-row protocol minimum');scroll.style.height='400px';
});

check('theme defaults and ANSI colors retain their identities', () => {
  renderer.clear();
  const snapshot=shot([], [{wrapped:false,cells:[cell('D',1,null,null),cell('Y',1,3,null),cell('R',1,'#cccccc','#1e1e1e')]}]);
  renderer.render(snapshot);
  const [defaults,ansi,explicit]=lines.querySelectorAll('.term-cell');
  document.documentElement.dataset.terminalTheme='light';
  equal(getComputedStyle(defaults).color,'rgb(39, 39, 42)','default uses light foreground');
  equal(getComputedStyle(defaults).backgroundColor,'rgb(251, 251, 251)','default uses light background');
  equal(getComputedStyle(ansi).color,'rgb(121, 94, 0)','ANSI yellow is readable on light background');
  equal(getComputedStyle(explicit).color,'rgb(204, 204, 204)','explicit RGB foreground is never reinterpreted');
  equal(getComputedStyle(explicit).backgroundColor,'rgb(30, 30, 30)','explicit RGB background is never reinterpreted');
  expect(!lines.querySelector('.term-line').hasAttribute('aria-label'),'generic rows do not duplicate their text as labels');
  delete document.documentElement.dataset.terminalTheme;
});

check('terminal strokes fill cells without clipping fallback glyphs', () => {
  renderer.clear();
  renderer.render(shot([], [line('\u2502\u2588\u250c\u2554\u256d'),line('\u2502\u2588') ]));
  const shapes=lines.querySelectorAll('.graphic');
  equal(shapes.length,7,'box and block characters have cell-sized shapes');
  const top=shapes[0].querySelector('svg').getBoundingClientRect();
  const bottom=shapes[5].querySelector('svg').getBoundingClientRect();
  expect(Math.abs(top.bottom-bottom.top)<.1,'vertical strokes meet at adjacent row edges');
  equal(getComputedStyle(shapes[0]).overflow,'visible','cells allow accents and fallback glyphs to extend');
  equal(lines.children[0].textContent,'\u2502\u2588\u250c\u2554\u256d','painted graphics preserve selectable Unicode text');
  equal(getComputedStyle(lines.children[0]).contentVisibility,'visible','visible rows allow overflowing glyph ink');
  const row=lines.children[0], probe=document.createElement('span');
  row.style.position='relative';probe.style.cssText='position:absolute;left:0;top:-5px;width:4px;height:4px;background:red';row.append(probe);
  const ink=probe.getBoundingClientRect();
  equal(document.elementFromPoint(ink.left+2,ink.top+2),probe,'visible row allows glyph ink beyond its top edge');
  probe.remove();
});

check('changing a cursor row preserves its blink clock', () => {
  renderer.clear();
  const first=shot([], [line('old')]);first.terminal.cursor=[0,0,true,'block'];renderer.render(first);
  const old=lines.querySelector('.cursor').getAnimations().find(item=>item.animationName==='cursor-blink');
  if (!old) return;
  old.startTime=document.timeline.currentTime-300;
  const start=old.startTime;
  const next=shot([], [line('new')]);next.terminal.cursor=first.terminal.cursor;renderer.render(next);
  const animation=lines.querySelector('.cursor').getAnimations().find(item=>item.animationName==='cursor-blink');
  equal(animation.startTime,start,'a repaint keeps the cursor animation start time');
});

const sent = [];
let controlling = true;
const modes = {win32:true,bracketedPaste:true,mouse:1000,mouseSgr:true,focus:true};
const input = new TerminalInput({keyboard,scroll,renderer,snapshot:() => ({terminal:{modes}}),canInput:() => controlling,send:data => sent.push(data),notify() {}});
function key(type,name,code,init={},keyCode=0) {
  const event = new KeyboardEvent(type,{key:name,code,bubbles:true,cancelable:true,...init});
  Object.defineProperty(event,'keyCode',{value:keyCode});
  if (init.altGraph) Object.defineProperty(event,'getModifierState',{value: name => name === 'AltGraph'});
  keyboard.dispatchEvent(event);
  return event;
}

check('dispatched Win32 modified key and focus', () => {
  keyboard.dispatchEvent(new Event('focus'));
  key('keydown','Enter','Enter',{shiftKey:true},13);
  key('keyup','Enter','Enter',{shiftKey:true},13);
  equal(sent[0],ESC+'[I','focus report');
  equal(sent[1],ESC+'[13;28;13;1;16;1_','Shift+Enter down');
  equal(sent[2],ESC+'[13;28;13;0;16;1_','Shift+Enter up');
});

check('Win32 control characters, AltGraph and keypad records', () => {
  input.reset(); sent.length=0;
  key('keydown','a','KeyA',{ctrlKey:true},65);
  key('keydown','c','KeyC',{ctrlKey:true},67);
  key('keydown','@','KeyQ',{ctrlKey:true,altKey:true,altGraph:true},81);
  key('keydown','1','Numpad1',{},97);
  key('keydown','Shift','ShiftRight',{shiftKey:true},16);
  equal(sent[0],ESC+'[65;30;1;1;8;1_','Ctrl+A UnicodeChar');
  equal(sent[1],ESC+'[67;46;3;1;8;1_','Ctrl+C UnicodeChar');
  equal(sent[2],ESC+'[81;16;64;1;9;1_','AltGraph printable UnicodeChar');
  equal(sent[3],ESC+'[97;79;49;1;0;1_','Numpad1 scan code');
  equal(sent[4],ESC+'[16;54;0;1;16;1_','right Shift is not enhanced');
  const count=sent.length;
  key('keydown','v','KeyV',{ctrlKey:true},86);
  key('keyup','v','KeyV',{ctrlKey:true},86);
  equal(sent.length,count,'skipped paste shortcut key-up');
});

check('dispatched IME commit and multiline paste', () => {
  modes.win32=false;
  const before = sent.length;
  keyboard.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
  keyboard.dispatchEvent(new CompositionEvent('compositionend',{data:'漢',bubbles:true}));
  keyboard.dispatchEvent(new InputEvent('beforeinput',{inputType:'insertText',data:'漢',bubbles:true,cancelable:true}));
  equal(sent.length,before+1,'IME sent once'); equal(sent.at(-1),'漢','IME text');
  const transfer = new DataTransfer(); transfer.setData('text/plain','a\r\nb\nc');
  keyboard.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  equal(sent.at(-1),ESC+'[200~a\nb\nc'+ESC+'[201~','bracketed paste');
});

check('late IME commit after reset cannot enter a new terminal', () => {
  const count=sent.length;
  keyboard.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
  input.reset();
  // Chromium's InputEvent constructor normalizes this browser-generated type
  // to an empty string; define it on a dispatched DOM event for the fixture.
  const early=new Event('beforeinput',{bubbles:true,cancelable:true});
  Object.defineProperties(early,{inputType:{value:'insertFromComposition'},data:{value:'漢'}});
  keyboard.dispatchEvent(early);
  keyboard.dispatchEvent(new CompositionEvent('compositionend',{data:'漢',bubbles:true}));
  const late=new InputEvent('beforeinput',{inputType:'insertText',data:'漢',bubbles:true,cancelable:true});
  keyboard.dispatchEvent(late);
  equal(sent.length,count,'stale IME text was sent');
  expect(early.defaultPrevented && late.defaultPrevented,'stale browser commits were not cancelled');
  keyboard.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
  keyboard.dispatchEvent(new CompositionEvent('compositionend',{data:'新',bubbles:true}));
  equal(sent.at(-1),'新','a fresh IME composition must still work');
});

check('dispatched mouse button, wheel and observer isolation', () => {
  renderer.clear(); renderer.setSearch('');
  renderer.render(shot([], [line('mouse'),line('prompt')],{seq:4}));
  scroll.setPointerCapture = () => {};
  scroll.hasPointerCapture = () => false;
  const rect = lines.getBoundingClientRect();
  const x = rect.left + renderer.cellWidth * 2.5;
  const y = rect.top + renderer.lineHeight * .5;
  scroll.dispatchEvent(new PointerEvent('pointerdown',{clientX:x,clientY:y,button:0,pointerId:1,bubbles:true,cancelable:true}));
  scroll.dispatchEvent(new PointerEvent('pointerup',{clientX:x,clientY:y,button:0,pointerId:1,bubbles:true,cancelable:true}));
  scroll.dispatchEvent(new WheelEvent('wheel',{clientX:x,clientY:y,deltaY:-100,bubbles:true,cancelable:true}));
  expect(sent.some(item => item === ESC+'[<0;3;1M'), 'mouse down report');
  expect(sent.some(item => item === ESC+'[<0;3;1m'), 'mouse up report');
  expect(sent.some(item => item === ESC+'[<64;3;1M'), 'mouse wheel report');
  controlling=false;
  const count=sent.length;
  key('keydown','x','KeyX',{},88);
  keyboard.dispatchEvent(new Event('focus'));
  const transfer = new DataTransfer(); transfer.setData('text/plain','blocked');
  keyboard.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  scroll.dispatchEvent(new WheelEvent('wheel',{clientX:x,clientY:y,deltaY:-100,bubbles:true,cancelable:true}));
  equal(sent.length,count,'observer input');
});

const report = {pass:results.every(item => item.pass),results,userAgent:navigator.userAgent};
const bytes = new TextEncoder().encode(JSON.stringify(report));
document.body.dataset.result = btoa(Array.from(bytes,byte => String.fromCharCode(byte)).join(''));
`;

await mkdir(profile, {recursive:true});
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://127.0.0.1').pathname;
  try {
    if (path === '/') { response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); response.end(html); return; }
    if (path === '/harness.js') { response.writeHead(200, {'Content-Type':'text/javascript; charset=utf-8'}); response.end(harness); return; }
    const names = {'/input.js':'input.js','/render.js':'render.js','/style.css':'style.css','/terminal.css':'terminal.css'};
    if (!names[path]) { response.writeHead(404); response.end(); return; }
    const content = await readFile(resolve(root, 'assets', names[path]));
    response.writeHead(200, {'Content-Type':path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8'});
    response.end(content);
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
const url = 'http://127.0.0.1:' + server.address().port + '/';
let output = '';
let errors = '';
let exitCode;
try {
  const child = spawn(chrome, ['--headless=new',...(forceReducedMotion?['--force-prefers-reduced-motion']:[]),'--dump-dom','--virtual-time-budget=5000','--window-size=1200,900','--user-data-dir=' + profile,url], {windowsHide:true});
  const timeout = setTimeout(() => child.kill(), 30000);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  exitCode = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  clearTimeout(timeout);
} finally {
  await new Promise(resolveClose => server.close(resolveClose));
  await rm(profile, {recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(() => {});
}
if (exitCode !== 0) throw new Error('Chrome exited ' + exitCode + ': ' + errors.slice(-2000));
const match = output.match(/data-result="([A-Za-z0-9+/=]+)"/);
if (!match) throw new Error('Chrome did not serialize fixture results. stderr: ' + errors.slice(-2000) + '\nDOM: ' + output.slice(-1000));
const report = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
for (const result of report.results) console.log((result.pass ? 'PASS ' : 'FAIL ') + result.name + (result.error ? ': ' + result.error : ''));
console.log('Chrome ' + report.userAgent);
assert.equal(report.pass, true, 'Browser fixture failed');
