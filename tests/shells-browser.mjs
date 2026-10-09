// Independent default PowerShell sessions through the embedded browser UI.
// Server, Chrome profile, shell history/cache and all listed files are owned.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile,mkdir,rm,writeFile} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeProbe,findChrome,freePort,proxyFor,ready,stopChild,stopProxy} from './cli-browser-support.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const target=resolve(root,'target');
const binaries=resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(target,'debug'));
const runRoot=resolve(target,`shells-${process.pid}-${Date.now()}`);
assert.ok(runRoot.startsWith(target+sep));
const cwd=resolve(runRoot,'workspace'),profile=resolve(runRoot,'shell-profile'),reports=resolve(target,'shells');
for(const path of [cwd,reports,profile,resolve(profile,'AppData/Roaming'),resolve(profile,'AppData/Local'),resolve(profile,'Temp')])await mkdir(path,{recursive:true});
await writeFile(resolve(cwd,'webterminal-listing-marker.txt'),'Owned shell fixture.\n');
await copyFile(resolve(binaries,'webterminal.exe'),resolve(runRoot,'webterminal.exe'));

const harness=String.raw`
const CWD=__CWD__;
const $=id=>document.getElementById(id);
const checks=JSON.parse(sessionStorage.getItem('shellChecks')||'[]');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,label){for(let i=0;i<500;i++){if(await test())return;await pause(20);}throw new Error('Timed out: '+label);}
function check(value,label){if(!value)throw new Error(label);checks.push(label);}
function current(){return window.__snapshotBodies[sessionStorage.getItem('webterminal.active')];}
function screen(){return current()?.terminal.screen.map(line=>line.cells.filter(cell=>cell[1]>0).map(cell=>cell[0]).join('')).join('\n')||'';}
async function sessions(){return(await(await fetch('/api/sessions',{cache:'no-store'})).json()).sessions;}
function key(name,code,keyCode){for(const type of ['keydown','keyup']){const event=new KeyboardEvent(type,{key:name,code,bubbles:true,cancelable:true});Object.defineProperty(event,'keyCode',{value:keyCode});$('keyboard').dispatchEvent(event);}}
function send(command){const transfer=new DataTransfer();transfer.setData('text/plain',command);$('keyboard').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));key('Enter','Enter',13);}
async function run(command,marker,exact=false){const seq=current().seq;send(command);await until(()=>current().seq>seq&&(exact?screen().split('\n').some(line=>line.trim()===marker):screen().includes(marker)),'command '+command);}
async function openPicker(){
  $('new').click();await until(()=>$('directory-dialog').open&&!$('directory-create').disabled,'picker');
  check(!$('directory-shell')&&!document.querySelector('.directory-profile'),'folder picker has no shell selection');
}
async function nativeKey(name){document.body.dataset.shellKey=name;await until(()=>document.body.dataset.shellKeyDone===name,'native key '+name);document.body.dataset.shellKey='';document.body.dataset.shellKeyDone='';}
async function capture(name,width){document.body.dataset.shellCapture=JSON.stringify({name,width});await until(()=>document.body.dataset.shellCaptured===name,'capture '+name);}
async function create(count){$('directory-create').focus();await nativeKey('Enter');await until(async()=>(await sessions()).length===count&&$('view-status').textContent==='Controlling','session '+count);return sessionStorage.getItem('webterminal.active');}
async function switchTo(id){document.querySelector('.session-entry[data-session="'+id+'"]').click();await until(()=>sessionStorage.getItem('webterminal.active')===id&&$('view-status').textContent==='Controlling','switch '+id);}
async function rejectedProfile(profile){
  const ws=new WebSocket('ws://'+location.host+'/ws');await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
  const result=new Promise(resolve=>ws.addEventListener('message',event=>{const message=JSON.parse(event.data);if(message.type==='error')resolve(message);}));
  ws.send(JSON.stringify({op:'create',cwd:CWD,profile,cols:80,rows:24}));const error=await result;ws.close();
  check(error.message==='Per-terminal shell selection is not supported','per-terminal shell choice rejected');
  check((await sessions()).length===2,'rejected profile creates no session');
}
async function main(){
  await until(()=>$('connection-status').textContent==='Connected','connection');
  if(sessionStorage.getItem('shellStage')==='reloaded'){
    const first=sessionStorage.getItem('shellFirst'),second=sessionStorage.getItem('shellSecond');
    await until(()=>$('view-status').textContent==='Controlling'&&current(),'restored control');
    check((await sessions()).length===2,'browser reload retains both PowerShell sessions');
    await run("Write-Output ('RELOADED_' + $webterminalProbeValue)",'RELOADED_41');
    check($('status-shell').textContent.includes('powershell.exe'),'reloaded PowerShell keeps its shell metadata');
    await switchTo(second);check($('status-shell').textContent.includes('powershell.exe'),'second reloaded terminal remains PowerShell');
    await run("Write-Output ('SECOND_RELOADED_' + $webterminalProbeValue)",'SECOND_RELOADED_99');
    check(true,'reload restores independent PowerShell variables');
    await switchTo(first);check(window.__probeErrors.length===0,'no browser exceptions or invalid deltas');
    const bytes=new TextEncoder().encode(JSON.stringify({pass:true,checks,userAgent:navigator.userAgent,errors:window.__probeErrors}));
    document.body.dataset.probeResult=btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));return;
  }
  check((await sessions()).length===0,'fresh isolated server has no terminals');
  await openPicker();
  check((await(await fetch('/api/info')).json()).shell==='powershell.exe -NoLogo -NoProfile','PowerShell is the server default');
  await capture('picker-desktop',1280);await capture('picker-mobile',320);
  const box=$('directory-dialog').getBoundingClientRect();check(box.left>=0&&box.right<=innerWidth,'folder picker fits at 320px');
  await capture('picker-restored',1280);
  const first=await create(1);await until(()=>screen().includes('PS ')&&screen().includes('>'),'PowerShell prompt');
  const firstMetadata=(await sessions()).find(session=>session.id===first);
  check(!('profile' in firstMetadata)&&firstMetadata.shell==='powershell.exe -NoLogo -NoProfile','default actually launches PowerShell without a per-terminal profile');
  await run('ls','webterminal-listing-marker.txt');check(true,'ls lists files in the selected directory');
  await run('pwd','Path');check(screen().includes(CWD),'pwd renders the selected working directory');
  await run("$webterminalProbeValue = 41; Write-Output ('SESSION_' + ($webterminalProbeValue + 1))",'SESSION_42');
  const seq=current().seq;send('clear');
  await until(()=>current().seq>seq&&!screen().includes('webterminal-listing-marker.txt')&&!screen().includes('SESSION_42')&&screen().includes('PS '),'clear screen');
  check(true,'clear removes visible command output');
  await run("Write-Output ('AFTER_CLEAR_' + ($webterminalProbeValue + 1))",'AFTER_CLEAR_42');check(true,'clear preserves the running shell and its variables');
  await run('Get-WebterminalMissingFixtureCommand','Get-WebterminalMissingFixtureCommand');
  await until(()=>screen().includes('not recognized'),'native unknown command error');
  check(current().terminal.screen.some(line=>line.cells.some(cell=>cell[1]>0&&cell[0].trim()&&!['#d4d4d4','#ffffff'].includes(cell[2]))),'PowerShell errors retain their native colors');
  await capture('powershell-terminal',1280);
  await openPicker();
  const second=await create(2);await until(()=>screen().includes('PS ')&&screen().includes('>'),'second PowerShell prompt');
  check($('status-shell').textContent.includes('powershell.exe')&&$('detail-shell').textContent.includes('powershell.exe'),'new terminals consistently show PowerShell metadata');
  await run('ls','webterminal-listing-marker.txt');check(true,'second PowerShell lists the same working directory');
  await run("$webterminalProbeValue = 99; Write-Output ('SECOND_' + $webterminalProbeValue)",'SECOND_99');
  const metadata=await sessions();check(first!==second&&metadata.every(session=>session.alive&&session.shell==='powershell.exe -NoLogo -NoProfile')&&metadata[0].cwd===metadata[1].cwd,'independent PowerShell sessions can share the same directory');
  await rejectedProfile('cmd');await rejectedProfile('cmd.exe /c unwanted-fixture');await rejectedProfile(42);
  await openPicker();
  document.querySelector('#directory-form button[value="cancel"]').click();
  await switchTo(first);check($('status-shell').textContent.includes('powershell.exe'),'switching tabs retains PowerShell metadata');
  await run("Write-Output ('SWITCHED_' + $webterminalProbeValue)",'SWITCHED_41');check(true,'switching tabs retains independent PowerShell variables');
  sessionStorage.setItem('shellFirst',first);sessionStorage.setItem('shellSecond',second);sessionStorage.setItem('shellChecks',JSON.stringify(checks));sessionStorage.setItem('shellStage','reloaded');location.reload();
}
main().catch(error=>{const bytes=new TextEncoder().encode(JSON.stringify({pass:false,error:String(error),checks,errors:window.__probeErrors,text:screen().slice(-700)}));document.body.dataset.probeResult=btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));});
`;

