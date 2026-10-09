// Optional real Jecode acceptance: an isolated profile, the owned Webterminal
// server, its original browser UI, and a system Chrome profile under target/.
// This never submits a model prompt or reads a personal CLI profile.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {copyFile, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {get as httpGet} from 'node:http';
import {createServer as portServer} from 'node:net';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {proxyFor} from './cli-browser-support.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = resolve(root, 'target');
const runRoot = resolve(target, `cli-browser-${process.pid}-${Date.now()}`);
assert.ok(runRoot.startsWith(target + sep));
const jecode = process.env.WEBTERMINAL_JECODE_EXE;
if (!jecode) throw new Error('Set WEBTERMINAL_JECODE_EXE to an installed Jecode executable');
const binDirectory = resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(target,'debug'));
const binaries = {webterminal:resolve(binDirectory,'webterminal.exe'),isolated:resolve(binDirectory,'isolated_cli.exe')};
const chromePaths = [
  join(process.env.PROGRAMFILES || 'C:\\Program Files','Google','Chrome','Application','chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)','Google','Chrome','Application','chrome.exe'),
];
let chrome;
for (const path of chromePaths) { try { await stat(path); chrome=path; break; } catch {} }
if (!chrome) throw new Error('System Chrome was not found');
for (const path of [...Object.values(binaries),jecode]) await stat(path);

