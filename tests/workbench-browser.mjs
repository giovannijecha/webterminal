// Original UI acceptance through the embedded assets, WebSocket and cmd.exe.
// All processes, files and Chrome storage belong to this disposable fixture.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile, mkdir, rm, writeFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeProbe, findChrome, freePort, proxyFor, ready, stopChild, stopProxy} from './cli-browser-support.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const target=resolve(root,'target');
const runRoot=resolve(target,`workbench-${process.pid}-${Date.now()}`);
assert.ok(runRoot.startsWith(target+sep));
const cwd=resolve(runRoot,'sample-workspace');
const longDirectory=resolve(cwd,'a-long-project-directory-for-checking-terminal-labels-and-layout');
const executable=resolve(runRoot,'webterminal.exe');
const script=resolve(runRoot,'preview.cmd');
const screenshots=resolve(target,'ui-preview');
await mkdir(longDirectory,{recursive:true});
for(const name of ['.project','assets','src','tests','release-notes','reports & notes','日本語 📁'])await mkdir(resolve(cwd,name),{recursive:true});
await mkdir(screenshots,{recursive:true});
await copyFile(resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(target,'debug'),'webterminal.exe'),executable);
await writeFile(script,'@echo off\r\nchcp 65001 >nul\r\ntitle Webterminal UI fixture\r\necho.\r\necho \x1b[36mWebterminal local terminal\x1b[0m\r\necho.\r\necho   This is an isolated interface fixture.\r\necho   Each tab has its own Windows shell and working directory.\r\necho   Refresh the browser to restore your running session.\r\necho.\r\necho \x1b[32mReady for input.\x1b[0m\r\necho.\r\nprompt $P$G\r\n','utf8');

