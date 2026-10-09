// Browser acceptance for server-owned workspace tabs and four live panes.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile, mkdir, rm, writeFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeProbe, findChrome, freePort, proxyFor, quote, ready, stopChild, stopProxy} from './cli-browser-support.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const scratch=resolve(root,'.tmp'), runRoot=resolve(scratch,`workspace-${process.pid}-${Date.now()}`);
assert.ok(runRoot.startsWith(scratch+sep));
const cwd=resolve(runRoot,'work'), screenshots=resolve(scratch,'browser-qa-workspace');
const binaries=resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(root,'target/debug'));

const harness=String.raw`
const $=id=>document.getElementById(id);
const checks=JSON.parse(sessionStorage.getItem('workspaceChecks')||'[]');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,label){for(let i=0;i<300;i++){const value=await test();if(value)return value;await pause(50);}throw new Error('Timed out: '+label);}
function check(value,label){if(!value)throw new Error(label);checks.push(label);}
function pane(index){return $(index===1?'pane':'pane'+index+'-pane');}
function input(index){return $(index===1?'keyboard':'pane'+index+'-keyboard');}
function lines(index){return $(index===1?'terminal-lines':'pane'+index+'-terminal-lines');}
async function listing(){return await(await fetch('/api/sessions',{cache:'no-store'})).json();}
function active(){return document.querySelector('.workspace-tab.active');}
function tab(id){return document.querySelector('.workspace-tab[data-workspace="'+id+'"]');}
async function capture(name,width){document.body.dataset.viewportRequest=String(width);await until(()=>document.body.dataset.viewportDone===String(width),'viewport '+width);document.body.dataset.capture=name;await until(()=>document.body.dataset.captured===name,'capture '+name);}
function fits(element){const r=element.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.top>=0&&r.bottom<=innerHeight+1;}
function paste(index,value){const transfer=new DataTransfer();transfer.setData('text/plain',value);input(index).focus();input(index).dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));}
async function create(count){$('new').click();await until(()=>$('directory-dialog').open&&!$('directory-create').disabled,'folder picker');$('directory-create').click();await until(async()=>(await listing()).sessions.length===count,'session '+count);await until(()=>pane(count).dataset.status==='Controlling'&&lines(count).textContent.includes('PERF_READY'),'pane '+count);}
async function probe(index,tag){paste(index,'probe:'+tag+'\r');await until(()=>lines(index).textContent.includes('ACK:'+tag),'ACK '+tag);}
function drag(source,target){const dataTransfer=new DataTransfer();source.dispatchEvent(new DragEvent('dragstart',{dataTransfer,bubbles:true,cancelable:true}));target.dispatchEvent(new DragEvent('dragover',{dataTransfer,bubbles:true,cancelable:true}));target.dispatchEvent(new DragEvent('drop',{dataTransfer,bubbles:true,cancelable:true}));source.dispatchEvent(new DragEvent('dragend',{dataTransfer,bubbles:true,cancelable:true}));}
async function observer(id){
  const ws=new WebSocket('ws://'+location.host+'/ws'),messages=[];
  ws.addEventListener('message',event=>messages.push(JSON.parse(event.data)));
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.send(JSON.stringify({op:'attach',id,cols:80,rows:24}));
  const snapshot=await until(()=>messages.find(message=>message.type==='snapshot'&&message.id===id),'observer snapshot');
  return {ws,messages,snapshot};
}
function publish(report){document.body.dataset.probeResult=btoa(unescape(encodeURIComponent(JSON.stringify(report))));}
async function main(){
  await until(()=>$('connection-status').textContent==='Connected'&&active(),'initial connection');
  if(sessionStorage.getItem('workspaceStage')==='reloaded'){
    const ids=JSON.parse(sessionStorage.getItem('workspaceIds'));
    const data=await listing();
    check(data.workspaces.length===2&&data.workspaces[0].sessions.length===3&&data.workspaces[1].sessions.length===1,'reload restores Rust workspace membership');
    check(data.workspaces[1].sessions[0]===ids[3],'moved terminal retains identity');
    tab(data.workspaces[0].id).click();
    await until(()=>pane(1).dataset.status==='Controlling'&&lines(1).textContent.includes('PERF_READY'),'first workspace after reload');
    await probe(1,'RELOADED');
    await capture('workspace-mobile',390);
    check(!$('pane-switcher').hidden&&$('pane-switcher').querySelectorAll('.switcher-item').length===3,'narrow layout lists three terminal panes');
    $('pane-switcher').querySelectorAll('.switcher-item')[1].click();
    await until(()=>pane(2).dataset.status==='Controlling'&&!pane(2).hidden&&pane(1).hidden,'narrow switcher selects second terminal');
    await probe(2,'MOBILE');
    check(fits($('new'))&&fits($('pane2-close-session')),'mobile terminal controls fit');
    await capture('workspace-mobile-selected',390);
    await capture('workspace-desktop-restored',1280);
    check(window.__probeErrors.length===0,'no browser exceptions or invalid updates');
    publish({pass:true,checks,sessions:data.sessions.map(item=>item.id),errors:window.__probeErrors});return;
  }
  check((await listing()).sessions.length===0&&!$('empty-state').hidden,'fresh workspace has an empty state');
  const initial=(await listing()).workspaces[0].id;
  for(let count=1;count<=4;count++)await create(count);
  const original=await listing(), ids=original.workspaces[0].sessions;
  check(ids.length===4&&new Set(ids).size===4&&$('panes').dataset.count==='4','four independent sessions render in one workspace');
  check([1,2,3,4].every(index=>!pane(index).hidden&&pane(index).dataset.status==='Controlling'),'all four panes control their own terminals');
  await Promise.all([probe(1,'ONE'),probe(4,'FOUR')]);
  check(!lines(1).textContent.includes('ACK:FOUR')&&!lines(4).textContent.includes('ACK:ONE'),'simultaneous pane input stays isolated');
  const peer=await observer(ids[0]);
  peer.ws.send(JSON.stringify({op:'claim',id:ids[0],cols:80,rows:24}));
  await until(()=>pane(1).dataset.status==='Observing','observer takes first pane');
  await probe(4,'OTHER-STILL-CONTROLS');
  $('take-control').click();await until(()=>pane(1).dataset.status==='Controlling','first pane takes control back');
  peer.ws.close();
  const previousSocket=window.__appSocket;previousSocket.close();
  await until(()=>window.__appSocket!==previousSocket&&[1,2,3,4].every(index=>pane(index).dataset.status==='Controlling'),'all four panes reconnect');
  await Promise.all([probe(1,'RECONNECTED-ONE'),probe(4,'RECONNECTED-FOUR')]);
  check(true,'each visible pane restores input after WebSocket reconnect');
  check($('new').getAttribute('aria-disabled')==='true','fifth terminal is unavailable in a full workspace');
  $('new').click();check(!$('directory-dialog').open,'full workspace does not open the picker');
  $('terminal-title').click();const rename=$('pane-header').querySelector('.inline-edit');
  check(rename&&document.activeElement===rename,'terminal rename focuses an inline editor');
  rename.value='Research';rename.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await until(async()=> (await listing()).sessions[0].name==='Research','terminal name persisted');
  const before=ids.join(',');drag($('pane4-pane-header'),pane(2));
  await until(async()=> (await listing()).workspaces[0].sessions.join(',')!==before,'pane order persisted');
  check((await listing()).workspaces[0].sessions.length===4,'pane reorder preserves all terminals');
  await capture('workspace-four-panes',1280);
  check([1,2,3,4].every(index=>fits(pane(index))),'four-pane layout fits desktop');
  $('new-workspace').click();await until(async()=> (await listing()).workspaces.length===2,'second workspace');
  const second=(await listing()).workspaces[1].id;
  check(active().dataset.workspace===second&&!$('empty-state').hidden,'new workspace is empty and selected');
  active().dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  const name=active().querySelector('.inline-edit');check(name&&document.activeElement===name,'workspace rename uses inline editor');
  name.value='Review';name.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
  await until(async()=> (await listing()).workspaces[1].name==='Review','workspace name persisted');
  tab(initial).click();await until(()=>pane(4).dataset.status==='Controlling','first workspace restored');
  const moved=(await listing()).workspaces[0].sessions[3];drag($('pane4-pane-header'),tab(second));
  await until(async()=> (await listing()).workspaces[1].sessions[0]===moved,'drag moved terminal between Rust workspaces');
  check((await listing()).workspaces[0].sessions.length===3,'source workspace released one pane');
  tab(second).click();await until(()=>pane(1).dataset.status==='Controlling'&&lines(1).textContent.includes('PERF_READY'),'moved terminal attached in destination');
  await probe(1,'MOVED');await capture('workspace-moved',1280);
  sessionStorage.setItem('workspaceIds',JSON.stringify([...ids.slice(0,3),moved]));
  sessionStorage.setItem('workspaceChecks',JSON.stringify(checks));sessionStorage.setItem('workspaceStage','reloaded');location.reload();
}
main().catch(error=>publish({pass:false,checks,error:String(error?.stack||error),errors:window.__probeErrors,state:{workspace:active()?.dataset.workspace,panes:[1,2,3,4].map(index=>({status:pane(index)?.dataset.status,text:lines(index)?.textContent.slice(0,80)})),toast:$('toast-message')?.textContent}}));
`;