const harness = String.raw`
const CWD=__CWD__;
const $=id=>document.getElementById(id);
const checks=JSON.parse(sessionStorage.getItem('jecodeBrowserChecks')||'[]');
const pause=ms=>fetch('/probe-pause?ms='+ms,{cache:'no-store'});
async function until(probe,label,tries=300) {
  for (let i=0;i<tries;i++) { const found=await probe(); if(found) return found; await pause(50); }
  throw new Error('Timed out: '+label);
}
function check(value,label) { if(!value) throw new Error(label); checks.push(label); }
function text() { return $('terminal-lines').textContent||''; }
function key(name,code,options={},keyCode=0) {
  for(const type of ['keydown','keyup']) {
    const event=new KeyboardEvent(type,{key:name,code,bubbles:true,cancelable:true,...options});
    Object.defineProperty(event,'keyCode',{value:keyCode});
    $('keyboard').dispatchEvent(event);
  }
}
function paste(value) {
  const transfer=new DataTransfer(); transfer.setData('text/plain',value);
  $('keyboard').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
}
async function sessions() {
  const response=await fetch('/api/sessions',{cache:'no-store'});
  if(!response.ok) throw new Error('Sessions HTTP '+response.status);
  return (await response.json()).sessions;
}
async function create(count) {
  $('new').click();
  await until(()=>$('directory-dialog').open,'directory dialog');
  $('directory-path').value=CWD;
  $('directory-go').click();
  await until(()=>!$('directory-create').disabled,'selected directory');
  $('directory-create').click();
  await until(async()=>(await sessions()).length===count,'session '+count);
  await until(()=>text().includes('Ask anything'),'Jecode composer '+count);
  await until(()=>$('view-status').textContent==='Controlling','controller '+count);
}
function observed(id) {
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket('ws://'+location.host+'/ws');
    let hello,snapshot;
    ws.onopen=()=>ws.send(JSON.stringify({op:'attach',id,cols:80,rows:24}));
    ws.onmessage=event=>{
      const message=JSON.parse(event.data);
      if(message.type==='hello') hello=message;
      if(message.type==='snapshot'&&message.id===id) snapshot=message;
      if(hello&&snapshot) resolve({ws,hello,snapshot});
    };
    ws.onerror=()=>reject(new Error('Observer WebSocket failed'));
  });
}
async function main() {
  try {
    if(sessionStorage.getItem('jecodeBrowserStage')!=='reloaded') {
      check((await sessions()).length===0,'fresh server has no sessions');
      await create(1);
      const first=(await sessions())[0];
      check(first.cwd.toLowerCase().replace(/^\\\\\?\\/,'')===CWD.toLowerCase(),'chosen directory reached Jecode');
      check(text().includes('Jecode')&&text().includes('Ask anything'),'real Jecode TUI rendered');
      const peer=await observed(first.id);
      check(peer.snapshot.terminal.modes.win32===true,'Jecode negotiated Win32 input');
      check(peer.snapshot.controller!==peer.hello.view,'second browser view observes');
      peer.ws.close();
      $('keyboard').focus();

      const initial=text();
      key('Enter','Enter',{shiftKey:true},13);
      await until(()=>text()!==initial,'Shift+Enter changes empty composer');
      check((await sessions()).find(item=>item.id===first.id)?.alive,'Shift+Enter kept CLI running');
      key('c','KeyC',{ctrlKey:true},67);
      await until(()=>text().includes('Ask anything'),'empty composer after Ctrl+C');

      paste('draft caf\u00e9 \ud83d\udc69\u200d\ud83d\udcbb');
      await until(()=>text().includes('draft caf\u00e9 \ud83d\udc69\u200d\ud83d\udcbb'),'complete Unicode draft');
      await pause(250);
      key('Backspace','Backspace',{},8);
      await until(()=>!text().includes('\ud83d\udc69\u200d\ud83d\udcbb'),'Unicode grapheme Backspace');
      paste('X');
      await until(()=>text().includes('draft caf\u00e9 X'),'Unicode replacement');
      check(true,'Unicode edit survived 250ms idle before Backspace');
      const beforeSize=$('terminal-size').textContent;
      $('larger').click();
      await until(()=>$('terminal-size').textContent!==beforeSize,'terminal resize');
      await until(()=>text().includes('draft caf\u00e9 X'),'draft redraw after browser resize');
      check(text().includes('draft caf\u00e9 X'),'draft survived browser resize');
      $('smaller').click();
      key('c','KeyC',{ctrlKey:true},67);
      await until(()=>!text().includes('draft caf\u00e9 X'),'clear draft');

      paste('first caf\u00e9\nsecond \ud83d\udc69\u200d\ud83d\udcbb');
      await until(()=>text().includes('first caf\u00e9')&&text().includes('second'),'bracketed multiline paste');
      check(text().includes('second'),'multiline paste stayed local and visible');
      key('c','KeyC',{ctrlKey:true},67);
      await until(()=>!text().includes('first caf\u00e9'),'clear pasted draft');
      $('terminal-area').style.maxHeight='440px';
      await until(()=>Number($('terminal-size').textContent.split('×')[1])<=24,'compact help viewport');
      key('F1','F1',{},112);
      await until(()=>text().includes('Commands and controls')&&text().includes('/new'),'F1 local help');
      check(true,'F1 opened local help');
      const wheelPeer=await observed(first.id);
      check(wheelPeer.snapshot.terminal.modes.mouseSgr&&wheelPeer.snapshot.terminal.modes.mouse,'Jecode requested SGR mouse reports');
      wheelPeer.ws.close();
      const rect=$('terminal-lines').getBoundingClientRect();
      const cellWidth=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--cell-width'));
      const lineHeight=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--line-height'));
      const pointer={clientX:rect.left+9.5*cellWidth,clientY:rect.top+7.5*lineHeight,bubbles:true,cancelable:true};
      const wheelInputs=window.__wire.filter(item=>item.op==='input').length;
      $('terminal-scroll').dispatchEvent(new WheelEvent('wheel',{...pointer,deltaY:120}));
      await until(()=>window.__wire.filter(item=>item.op==='input').length>wheelInputs,'browser wheel report');
      await until(()=>!text().includes('/new'),'F1 wheel down');
      $('terminal-scroll').dispatchEvent(new WheelEvent('wheel',{...pointer,deltaY:-120}));
      await until(()=>text().includes('/new'),'F1 wheel up');
      check(true,'SGR wheel scrolls local Jecode help down and up');
      key('Escape','Escape',{},27);
      $('terminal-area').style.maxHeight='';
      paste('/resume');
      key('Enter','Enter',{},13);
      await until(()=>text().includes('Resume'),'local resume menu');
      check(true,'/resume opened local selector');
      key('Escape','Escape',{},27);

      await create(2);
      const all=await sessions();
      check(all[0].id!==all[1].id&&all.every(item=>item.cwd===first.cwd),'two Jecode sessions in one directory');
      sessionStorage.setItem('jecodeBrowserFirst',all[0].id);
      sessionStorage.setItem('jecodeBrowserSecond',all[1].id);
      sessionStorage.setItem('jecodeBrowserChecks',JSON.stringify(checks));
      sessionStorage.setItem('jecodeBrowserStage','reloaded');
      location.reload();
      return;
    }
    const first=sessionStorage.getItem('jecodeBrowserFirst');
    const second=sessionStorage.getItem('jecodeBrowserSecond');
    await until(()=>text().includes('Ask anything')&&$('tabs').querySelectorAll('.tab').length===2,'reload snapshot');
    check((await sessions()).length===2,'browser reload kept both CLI sessions');
    await until(()=>$('view-status').textContent==='Controlling','control after reload');
    let frameCount=window.__snapshots.filter(item=>item.id===first).length;
    [...$('tabs').querySelectorAll('.tab')].find(tab=>tab.getAttribute('aria-selected')==='false').click();
    await until(()=>window.__snapshots.filter(item=>item.id===first).length>frameCount&&text().includes('Ask anything')&&$('view-status').textContent==='Controlling','fresh first tab control');
    check((await sessions()).find(item=>item.id===first)?.alive,'first CLI remained alive');
    $('keyboard').focus();
    key('q','KeyQ',{ctrlKey:true},81);
    await until(async()=>!(await sessions()).find(item=>item.id===first)?.alive,'first Ctrl+Q exit');
    check($('view-status').textContent.startsWith('Exited'),'first Ctrl+Q was a normal CLI exit');
    frameCount=window.__snapshots.filter(item=>item.id===second).length;
    const wireStart=window.__wire.length;
    [...$('tabs').querySelectorAll('.tab')].find(tab=>tab.getAttribute('aria-selected')==='false').click();
    check($('view-status').textContent==='Connecting…'&&$('take-control').hidden,'cached controller is gated during attach');
    const pendingRequest=window.__wire.slice(wireStart).find(item=>item.op==='attach'&&item.id===second)?.request;
    const simulate=message=>window.__appSocket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(message)}));
    simulate(window.__snapshotBodies[second]);
    simulate({type:'attached',id:second,request:pendingRequest+1});
    check($('view-status').textContent==='Connecting…','pre-ack snapshot and wrong-token ack cannot restore control');
    $('keyboard').focus();
    key('x','KeyX',{},88);
    $('larger').click();
    check(!window.__wire.slice(wireStart).some(item=>item.op==='input'||item.op==='resize'),'immediate key and geometry do not use stale epoch');
    await until(()=>window.__snapshots.filter(item=>item.id===second).length>frameCount&&text().includes('Ask anything')&&$('view-status').textContent==='Controlling','fresh second tab control');
    const switched=window.__wire.slice(wireStart);
    const attachIndex=switched.findIndex(item=>item.op==='attach'&&item.id===second);
    const ackIndex=switched.findIndex(item=>item.type==='attached'&&item.id===second&&item.request===pendingRequest);
    check(attachIndex>=0&&ackIndex>attachIndex&&!switched.slice(attachIndex+1,ackIndex).some(item=>item.op==='input'||item.op==='resize'),'no write before matching attach acknowledgement');
    check(!text().includes('› x'),'discarded immediate key did not enter Jecode draft');
    $('keyboard').focus();
    paste('post-attach');
    await until(()=>text().includes('post-attach'),'fresh-epoch input reaches Jecode');
    check(!$('toast').textContent.includes('Control changed'),'switch caused no rejected input or resize');
    key('c','KeyC',{ctrlKey:true},67);
    await until(()=>!text().includes('post-attach'),'clear post-attach draft');
    key('q','KeyQ',{ctrlKey:true},81);
    await until(async()=>!(await sessions()).find(item=>item.id===second)?.alive,'second Ctrl+Q exit');
    await until(()=>$('view-status').textContent.startsWith('Exited'),'second exit snapshot');
    check($('view-status').textContent.startsWith('Exited'),'second Ctrl+Q was a normal CLI exit');
    check((await sessions()).every(item=>item.exitCode===0),'both Jecode processes exited with code 0');
  } catch(error) {
    checks.push({fail:String(error?.stack||error),status:$('view-status').textContent,size:$('terminal-size').textContent,active:sessionStorage.getItem('webterminal.active'),first:sessionStorage.getItem('jecodeBrowserFirst'),second:sessionStorage.getItem('jecodeBrowserSecond'),tabs:[...$('tabs').querySelectorAll('.tab')].map(tab=>tab.getAttribute('aria-selected')),text:text().slice(-1200),toast:$('toast').textContent,errors:window.__probeErrors,snapshots:window.__snapshots?.slice(-5),wire:window.__wire?.slice(-10)});
  }
  const report={pass:checks.every(item=>typeof item==='string'),checks,userAgent:navigator.userAgent};
  document.body.dataset.probeResult=btoa(Array.from(new TextEncoder().encode(JSON.stringify(report)),byte=>String.fromCharCode(byte)).join(''));
}
await main();
`;