const harness=String.raw`
const CWD=__CWD__,LONG=__LONG__;
const $=id=>document.getElementById(id);
const results=[];
const contrasts=[];
const pause=ms=>fetch('/probe-pause?ms='+ms,{cache:'no-store'});
async function until(test,label){for(let i=0;i<240;i++){const result=await test();if(result)return result;await pause(50);}throw new Error('Timed out: '+label);}
function check(value,label){if(!value)throw new Error(label);results.push(label);}
function rgba(value){const numbers=value.match(/[\d.]+/g).map(Number);return [...numbers.slice(0,3),numbers[3]??1];}
function background(element){
  const color=rgba(getComputedStyle(element).backgroundColor);
  if(color[3]===1)return color.slice(0,3);
  const parent=element.parentElement?background(element.parentElement):[30,30,30];
  return color.slice(0,3).map((channel,index)=>channel*color[3]+parent[index]*(1-color[3]));
}
function luminance(color){return color.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,index)=>sum+v*[.2126,.7152,.0722][index],0);}
function contrast(label,element,property='color',minimum=4.5,pseudo){
  const fg=luminance(rgba(getComputedStyle(element,pseudo)[property]).slice(0,3));
  const backgrounds=property.startsWith('border')?[background(element),background(element.parentElement)]:[background(element)];
  const ratio=Math.min(...backgrounds.map(color=>{const bg=luminance(color);return(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05);}));
  contrasts.push({label,ratio:+ratio.toFixed(2),minimum});
  if(ratio<minimum)throw new Error(label+' contrast '+ratio.toFixed(2)+' below '+minimum);
}
function eventKey(target,key){target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
async function capture(name,width){document.body.dataset.capture=JSON.stringify({name,width});await until(()=>document.body.dataset.captured===name,'capture '+name);}
async function pressEscape(){document.body.dataset.keyRequest='Escape';await until(()=>document.body.dataset.keyDone==='Escape','native Escape');document.body.dataset.keyRequest='';document.body.dataset.keyDone='';}
function fits(){return document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight;}
function boxFits(id){const r=$(id).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}
function menuAction(label){const action=[...$('application-menu').querySelectorAll('button')].find(button=>button.querySelector('span')?.textContent===label);if(!action)throw new Error('Missing menu action: '+label);action.click();}
function frame(message){window.__appSocket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(message)}));}
async function sessionIds(){const response=await fetch('/api/sessions',{cache:'no-store'});return(await response.json()).sessions.map(session=>session.id);}
async function newTerminal(path,count,button='sidebar-new'){
  $(button).click();await until(()=>$('directory-dialog').open,'directory dialog');
  $('directory-path').value=path;$('directory-go').click();
  await until(()=>!$('directory-create').disabled,'directory ready');$('directory-create').click();
  await until(()=>$('tabs').querySelectorAll('.tab').length===count&&$('view-status').textContent==='Controlling','created terminal');
}
async function main(){
  for(const name of ['confirm','alert','prompt'])window[name]=()=>{throw new Error('Unexpected browser-native '+name);};
  await until(()=>$('connection-status').textContent==='Connected','connection');
  check(!$('welcome').hidden&&!$('sidebar-empty').hidden&&$('find').disabled,'welcome and empty-session actions');
  check(!$('sidebar-start')&&!$('sidebar-empty').querySelector('a,button'),'empty sidebar uses a quiet message without another New terminal link');
  await capture('welcome-desktop',1280);check(fits(),'desktop welcome fits');
  for(const [label,selector] of [['Title','.brand'],['Command center','#command-center'],['Sidebar heading','.sidebar-heading h2'],['Workspace path','#workspace-path'],['Welcome subtitle','.welcome-heading p'],['Welcome description','.welcome-start>p'],['Start action','#welcome-new'],['Keyboard hints','.welcome-shortcuts kbd'],['Sidebar footer','.sidebar-footer'],['Connection status','#connection-status']])contrast(label,document.querySelector(selector));
  // The reference uses quiet decorative panel/button borders. Focus and
  // input identification retain their measured high-contrast indicators.
  check(true,'welcome text, actions and status contrast measured');
  await capture('welcome-mobile',320);check(fits()&&boxFits('welcome-new'),'320px welcome fits and new terminal is reachable');
  $('activity-sessions').click();check($('activity-sessions').getAttribute('aria-expanded')==='true'&&boxFits('sidebar'),'mobile session sidebar opens');
  $('activity-sessions').click();
  await capture('welcome-desktop-restored',1280);
  $('command-center').click();await until(()=>$('command-dialog').open,'commands');
  $('command-input').value='new terminal';$('command-input').dispatchEvent(new Event('input',{bubbles:true}));
  eventKey($('command-input'),'Enter');check(!$('command-dialog').open&&$('directory-dialog').open,'command palette opens the working-directory picker');
  await until(()=>!$('directory-create').disabled,'initial directory loaded');
  check(!$('directory-path').value.startsWith('\\\\?\\')&&$('directory-breadcrumbs').lastElementChild.textContent==='sample-workspace','directory picker displays normal Windows paths and current-folder breadcrumbs');
  await capture('directory-desktop',1280);check(boxFits('directory-dialog'),'compact directory picker fits on desktop');
  contrast('Directory text',$('directory-path'));contrast('Directory input boundary',document.querySelector('.path-entry'),'borderLeftColor',3);contrast('Create button',$('directory-create'));contrast('Folder filter',$('directory-filter'),'color',4.5,'::placeholder');contrast('Filter input boundary',document.querySelector('.directory-filter'),'borderLeftColor',3);contrast('Folder row',document.querySelector('.directory-name'));contrast('Folder count',$('directory-message'));contrast('Folder help',$('directory-help'));
  $('directory-filter').value='src';$('directory-filter').dispatchEvent(new Event('input',{bubbles:true}));
  check($('directory-list').querySelectorAll('.directory-row').length===1&&$('directory-message').textContent==='1 / 8','folder filter searches actual directory names');
  let folder=$('directory-list').querySelector('.directory-row');folder.click();
  check(folder.getAttribute('aria-selected')==='true'&&$('directory-selected').textContent==='src'&&$('directory-path').value.endsWith('sample-workspace'),'single click selects a child folder without navigating');
  contrast('Selected folder',folder);folder.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  await until(()=>!$('directory-create').disabled&&$('directory-path').value.endsWith('\\src'),'double-click directory navigation');
  check($('directory-list').textContent.includes('No subfolders')&&$('directory-message').textContent==='0 folders','double-click opens a folder and empty folders stay selectable');
  $('directory-up').click();await until(()=>!$('directory-create').disabled&&$('directory-path').value===CWD,'parent navigation');
  $('directory-filter').value='long-project';$('directory-filter').dispatchEvent(new Event('input',{bubbles:true}));folder=$('directory-list').querySelector('.directory-row');folder.focus();eventKey(folder,'Enter');
  await until(()=>!$('directory-create').disabled&&$('directory-path').value===LONG,'keyboard folder navigation');
  const ancestor=[...$('directory-breadcrumbs').querySelectorAll('button')].find(button=>button.title===CWD);ancestor.click();
  await until(()=>!$('directory-create').disabled&&$('directory-path').value===CWD,'breadcrumb navigation');
  check(true,'Enter opens folders and breadcrumbs navigate to an actual ancestor');
  $('directory-list').querySelector('.directory-row').focus();eventKey(document.activeElement,'ArrowDown');
  check(document.activeElement.getAttribute('aria-selected')==='true'&&document.activeElement.classList.contains('directory-row'),'arrow keys move focus and selection through real folders');
  $('directory-filter').value='long-project';$('directory-filter').dispatchEvent(new Event('input',{bubbles:true}));$('directory-list').querySelector('.directory-row').click();
  await capture('directory-mobile',320);check(boxFits('directory-dialog')&&boxFits('directory-up')&&boxFits('directory-go')&&boxFits('directory-create'),'320px folder picker keeps navigation and selected-folder action reachable');
  $('directory-home').click();await until(()=>!$('directory-create').disabled&&$('directory-path').value===CWD,'starting folder navigation');
  check($('directory-selected').textContent==='sample-workspace','home action restores the starting folder');
  const realFetch=window.fetch;let releaseDelayed,delayedReady=false;
  window.fetch=async(url,options)=>{const response=await realFetch(url,options);if(String(url).includes('/api/directories?path=')&&decodeURIComponent(String(url).split('path=')[1])===LONG){delayedReady=true;await new Promise(resolve=>releaseDelayed=resolve);}return response;};
  $('directory-path').value=LONG;$('directory-go').click();await until(()=>delayedReady,'owned delayed directory response');
  const pendingPath=CWD+'\\typed-during-loading';$('directory-path').value=pendingPath;$('directory-path').dispatchEvent(new Event('input',{bubbles:true}));releaseDelayed();await pause(150);window.fetch=realFetch;
  check($('directory-path').value===pendingPath&&$('directory-create').disabled,'typing during a delayed directory request preserves the entered location and disables stale creation');
  $('directory-path').value=CWD+'\\missing-folder';$('directory-go').click();await until(()=>$('directory-message').classList.contains('error'),'directory error');
  check(!$('directory-error').hidden&&$('directory-create').disabled&&$('directory-path').value.endsWith('missing-folder'),'invalid location shows an inline error and preserves the entered path');
  contrast('Folder error',$('directory-error-text'));await capture('directory-error-mobile',320);check(boxFits('directory-dialog')&&boxFits('directory-error'),'folder errors fit at 320px');
  await pressEscape();check(!$('directory-dialog').open&&(await sessionIds()).length===0,'native Escape cancels directory selection without creating a session');
  await capture('welcome-after-folder-picker',1280);
  const fileMenu=document.querySelector('[data-menu="File"]');fileMenu.focus();eventKey(fileMenu,'ArrowDown');
  check(!$('application-menu').hidden&&document.activeElement.getAttribute('role')==='menuitem','application menus open from the keyboard and focus their first enabled action');
  menuAction('New terminal');await until(()=>$('directory-dialog').open,'File New terminal');$('directory-dialog').close();
  document.querySelector('[data-menu="View"]').click();await pressEscape();
  check($('application-menu').hidden&&document.activeElement.dataset.menu==='View','native Escape dismisses an application menu and restores focus');
  await newTerminal(CWD,1);
  await until(()=>$('terminal-lines').textContent.includes('Ready for input.'),'fixture output');
  check($('session-list').querySelectorAll('.session-entry').length===1&&$('status-session-count').textContent==='1 terminal','sidebar and status reflect the real session');
  const first=document.querySelector('.session-entry').dataset.session;
  await until(()=>window.__snapshotBodies[first].terminal.cols<140,'initial visible terminal geometry');
  const firstColumns=window.__snapshotBodies[first].terminal.cols;
  $('toggle-sidebar').click();
  await until(()=>window.__snapshotBodies[first].terminal.cols>firstColumns,'sidebar geometry');
  check($('toggle-sidebar').getAttribute('aria-expanded')==='false','hiding sidebar gives the controlling terminal more columns');
  $('toggle-sidebar').click();
  $('new').click();await until(()=>!$('directory-create').disabled,'selected child folder picker');
  check($('directory-path').value===CWD,'new terminal starts from the active session directory');
  $('directory-filter').value='long-project';$('directory-filter').dispatchEvent(new Event('input',{bubbles:true}));$('directory-list').querySelector('.directory-row').click();$('directory-create').click();
  await until(()=>$('tabs').querySelectorAll('.tab').length===2&&$('view-status').textContent==='Controlling','selected child native terminal');
  const selectedChild=(await(await fetch('/api/sessions',{cache:'no-store'})).json()).sessions.find(session=>session.id!==first);
  check(selectedChild.cwd.replace(/^\\\\\?\\/,'')===LONG,'Open terminal launches the selected child folder rather than its parent');
  const second=document.querySelector('.session-entry.active').dataset.session;
  check(first!==second,'two directories create independent session identities');
  $('previous-session').click();await until(()=>document.querySelector('.session-entry.active')?.dataset.session===first&&$('view-status').textContent==='Controlling','previous terminal');
  document.querySelector('[data-menu="Go"]').click();menuAction('Next terminal');await until(()=>document.querySelector('.session-entry.active')?.dataset.session===second&&$('view-status').textContent==='Controlling','Go Next terminal');
  check(true,'title navigation and Go menu switch actual terminal sessions');
  document.querySelector('[data-menu="Selection"]').click();menuAction('Select all terminal text');
  check(document.getSelection().toString().includes('Ready for input.'),'Selection menu selects the real terminal output');
  document.getSelection().removeAllRanges();$('terminal-scroll').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));$('keyboard').focus();
  $('activity-settings').click();await until(()=>$('preferences-dialog').open,'terminal settings');
  $('larger').click();check($('preferences-font').textContent==='15 px'&&$('status-font').textContent==='15 px','terminal settings change the actual terminal font');$('smaller').click();
  await capture('settings-desktop',1280);await pressEscape();check(!$('preferences-dialog').open,'native Escape dismisses settings');
  $('command-center').click();$('command-input').value=first;$('command-input').dispatchEvent(new Event('input',{bubbles:true}));
  eventKey($('command-input'),'Enter');await until(()=>$('view-status').textContent==='Controlling'&&document.querySelector('.session-entry.active')?.dataset.session===first,'palette switch');
  check(true,'command palette switches to a selected running session');
  document.querySelector('.tab.active').focus();eventKey(document.querySelector('.tab.active'),'ArrowRight');
  await until(()=>document.querySelector('.session-entry.active')?.dataset.session===second&&document.activeElement.classList.contains('tab')&&$('view-status').textContent==='Controlling','tab keyboard navigation');
  check(true,'arrow keys switch terminal tabs and preserve tab focus');
  const longTitle='A long terminal title '.repeat(8).trim();
  const transfer=new DataTransfer();transfer.setData('text/plain','title '+longTitle+'\r');
  $('keyboard').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  await until(()=>window.__snapshotBodies[second].terminal.title===longTitle,'native long terminal title');
  await capture('terminal-desktop',1280);check(fits()&&boxFits('new')&&boxFits('close-session'),'long session labels keep desktop terminal actions reachable');
  $('activity-find').click();$('find-input').value='local terminal';$('find-input').dispatchEvent(new Event('input',{bubbles:true}));
  check(!$('findbar').hidden&&$('find-count').textContent.includes('1'),'activity search finds live terminal output');
  $('command-center').focus();$('command-center').click();
  await capture('commands-desktop',1280);
  contrast('Command input',$('command-input'));contrast('Command placeholder',$('command-input'),'color',4.5,'::placeholder');contrast('Command focus boundary',$('command-input'),'borderLeftColor',3);contrast('Selected command',document.querySelector('.command-option.selected'));contrast('Selected command detail',document.querySelector('.command-option.selected small'));contrast('Command footer',document.querySelector('.command-footer'));contrast('Session detail',document.querySelector('.session-entry.active .session-directory'));contrast('Terminal hint',$('terminal-hint'));contrast('Find input',$('find-input'));contrast('Find boundary',$('find-input'),'borderLeftColor',3);contrast('Find count',$('find-count'));
  check(true,'session, command, directory, search and focus contrast measured');
  check(document.activeElement===$('command-input'),'command dialog focuses its search field');
  await pressEscape();
  check(!$('command-dialog').open&&!$('findbar').hidden&&document.activeElement===$('command-center'),'native Escape dismisses commands and restores focus without closing terminal search');
  $('find-close').click();
  await capture('terminal-mobile',390);check(fits()&&boxFits('new')&&boxFits('close-session'),'390px active terminal keeps essential actions reachable');
  await capture('terminal-small',320);check(fits()&&boxFits('close-session')&&boxFits('view-status')&&window.__snapshotBodies[second].terminal.cols<50,'320px terminal, native geometry and control status fit');
  $('editor-more').click();check(boxFits('application-menu')&&!$('application-menu').hidden,'terminal actions menu fits at 320px');menuAction('Terminal settings');
  check($('preferences-dialog').open&&boxFits('preferences-dialog'),'settings remain reachable at 320px');$('preferences-close').click();
  $('command-center').click();$('command-input').value='increase font';$('command-input').dispatchEvent(new Event('input',{bubbles:true}));
  eventKey($('command-input'),'Enter');check($('status-font').textContent==='15 px','font commands remain available on narrow screens');
  $('activity-sessions').click();await capture('sidebar-mobile',390);check(boxFits('sidebar'),'mobile sidebar fits with long session paths');
  document.querySelector('[data-session="'+first+'"]').click();await until(()=>$('view-status').textContent==='Controlling','mobile switch');
  check($('activity-sessions').getAttribute('aria-expanded')==='false','selecting a mobile session dismisses the sidebar');
  await capture('terminal-before-observer',1280);
  const peer=new WebSocket('ws://'+location.host+'/ws');await new Promise(resolve=>peer.addEventListener('open',resolve,{once:true}));
  peer.send(JSON.stringify({op:'attach',id:first,cols:80,rows:24}));await pause(100);
  peer.send(JSON.stringify({op:'claim',id:first,cols:80,rows:24}));await until(()=>$('view-status').textContent==='Observing','observer state');
  check(!$('take-control').hidden&&$('paste').disabled,'observer has a visible control action and disabled paste');
  const before=window.__wire.filter(m=>m.op==='resize').length;$('toggle-sidebar').click();await pause(200);
  check(window.__wire.filter(m=>m.op==='resize').length===before,'observer sidebar changes cannot resize a terminal');
  $('toggle-sidebar').click();$('take-control').click();await until(()=>$('view-status').textContent==='Controlling','control restored');peer.close();
  await capture('terminal-final',1280);
  $('close-session').click();await until(()=>$('notice-dialog').open,'close warning');
  check($('notice-heading').textContent==='Close terminal?'&&$('notice-description').textContent.includes('child processes')&&$('notice-details').textContent.includes(first)&&$('notice-details').textContent.includes(CWD)&&document.activeElement===$('notice-cancel'),'close warning identifies the live terminal, explains process termination and initially focuses Cancel');
  await capture('notice-close-desktop',1280);
  for(const [label,id] of [['Warning heading','notice-heading'],['Warning description','notice-description'],['Warning details','notice-details'],['Warning cancel','notice-cancel'],['Warning confirm','notice-confirm']])contrast(label,$(id));
  contrast('Warning focus boundary',$('notice-cancel'),'outlineColor',3);
  $('notice-cancel').click();check(!($('notice-dialog').open)&&(await sessionIds()).length===2,'Cancel leaves both native sessions running');
  $('close-session').click();await until(()=>$('notice-dialog').open,'close again');await pressEscape();
  check(!$('notice-dialog').open&&(await sessionIds()).length===2,'native Escape cancels terminal close');
  $('close-session').click();await capture('notice-close-mobile',320);check(boxFits('notice-dialog')&&boxFits('notice-confirm')&&boxFits('notice-cancel'),'terminal close warning and both actions fit at 320px');$('notice-dismiss').click();
  check(!$('notice-dialog').open&&(await sessionIds()).length===2,'warning close icon cancels the action');
  await capture('terminal-after-warning',1280);
  const clipboardWrites=[];let clipboardDenied=false;
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{if(clipboardDenied)throw new DOMException('Fixture denial','NotAllowedError');clipboardWrites.push(text);}}});
  const clipboard=data=>frame({type:'clipboard',id:first,data:btoa(data)});
  clipboard('Owned clipboard fixture');await until(()=>$('notice-dialog').open,'clipboard permission');
  check($('notice-heading').textContent==='Copy terminal text to the clipboard?'&&$('notice-description').textContent.includes('23 characters')&&clipboardWrites.length===0,'terminal clipboard requests require a styled permission notice before writing');
  $('notice-cancel').click();await pause(50);check(clipboardWrites.length===0,'denying terminal clipboard permission writes nothing');
  clipboard('First queued fixture');clipboard('Second queued fixture');
  await until(()=>$('notice-dialog').open,'queued clipboard');$('notice-confirm').click();
  await until(()=>clipboardWrites.length===1&&$('notice-dialog').open,'second queued notice');await pause(100);
  check(clipboardWrites[0]==='First queued fixture'&&$('notice-dialog').open,'queued notices keep the next request open after the previous dialog closes');
  $('notice-cancel').click();await pause(50);check(clipboardWrites.length===1,'each queued clipboard request needs its own decision');
  clipboardDenied=true;clipboard('Denied browser fixture');await until(()=>$('notice-dialog').open,'browser denial');$('notice-confirm').click();
  await until(()=>!$('toast').hidden&&$('toast').getAttribute('role')==='alert','error notification');
  check($('toast-message').textContent.includes('denied by the browser')&&$('toast').classList.contains('error'),'browser clipboard failures produce an accessible styled error');
  contrast('Error notification',$('toast-message'));await capture('notification-error-mobile',320);check(boxFits('toast')&&boxFits('toast-close'),'error notification fits and can be dismissed at 320px');
  await pause(6200);check(!$('toast').hidden,'errors remain available until dismissed');$('toast-close').click();check($('toast').hidden,'notification close dismisses the error');
  await capture('terminal-before-reconnect',1280);
  $('close-session').click();await until(()=>$('notice-dialog').open,'pending close before reconnect');window.__appSocket.close();
  await until(()=>$('connection-status').textContent==='Reconnecting…','disconnected during warning');
  await until(()=>$('connection-status').textContent==='Connected'&&$('view-status').textContent==='Controlling','reconnected during warning');$('notice-confirm').click();
  await until(()=>$('toast-message').textContent.includes('connection changed'),'stale confirmation warning');
  check((await sessionIds()).length===2,'a confirmation from an earlier connection cannot close a session');$('toast-close').click();
  document.querySelector('[data-session="'+second+'"]').click();await until(()=>$('view-status').textContent==='Controlling','surviving session active');
  $('tabs').querySelector('.tab[data-session="'+first+'"]').querySelector('.tab-close').click();await until(()=>$('notice-dialog').open,'inactive live close');
  check($('notice-details').textContent.includes(first)&&document.querySelector('.session-entry.active').dataset.session===second,'closing an inactive tab identifies that target and retains the current terminal');$('notice-confirm').click();
  await until(async()=>!(await sessionIds()).includes(first)&&$('tabs').querySelectorAll('.tab').length===1&&$('view-status').textContent==='Controlling','confirmed native close');
  check((await sessionIds()).includes(second)&&document.querySelector('.session-entry.active').dataset.session===second,'confirmed live close ends only its target and retains the surviving native session');
  check(window.__probeErrors.length===0,'no browser runtime errors');
  const bytes=new TextEncoder().encode(JSON.stringify({pass:true,results,contrasts}));document.body.dataset.probeResult=btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));
}
main().catch(error=>{const bytes=new TextEncoder().encode(JSON.stringify({pass:false,results,error:String(error),errors:window.__probeErrors,state:{commands:$('command-dialog').open,find:$('findbar').hidden,focus:document.activeElement.id}}));document.body.dataset.probeResult=btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));});
`;