await mkdir(cwd,{recursive:true});await mkdir(screenshots,{recursive:true});
await copyFile(resolve(binaries,'webterminal.exe'),resolve(runRoot,'webterminal.exe'));
await copyFile(resolve(binaries,'perf_fixture.exe'),resolve(runRoot,'perf_fixture.exe'));
let child,proxy,lastCapture='';
try{
  const port=await freePort(),env={};
  for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  child=spawn(resolve(runRoot,'webterminal.exe'),['--port',String(port),'--cwd',cwd,'--shell',quote(resolve(runRoot,'perf_fixture.exe'))],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await ready(port,child);proxy=await proxyFor(port,harness);
  const report=await chromeProbe(await findChrome(),'http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome'),'workspaceStage',async({protocol,evaluate})=>{
    const width=await evaluate('document.body?.dataset.viewportRequest||""'),done=await evaluate('document.body?.dataset.viewportDone||""');
    if(width&&width!==done){await protocol('Emulation.setDeviceMetricsOverride',{width:Number(width),height:900,deviceScaleFactor:1,mobile:false});await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await evaluate('document.body.dataset.viewportDone='+JSON.stringify(width));}
    const name=await evaluate('document.body?.dataset.capture||""');
    if(name&&name!==lastCapture){lastCapture=name;const shot=await protocol('Page.captureScreenshot',{format:'png'});await writeFile(resolve(screenshots,name+'.png'),Buffer.from(shot.data,'base64'));await evaluate('document.body.dataset.captured='+JSON.stringify(name));}
  });
  assert.equal(report.pass,true,JSON.stringify(report));assert.equal(proxy.stats.upstreamErrors,0,'Asset GET failures');
  await writeFile(resolve(screenshots,'verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({pass:true,checks:report.checks.length,screenshots}));
}finally{await stopProxy(proxy);await stopChild(child);await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
