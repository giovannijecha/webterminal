// Original two-group browser acceptance with an owned, repeatable ConPTY child.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile, mkdir, rm, writeFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeProbe, findChrome, freePort, proxyFor, quote, ready, stopChild, stopProxy} from './cli-browser-support.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const target=resolve(root,'target');
const binaries=resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(target,'powershell-build/debug'));
const runRoot=resolve(target,`workspace-browser-${process.pid}-${Date.now()}`);
assert.ok(runRoot.startsWith(target+sep));
const cwd=resolve(runRoot,'work');
const screenshots=resolve(target,`workspace-preview-${process.pid}-${Date.now()}`);

const harness=String.raw`
const CWD=__CWD__;
const $=id=>document.getElementById(id);
const results=JSON.parse(sessionStorage.getItem('workspaceProbeResults')||'[]');
const contrasts=JSON.parse(sessionStorage.getItem('workspaceProbeContrasts')||'[]');
const pause=ms=>fetch('/probe-pause?ms='+ms,{cache:'no-store'});
async function until(test,label){for(let i=0;i<300;i++){const value=await test();if(value)return value;await pause(50);}throw new Error('Timed out: '+label);}
function check(value,label){if(!value)throw new Error(label);results.push(label);}
function rgba(value){const numbers=value.match(/[\d.]+/g).map(Number);return [...numbers.slice(0,3),numbers[3]??1];}
function background(element){
  const color=rgba(getComputedStyle(element).backgroundColor);
  if(color[3]===1)return color.slice(0,3);
  const parent=element.parentElement?background(element.parentElement):[30,30,30];
  return color.slice(0,3).map((channel,index)=>channel*color[3]+parent[index]*(1-color[3]));
}
function luminance(color){return color.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,index)=>sum+v*[.2126,.7152,.0722][index],0);}
function contrast(label,element,property='color',minimum=4.5){
  const foreground=luminance(rgba(getComputedStyle(element)[property]).slice(0,3));
  const edge=property.startsWith('border')||property.startsWith('outline');
  const backgrounds=edge?[background(element),background(element.parentElement)]:[background(element)];
  const ratio=Math.min(...backgrounds.map(color=>{const base=luminance(color);return(Math.max(foreground,base)+.05)/(Math.min(foreground,base)+.05);}));
  contrasts.push({label,ratio:+ratio.toFixed(2),minimum});
  if(ratio<minimum)throw new Error(label+' contrast '+ratio.toFixed(2)+' below '+minimum);
}
function group(number){return document.querySelector('.editor-group[data-group="'+number+'"]');}
function tabs(number){return [...group(number).querySelectorAll('.tabs .tab')];}
function tab(number,id){return tabs(number).find(item=>item.dataset.session===id);}
function active(number){return tabs(number).find(item=>item.classList.contains('active'))?.dataset.session;}
function lines(number){return $(number===1?'terminal-lines':'secondary-terminal-lines');}
function keyboard(number){return $(number===1?'keyboard':'secondary-keyboard');}
function text(number){return lines(number)?.textContent||'';}
function fits(){return document.documentElement.scrollWidth<=innerWidth+1;}
function boxFits(element){const r=element.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}
async function sessions(){const response=await fetch('/api/sessions',{cache:'no-store'});if(!response.ok)throw new Error('Sessions HTTP '+response.status);return(await response.json()).sessions;}
function ids(){return sessions().then(items=>items.map(item=>item.id));}
async function viewport(width){document.body.dataset.viewportRequest=String(width);await until(()=>document.body.dataset.viewportDone===String(width),'viewport '+width);}
async function capture(name){document.body.dataset.capture=name;await until(()=>document.body.dataset.captured===name,'capture '+name);}
function paste(number,value){
  const input=keyboard(number);input.focus();
  const transfer=new DataTransfer();transfer.setData('text/plain',value);
  input.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
}
async function probe(number,tag){
  await until(()=>group(number)?.dataset.status==='Controlling','group '+number+' ready for '+tag);
  paste(number,'probe:'+tag+'\r');
  await until(()=>text(number).includes('ACK:'+tag),'ACK '+tag+' in group '+number);
}
async function create(count){
  $('new').click();await until(()=>$('directory-dialog').open,'directory dialog '+count);
  $('directory-path').value=CWD;$('directory-go').click();
  await until(()=>!$('directory-create').disabled,'directory selected '+count);
  $('directory-create').click();
  await until(async()=>(await sessions()).length===count,'session '+count);
  await until(()=>text(1).includes('PERF_READY'),'fixture '+count);
}
function drag(source,target){
  const transfer=new DataTransfer();
  source.dispatchEvent(new DragEvent('dragstart',{dataTransfer:transfer,bubbles:true,cancelable:true}));
  target.dispatchEvent(new DragEvent('dragover',{dataTransfer:transfer,bubbles:true,cancelable:true}));
  target.dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));
  source.dispatchEvent(new DragEvent('dragend',{dataTransfer:transfer,bubbles:true,cancelable:true}));
}
async function observer(id){
  const ws=new WebSocket('ws://'+location.host+'/ws');const messages=[];
  ws.addEventListener('message',event=>{try{messages.push(JSON.parse(event.data));}catch{}});
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.send(JSON.stringify({op:'attach',id,cols:80,rows:24}));
  const snapshot=await until(()=>messages.find(message=>message.type==='snapshot'&&message.id===id),'observer snapshot');
  const hello=await until(()=>messages.find(message=>message.type==='hello'),'observer hello');
  return {ws,messages,snapshot,hello};
}
async function keyboardReorder(){
  const original=tabs(2).map(item=>item.dataset.session);
  const moved=original[0];
  tab(2,moved).focus();
  tab(2,moved).dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
  await until(()=>tabs(2).map(item=>item.dataset.session).join(',')===[original[1],moved].join(','),'keyboard reorder right');
  check(document.activeElement?.dataset.session===moved,'keyboard reorder retains tab focus after first move');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
  await until(()=>tabs(2).map(item=>item.dataset.session).join(',')===original.join(','),'keyboard reorder left');
  check(document.activeElement?.dataset.session===moved,'repeated keyboard reorder retains tab focus');
}
async function queuedFocusSwitch(){
  await until(()=>group(1).dataset.status==='Controlling'&&group(2).dataset.status==='Controlling','both groups control before queued input');
  const socket=window.__appSocket;
  Object.defineProperty(socket,'bufferedAmount',{configurable:true,get:()=>128*1024});
  try{paste(1,'probe:QUEUEDLEFT\r');keyboard(2).focus();}
  finally{delete socket.bufferedAmount;}
  await until(()=>text(1).includes('ACK:QUEUEDLEFT'),'queued left input after focus moved right');
  check(true,'focus switch preserves queued input in the other group');
}
function projectedLine(line){return(line?.cells||[]).filter(cell=>cell[1]!==0).map(cell=>cell[0]||' ').join('');}
async function wrappedCopy(id){
  const marker='WRAPPED-COPY-'+'q'.repeat(72);
  await probe(2,marker);
  const peer=await observer(id);
  const model=[...peer.snapshot.terminal.history,...peer.snapshot.terminal.screen];
  const start=model.findIndex(line=>projectedLine(line).includes('ACK:WRAPPED-COPY-'));
  check(start>=0&&model[start].wrapped===true,'Rust terminal projects secondary output as soft-wrapped rows');
  const rows=[...lines(2).querySelectorAll('.term-line')];
  const first=rows.find(row=>Number(row.dataset.index)===start);
  const second=rows.find(row=>Number(row.dataset.index)===start+1);
  const firstNode=first?.querySelector('.term-cell')?.firstChild;
  const lastNode=second?.querySelector('.term-cell:last-child')?.firstChild;
  if(!firstNode||!lastNode)throw new Error('Secondary soft-wrapped selection nodes missing');
  const range=document.createRange();range.setStart(firstNode,0);range.setEnd(lastNode,lastNode.textContent.length);
  const selection=document.getSelection();selection.removeAllRanges();selection.addRange(range);
  const transfer=new DataTransfer();
  document.dispatchEvent(new ClipboardEvent('copy',{clipboardData:transfer,bubbles:true,cancelable:true}));
  const copied=transfer.getData('text/plain');
  const expected=projectedLine(model[start])+projectedLine(model[start+1]);
  check(copied===expected&&!copied.includes('\n'),'copy from secondary pane joins soft wrap exactly as Rust projection');
  selection.removeAllRanges();peer.ws.close();
}
function save(ids){sessionStorage.setItem('workspaceProbeIds',JSON.stringify(ids));sessionStorage.setItem('workspaceProbeResults',JSON.stringify(results));sessionStorage.setItem('workspaceProbeContrasts',JSON.stringify(contrasts));sessionStorage.setItem('workspaceProbeStage','restored');}
function publish(report){const bytes=new TextEncoder().encode(JSON.stringify(report));document.body.dataset.probeResult=btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));}
async function firstPass(){
  await until(()=>$('connection-status').textContent==='Connected','connection');
  check((await sessions()).length===0,'fresh server has no sessions');
  await create(1);const a=(await ids())[0];
  await create(2);const b=(await ids())[1];
  check(tabs(1).map(item=>item.dataset.session).join(',')===[a,b].join(','),'two original tabs share first group');

  tab(1,b).focus();tab(1,b).dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true,cancelable:true}));
  await until(()=>$('rename-dialog')?.open,'rename dialog');
  await until(()=>document.activeElement===$('rename-input'),'rename input focus');
  await viewport(1280);
  const dialog=$('rename-dialog'),input=$('rename-input');
  contrast('Rename heading', $('rename-heading'));
  contrast('Rename label',dialog.querySelector('label[for="rename-input"]'));
  contrast('Rename input text',input);
  contrast('Rename help',$('rename-help'));
  contrast('Rename Save text',$('rename-save'));
  contrast('Rename Cancel text',dialog.querySelector('.dialog-actions .subtle-button'));
  contrast('Rename input border',input,'borderLeftColor',3);
  check(getComputedStyle(input).outlineStyle!=='none','rename input exposes a focus outline');
  contrast('Rename input focus outline',input,'outlineColor',3);
  await capture('rename-desktop');
  const invalid='X'.repeat(81);
  input.value=invalid;input.dispatchEvent(new Event('input',{bubbles:true}));$('rename-save').click();
  await until(()=>dialog.open&&!$('rename-error').hidden,'rename validation error');
  check(input.value===invalid&&$('rename-error').textContent.includes('80'),'overlong name stays in dialog with inline error');
  check((await sessions()).find(item=>item.id===b)?.name===null,'invalid rename leaves server name unchanged');
  contrast('Rename inline error',$('rename-error'));
  await viewport(320);
  check([dialog,input,$('rename-save'),dialog.querySelector('.dialog-actions .subtle-button')].every(boxFits),'rename dialog actions fit at 320px');
  await capture('rename-mobile');
  await viewport(1280);
  $('rename-input').value='Research terminal';$('rename-input').dispatchEvent(new Event('input',{bubbles:true}));$('rename-save').click();
  await until(async()=>(await sessions()).find(item=>item.id===b)?.name==='Research terminal','server session name');
  await until(()=>tab(1,b)?.textContent.includes('Research terminal')&&document.querySelector('.session-entry[data-session="'+b+'"]')?.textContent.includes('Research terminal'),'renamed tab and sidebar');
  check(tab(1,b)?.textContent.includes('Research terminal')&&document.querySelector('.session-entry[data-session="'+b+'"]').textContent.includes('Research terminal'),'rename reaches tab and sidebar');

  drag(tab(1,b),tab(1,a));
  await until(async()=>(await ids()).join(',')===[b,a].join(','),'global server reorder');
  await until(()=>tabs(1).map(item=>item.dataset.session).join(',')===[b,a].join(','),'tab reorder');
  check(tabs(1).map(item=>item.dataset.session).join(',')===[b,a].join(','),'tab order follows global reorder');
  tab(1,b).click();$('split-terminal').click();
  await until(()=>group(1)&&group(2)&&!group(2).hidden&&tabs(2).length===1,'split groups');
  check(active(1)===b&&active(2)===a,'split keeps active and moves other terminal');
  check(text(1).includes('PERF_READY')&&text(2).includes('PERF_READY'),'both native terminals render at once');
  check(document.querySelector('.session-group[data-group="1"] .session-entry[data-session="'+b+'"]')&&document.querySelector('.session-group[data-group="2"] .session-entry[data-session="'+a+'"]'),'sidebar reflects both groups');
  for(const heading of document.querySelectorAll('.session-group-heading'))contrast('Sidebar '+heading.textContent.trim()+' heading',heading);
  check(true,'new group and rename component contrast measured');

  tab(1,b).click();await create(3);const c=(await ids()).find(id=>id!==a&&id!==b);
  check(!!tab(1,c)&&active(1)===c,'new terminal belongs to focused group');
  await until(()=>text(2).includes('PERF_READY'),'second terminal stays rendered');
  await Promise.all([probe(1,'LEFT-1'),probe(2,'RIGHT-1')]);
  check(!text(1).includes('ACK:RIGHT-1')&&!text(2).includes('ACK:LEFT-1'),'simultaneous pane input stays in its session');

  drag(tab(1,c),tab(2,a));
  await until(()=>!!tab(2,c)&&!tab(1,c),'drag moves session between groups');
  check(active(1)===b&&tabs(2).length===2,'both groups remain populated after move');
  check(document.querySelector('.session-group[data-group="2"] .session-entry[data-session="'+c+'"]'),'sidebar updates moved session');

  tab(2,a).focus();tab(2,a).dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  await until(()=>active(2)===c,'keyboard tab navigation in second group');
  check(document.activeElement.closest('.editor-group')===group(2),'keyboard focus remains in second group');
  await probe(1,'LEFT-2');await probe(2,'RIGHT-2');

  check(!!sessionStorage.getItem('webterminal.layout')&&localStorage.getItem('webterminal.layout')===null,'layout is saved in this browser tab');
  save({a,b,c,serverOrder:await ids(),active1:active(1),active2:active(2)});
  location.reload();
}
async function secondPass(){
  const {a,b,c,serverOrder,active1,active2}=JSON.parse(sessionStorage.getItem('workspaceProbeIds'));
  await until(()=>$('connection-status').textContent==='Connected'&&group(2)&&!group(2).hidden,'reconnected split workspace');
  await until(()=>!!tab(1,b)&&!!tab(2,a)&&!!tab(2,c),'restored group membership');
  check(tabs(1).length===1&&tabs(2).length===2,'tab-local two-group layout survives reload');
  check(active(1)===active1&&active(2)===active2,'active tabs survive reload in each group');
  check((await ids()).join(',')===serverOrder.join(','),'global server order survives reload');
  check((await sessions()).find(item=>item.id===b)?.name==='Research terminal','server name survives reload');
  await until(()=>text(1).includes('ACK:LEFT-2')&&text(2).includes('ACK:RIGHT-2'),'both terminal snapshots restored');
  await viewport(1280);await capture('workspace-desktop');check(fits(),'split workspace fits at 1280px');
  const focusId=active(2);const resizeBefore=Object.fromEntries([b,focusId].map(id=>[id,window.__wire.filter(item=>item.op==='resize'&&item.id===id).length]));
  await viewport(320);
  await until(()=>[b,focusId].every(id=>window.__wire.filter(item=>item.op==='resize'&&item.id===id).length>resizeBefore[id]),'both active terminal geometries resize');
  await until(()=>Number($('terminal-size').textContent.match(/^\d+/)?.[0])<50,'mobile terminal geometry');
  check(true,'both visible groups resize their native terminal geometry');
  await capture('workspace-mobile');check(fits(),'split workspace fits at 320px');
  await viewport(1280);
  await until(()=>Number($('terminal-size').textContent.match(/^\d+/)?.[0])>=50,'desktop terminal geometry restored');
  await capture('workspace-desktop-restored');

  const attachBefore=Object.fromEntries([b,focusId].map(id=>[id,window.__wire.filter(item=>item.op==='attach'&&item.id===id).length]));
  window.__appSocket.close();
  await until(()=>[b,focusId].every(id=>window.__wire.filter(item=>item.op==='attach'&&item.id===id).length>attachBefore[id]),'both group attachments reconnect');
  await until(()=>$('connection-status').textContent==='Connected','connection restored');
  await probe(1,'LEFT-RECONNECT');await probe(2,'RIGHT-RECONNECT');
  check(true,'both panes reattach and accept input after WebSocket reconnect');

  tab(1,b).click();const peer=await observer(b);
  check(peer.snapshot.controller!==peer.hello.view,'second WebSocket initially observes');
  peer.ws.send(JSON.stringify({op:'claim',id:b,cols:80,rows:24}));
  await until(()=>$('view-status').textContent==='Observing','first group lost control');
  await probe(2,'RIGHT-OBSERVER');
  check(text(2).includes('ACK:RIGHT-OBSERVER'),'second group retains input while first is observed');
  tab(1,b).click();$('take-control').click();
  await until(()=>$('view-status').textContent==='Controlling','first group takes back control');
  peer.ws.close();await probe(1,'LEFT-RESTORED');

  await keyboardReorder();
  await queuedFocusSwitch();
  await wrappedCopy(c);

  tab(2,c).click();tab(2,c).querySelector('.tab-close').click();
  await until(()=>$('notice-dialog').open,'close confirmation for moved terminal');
  check($('notice-details').textContent.includes(c),'close confirmation names selected session');
  $('notice-confirm').click();
  await until(async()=>!(await ids()).includes(c),'moved session closed');
  check((await ids()).includes(a)&&(await ids()).includes(b),'closing one group tab keeps other sessions');
  await probe(1,'LEFT-SURVIVES');await probe(2,'RIGHT-SURVIVES');
  $('editor-more').click();
  const single=[...$('application-menu').querySelectorAll('button')].find(button=>button.querySelector('span')?.textContent==='Single group layout');
  if(!single)throw new Error('Single group layout action missing');
  single.click();
  await until(()=>group(2).hidden&&tabs(1).length===2,'single group layout');
  check((await sessions()).length===2&&(await sessions()).every(session=>session.alive),'single group layout retains both native sessions');
  tab(1,b).click();await probe(1,'SINGLE-LIVE');
  check(window.__probeErrors.length===0,'no browser runtime errors');
  sessionStorage.removeItem('workspaceProbeIds');sessionStorage.removeItem('workspaceProbeResults');sessionStorage.removeItem('workspaceProbeContrasts');sessionStorage.removeItem('workspaceProbeStage');
  publish({pass:true,results,contrasts,sessions:await ids(),screenshots:['rename-desktop.png','rename-mobile.png','workspace-desktop.png','workspace-mobile.png']});
}
try{if(sessionStorage.getItem('workspaceProbeStage')==='restored')await secondPass();else await firstPass();}
catch(error){publish({pass:false,results,contrasts,error:String(error?.stack||error),errors:window.__probeErrors,state:{groups:[1,2].map(number=>({number,ids:group(number)?tabs(number).map(item=>item.dataset.session):[],active:group(number)?active(number):null,status:group(number)?.dataset.status,text:text(number).trim().slice(0,300)})),connection:$('connection-status')?.textContent,viewStatus:$('view-status')?.textContent,toast:$('toast-message')?.textContent,wire:window.__wire?.slice(-20),layout:sessionStorage.getItem('webterminal.layout')}});}
`;