let child,proxy;
const port=await freePort();
const environment={};
for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP']) if(process.env[key]) environment[key]=process.env[key];
try{
  child=spawn(executable,['--port',String(port),'--cwd',cwd,'--shell',`cmd.exe /d /q /k "${script}"`],{cwd,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);
  await ready(port,child);
  proxy=await proxyFor(port,harness.replace('__CWD__',JSON.stringify(cwd)).replace('__LONG__',JSON.stringify(longDirectory)));
  let lastCapture='';
  const report=await chromeProbe(await findChrome(),'http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome'),'workbenchStage',async({protocol,evaluate})=>{
    const key=await evaluate('document.body?.dataset.keyRequest||""');
    if(key){await protocol('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await protocol('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await evaluate('document.body.dataset.keyDone="Escape"');}
    const capture=await evaluate('document.body?.dataset.capture||""');if(!capture||capture===lastCapture)return;
    lastCapture=capture;
    const {name,width}=JSON.parse(capture);
    await protocol('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await evaluate('new Promise(resolve=>setTimeout(resolve,180))');
    const screenshot=await protocol('Page.captureScreenshot',{format:'png'});
    await writeFile(resolve(screenshots,name+'.png'),Buffer.from(screenshot.data,'base64'));
    await evaluate('document.body.dataset.captured='+JSON.stringify(name));
  });
  for(const result of report.results) console.log('PASS '+result);
  if(!report.pass) console.error(report.error,report.errors,report.state,output);
  assert.equal(report.pass,true,'Workbench browser acceptance failed');
  assert.equal(proxy.stats.upstreamErrors,0,'Product assets failed to load');
  await writeFile(resolve(screenshots,'verification.json'),JSON.stringify(report,null,2));
  console.log('Contrast ratios: '+JSON.stringify(report.contrasts));
  console.log('Screenshots: '+screenshots);
}finally{
  await stopProxy(proxy);await stopChild(child);
  await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