async function freePort() {
  const server=portServer();
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen);});
  const port=server.address().port;
  await new Promise(resolveClose=>server.close(resolveClose));
  return port;
}
async function ready(port,child) {
  for(let i=0;i<200;i++) {
    if(child.exitCode!==null) throw new Error('Webterminal exited before serving');
    try {
      const status=await new Promise((resolveStatus,reject)=>{
        const call=httpGet({hostname:'127.0.0.1',port,path:'/api/info',headers:{Host:'127.0.0.1:'+port}},response=>{response.resume();resolveStatus(response.statusCode);});
        call.once('error',reject);
      });
      if(status===200) return;
    } catch {}
    await new Promise(resolvePause=>setTimeout(resolvePause,50));
  }
  throw new Error('Webterminal was not ready');
}
async function chromeProbe(url,profile) {
  await mkdir(profile,{recursive:true});
  const child=spawn(chrome,['--headless=new','--remote-debugging-port=0','--window-size=1280,900','--user-data-dir='+profile,url],{windowsHide:true});
  let errors='';child.stderr.setEncoding('utf8');child.stderr.on('data',part=>{errors+=part;});
  let devtools;
  try {
    let port;
    for(let i=0;i<100;i++) {
      if(child.exitCode!==null) throw new Error('Chrome exited: '+errors.slice(-500));
      try {port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]);if(port)break;} catch {}
      await new Promise(resolvePause=>setTimeout(resolvePause,100));
    }
    if(!port) throw new Error('Chrome DevTools port missing');
    let page;
    for(let i=0;i<100;i++) {
      try {
        const targets=await new Promise((resolveTargets,reject)=>{
          const call=httpGet({hostname:'127.0.0.1',port,path:'/json/list'},response=>{
            let body='';response.setEncoding('utf8');response.on('data',part=>{body+=part;});response.on('end',()=>{try{resolveTargets(JSON.parse(body));}catch(error){reject(error);}});
          });call.once('error',reject);
        });
        page=targets.find(item=>item.type==='page'&&item.url===url);if(page)break;
      } catch {}
      await new Promise(resolvePause=>setTimeout(resolvePause,100));
    }
    if(!page) throw new Error('Chrome page target missing');
    devtools=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolveOpen,reject)=>{devtools.addEventListener('open',resolveOpen,{once:true});devtools.addEventListener('error',reject,{once:true});});
    let nextId=0;const pending=new Map();
    devtools.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(!message.id||!pending.has(message.id))return;
      const {resolveResult,rejectResult}=pending.get(message.id);pending.delete(message.id);
      if(message.error)rejectResult(new Error(message.error.message));else resolveResult(message.result);
    });
    function evaluate(expression) {
      const id=++nextId;
      return new Promise((resolveResult,rejectResult)=>{
        pending.set(id,{resolveResult,rejectResult});
        devtools.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));
      }).then(result=>result.result?.value);
    }
    for(let i=0;i<240;i++) {
      if(child.exitCode!==null) throw new Error('Chrome exited during probe: '+errors.slice(-500));
      const encoded=await evaluate('document.body?.dataset.probeResult||""').catch(()=>null);
      if(encoded)return JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
      await new Promise(resolvePause=>setTimeout(resolvePause,200));
    }
    const state=await evaluate('JSON.stringify({stage:sessionStorage.getItem("jecodeBrowserStage"),text:document.getElementById("terminal-lines")?.textContent?.slice(-500),errors:window.__probeErrors})').catch(()=>null);
    throw new Error('Chrome probe timed out: '+state+' '+errors.slice(-500));
  } finally {
    devtools?.close();
    if(child.exitCode===null){child.kill();await Promise.race([new Promise(resolveExit=>child.once('exit',resolveExit)),new Promise(resolveWait=>setTimeout(resolveWait,3000))]);}
  }
}
function quote(text) { return '"'+text.replaceAll('"','\\"')+'"'; }