const environment={};
for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT'])if(process.env[key])environment[key]=process.env[key];
Object.assign(environment,{USERPROFILE:profile,HOME:profile,APPDATA:resolve(profile,'AppData/Roaming'),LOCALAPPDATA:resolve(profile,'AppData/Local'),TEMP:resolve(profile,'Temp'),TMP:resolve(profile,'Temp'),PSModulePath:resolve(environment.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules'),TERM:'dumb',NO_COLOR:'1'});
let child,proxy,lastCapture;
try{
  const port=await freePort();child=spawn(resolve(runRoot,'webterminal.exe'),['--port',String(port),'--cwd',cwd],{cwd,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await ready(port,child);proxy=await proxyFor(port,harness.replace('__CWD__',JSON.stringify(cwd)));
  const report=await chromeProbe(await findChrome(),'http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome'),'shellStage',async({protocol,evaluate})=>{
    const name=await evaluate('document.body.dataset.shellKey||""');
    if(name){await protocol('Input.dispatchKeyEvent',{type:'keyDown',key:name,code:name,windowsVirtualKeyCode:13,text:'\r'});await protocol('Input.dispatchKeyEvent',{type:'keyUp',key:name,code:name,windowsVirtualKeyCode:13});await evaluate('document.body.dataset.shellKeyDone='+JSON.stringify(name));}
    const capture=await evaluate('document.body.dataset.shellCapture||""');if(!capture||capture===lastCapture)return;lastCapture=capture;
    const {name:label,width}=JSON.parse(capture);await protocol('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    const screenshot=(await protocol('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data;
    await writeFile(resolve(reports,label+'.png'),Buffer.from(screenshot,'base64'));await evaluate('document.body.dataset.shellCaptured='+JSON.stringify(label));
  });
  report.proxy=proxy.stats;await writeFile(resolve(reports,'report.json'),JSON.stringify(report,null,2));
  assert.equal(report.pass,true,JSON.stringify(report));assert.equal(proxy.stats.upstreamErrors,0,'Upstream failures');
  console.log(JSON.stringify({pass:report.pass,checks:report.checks.length,report:resolve(reports,'report.json')}));
}finally{await stopProxy(proxy);await stopChild(child);await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