let child,proxy;
try{
  await mkdir(cwd,{recursive:true});
  await mkdir(resolve(runRoot,'profile','AppData','Roaming'),{recursive:true});
  await mkdir(resolve(runRoot,'profile','AppData','Local'),{recursive:true});
  await mkdir(resolve(runRoot,'profile','Temp'),{recursive:true});
  await mkdir(screenshots,{recursive:true});
  await copyFile(resolve(binaries,'webterminal.exe'),resolve(runRoot,'webterminal.exe'));
  await copyFile(resolve(binaries,'perf_fixture.exe'),resolve(runRoot,'perf_fixture.exe'));
  const port=await freePort();
  const profile=resolve(runRoot,'profile');
  const environment={};
  for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','ComSpec'])if(process.env[key])environment[key]=process.env[key];
  Object.assign(environment,{USERPROFILE:profile,HOME:profile,APPDATA:resolve(profile,'AppData','Roaming'),LOCALAPPDATA:resolve(profile,'AppData','Local'),TEMP:resolve(profile,'Temp'),TMP:resolve(profile,'Temp')});
  child=spawn(resolve(runRoot,'webterminal.exe'),['--port',String(port),'--cwd',cwd,'--shell',quote(resolve(runRoot,'perf_fixture.exe'))],{cwd,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>output+=part);
  await ready(port,child);
  proxy=await proxyFor(port,harness.replace('__CWD__',JSON.stringify(cwd)));
  let lastCapture='';
  const report=await chromeProbe(await findChrome(),'http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome'),'workspaceProbeStage',async({protocol,evaluate})=>{
    const width=await evaluate('document.body?.dataset.viewportRequest||""');
    const settled=await evaluate('document.body?.dataset.viewportDone||""');
    if(width&&width!==settled){
      await protocol('Emulation.setDeviceMetricsOverride',{width:Number(width),height:800,deviceScaleFactor:1,mobile:false});
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await evaluate('document.body.dataset.viewportDone='+JSON.stringify(width));
    }
    const name=await evaluate('document.body?.dataset.capture||""');
    if(name&&name!==lastCapture){
      lastCapture=name;
      await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const screenshot=await protocol('Page.captureScreenshot',{format:'png'});
      await writeFile(resolve(screenshots,name+'.png'),Buffer.from(screenshot.data,'base64'));
      await evaluate('document.body.dataset.captured='+JSON.stringify(name));
    }
  });
  for(const result of report.results)console.log('PASS '+result);
  if(!report.pass)console.error(report.error,report.errors,report.state,output);
  assert.equal(report.pass,true,'Workspace browser acceptance failed');
  assert.equal(proxy.stats.upstreamErrors,0,'Product assets failed to load');
  await writeFile(resolve(screenshots,'verification.json'),JSON.stringify(report,null,2));
  console.log('Contrast ratios: '+JSON.stringify(report.contrasts));
  console.log('Screenshots: '+screenshots);
}finally{await stopProxy(proxy);await stopChild(child);await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