await mkdir(runRoot,{recursive:true});
let child,proxy;
try {
  const copied={webterminal:resolve(runRoot,'webterminal.exe'),isolated:resolve(runRoot,'isolated_cli.exe')};
  await copyFile(binaries.webterminal,copied.webterminal);
  await copyFile(binaries.isolated,copied.isolated);
  const cwd=resolve(runRoot,'work');
  const profile=resolve(runRoot,'cli-profile');
  await mkdir(cwd,{recursive:true});
  await mkdir(resolve(profile,'.jecode'),{recursive:true});
  await writeFile(resolve(profile,'.jecode','config.json'),JSON.stringify({openrouter:{api_key:'webterminal-isolated-fixture-key',model:'fixture/model'}}));
  const port=await freePort();
  const command=[copied.isolated,profile,jecode].map(quote).join(' ');
  const environment={};
  for(const key of ['SystemRoot','SystemDrive','WINDIR','PATH','PATHEXT','ComSpec','ProgramFiles','ProgramFiles(x86)','ProgramW6432','TEMP','TMP']) if(process.env[key]) environment[key]=process.env[key];
  child=spawn(copied.webterminal,['--port',String(port),'--cwd',cwd,'--shell',command],{cwd,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let serverOutput='';child.stdout.on('data',part=>{serverOutput+=part;});child.stderr.on('data',part=>{serverOutput+=part;});
  await ready(port,child);
  proxy=await proxyFor(port,harness.replace('__CWD__',JSON.stringify(cwd)));
  const report=await chromeProbe('http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome-profile'));
  for(const item of report.checks) console.log(typeof item==='string'?'PASS '+item:'FAIL '+JSON.stringify(item));
  const version=spawnSync(jecode,['--version'],{encoding:'utf8',windowsHide:true});
  console.log('Jecode '+(version.stdout||version.stderr).trim());
  console.log('Chrome '+report.userAgent);
  console.log('Proxy '+JSON.stringify(proxy.stats));
  if (!report.pass) console.log('Webterminal '+serverOutput.slice(-3000));
  assert.equal(report.pass,true,'Jecode browser acceptance failed');
  assert.equal(proxy.stats.upstreamErrors,0,'Test proxy had upstream errors');
} finally {
  if(proxy){for(const socket of proxy.sockets)socket.destroy();await new Promise(resolveClose=>proxy.server.close(resolveClose));}
  if(child?.exitCode===null){child.kill();await Promise.race([new Promise(resolveExit=>child.once('exit',resolveExit)),new Promise(resolveWait=>setTimeout(resolveWait,3000))]);}
  await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
