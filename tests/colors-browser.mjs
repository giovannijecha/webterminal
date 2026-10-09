// Original color acceptance through actual ConPTY, Rust state and Chrome.
// The parent deliberately disables colors; all data and processes are owned.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile, mkdir, rm, writeFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeProbe,findChrome,freePort,proxyFor,ready,stopChild,stopProxy,quote} from './cli-browser-support.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const target=resolve(root,'target');
const scratch=resolve(root,'.tmp');
const binaries=resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(target,'debug'));
const runRoot=resolve(scratch,`colors-${process.pid}-${Date.now()}`);
const label=process.argv[2] || 'current';
assert.match(label,/^[a-z0-9-]+$/);assert.ok(runRoot.startsWith(scratch+sep));
const reports=resolve(scratch,'browser-reports','colors');await mkdir(reports,{recursive:true});await mkdir(runRoot,{recursive:true});
await copyFile(resolve(binaries,'webterminal.exe'),resolve(runRoot,'webterminal.exe'));
await copyFile(resolve(binaries,'color_fixture.exe'),resolve(runRoot,'color_fixture.exe'));

const harness=String.raw`
const $=id=>document.getElementById(id);
const checks=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,label){for(let i=0;i<500;i++){if(test())return;await pause(20);}throw new Error('Timed out: '+label);}
function check(value,label){if(!value)throw new Error(label);checks.push(label);}
function send(text){const data=new DataTransfer();data.setData('text/plain',text);$('keyboard').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}
function current(){return window.__snapshotBodies[Object.keys(window.__snapshotBodies)[0]];}
function rows(){const term=current().terminal;return term.alternate?term.screen:[...term.history,...term.screen];}
function cell(marker){
  for(const row of rows()){
    const text=row.cells.filter(c=>c[1]!==0).map(c=>c[0]).join('');const start=text.indexOf(marker);
    if(start<0)continue;
    let index=0;for(const c of row.cells){if(c[1]===0)continue;if(index===start)return c;index+=c[0].length;}
  }
  throw new Error('Missing Rust color marker: '+marker);
}
function element(marker){return [...$('terminal-lines').querySelectorAll('.term-cell')].find(node=>node.textContent.includes(marker));}
const palette=['#000000','#cd3131','#0dbc79','#e5e510','#2472c8','#bc3fbc','#11a8cd','#e5e5e5','#666666','#f14c4c','#23d18b','#f5f543','#3b8eea','#d670d6','#29b8db','#ffffff'];
function verifyColors(label){
  for(let n=0;n<16;n++){
    const marker=(n<8?'NORMAL_':'BRIGHT_')+(n%8);const expected=palette[n];
    check(cell(marker)[2]===expected,label+' Rust '+marker);
    const node=element(marker);check(node&&node.style.color===rgb(expected),label+' browser '+marker);
  }
  check(cell('INDEXED_RED')[2]==='#ff0000',label+' indexed color');
  check(cell('RGB_TEXT')[2]==='#112233',label+' RGB foreground');
  check(cell('RGB_BACKGROUND')[3]==='#1a2b3c',label+' RGB background');
  check(getComputedStyle(element('RGB_TEXT')).color==='rgb(17, 34, 51)',label+' computed foreground');
  check(getComputedStyle(element('RGB_BACKGROUND')).backgroundColor==='rgb(26, 43, 60)',label+' computed background');
  const inverse=cell('INVERSE_RED');
  check(Boolean(inverse[4]&32)&&inverse[2]==='#cd3131',label+' inverse Rust state');
  check(getComputedStyle(element('INVERSE_RED')).backgroundColor==='rgb(205, 49, 49)',label+' inverse browser state');
  check(cell('UNICODE_')[2]==='#0dbc79',label+' Unicode foreground');
  check(cell('DEFAULT_TEXT')[2]==='#d4d4d4'&&cell('DEFAULT_TEXT')[3]==='#121314',label+' default reset');
}
function rgb(hex){return 'rgb('+[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16)).join(', ')+')';}
async function paintAndWait(command){
  const sequence=current().seq;send(command+'\r');
  await until(()=>current().seq>sequence&&$('terminal-lines').textContent.includes('PAINT_END'),'paint '+command);await pause(100);
}
async function main(){
  await until(()=>$('connection-status').textContent==='Connected','connection');
  if(sessionStorage.getItem('colorStage')==='reconnect'){
    await until(()=>$('pane').dataset.status==='Controlling'&&$('terminal-lines').textContent.includes('RGB_TEXT'),'reconnect');
    verifyColors('reconnect');check(Object.keys(window.__snapshotBodies).length===1,'reconnect retains the same session');
    check(current().id===sessionStorage.getItem('colorSession'),'session identity survives reconnect');
    const before=current().seq;await paintAndWait('paint');check(current().seq>before,'fresh ordered colors after reconnect');
    verifyColors('after reconnect update');
    check(window.__probeErrors.length===0,'no browser exceptions or invalid deltas');
    const report={pass:true,checks,userAgent:navigator.userAgent,session:current().id,seq:current().seq,errors:window.__probeErrors};
    document.body.dataset.probeResult=btoa(JSON.stringify(report));return;
  }
  $('new').click();await until(()=>!$('directory-create').disabled,'directory');$('directory-create').click();
  await until(()=>$('pane').dataset.status==='Controlling'&&$('terminal-lines').textContent.includes('PAINT_END'),'color fixture');
  check($('terminal-lines').textContent.includes('COLOR_ENABLED=true'),'CLI-style color detection ignores the redirected host');
  verifyColors('initial');await paintAndWait('scroll');verifyColors('scrollback update');
  check(current().terminal.history.length>0,'colored output remains in bounded history');
  const cols=current().terminal.cols;$('settings').click();$('larger').click();$('preferences-close').click();
  await until(()=>current().terminal.cols!==cols,'native resize');await paintAndWait('paint');verifyColors('resized');
  await paintAndWait('alternate');check(current().terminal.alternate,'alternate buffer entered');verifyColors('alternate');
  send('primary\r');await until(()=>!current().terminal.alternate,'primary restored');verifyColors('primary restored');
  sessionStorage.setItem('colorSession',current().id);sessionStorage.setItem('colorStage','reconnect');
  sessionStorage.setItem('colorChecks',JSON.stringify(checks));location.reload();
}
if(sessionStorage.getItem('colorStage')==='reconnect')checks.push(...JSON.parse(sessionStorage.getItem('colorChecks')));
main().catch(error=>{document.body.dataset.probeResult=btoa(JSON.stringify({pass:false,error:String(error),checks,errors:window.__probeErrors}));});
`;

const environment={};
for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[key])environment[key]=process.env[key];
Object.assign(environment,{TERM:'dumb',NO_COLOR:'1',CLICOLOR:'0',CLICOLOR_FORCE:'0',FORCE_COLOR:'0',TERM_PROGRAM:'fixture-host'});
let child,proxy,screenshot;
try{
  const port=await freePort();
  child=spawn(resolve(runRoot,'webterminal.exe'),['--port',String(port),'--cwd',runRoot,'--shell',quote(resolve(runRoot,'color_fixture.exe'))+' --interactive'],{cwd:runRoot,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await ready(port,child);proxy=await proxyFor(port,harness);
  const report=await chromeProbe(await findChrome(),'http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome'),'colorStage',async({protocol,evaluate})=>{
    if(!screenshot&&await evaluate('document.getElementById("terminal-lines")?.textContent.includes("RGB_TEXT")'))screenshot=(await protocol('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data;
  });
  report.proxy=proxy.stats;report.buildDirectory=binaries;
  await writeFile(resolve(reports,label+'.json'),JSON.stringify(report,null,2));
  if(screenshot)await writeFile(resolve(reports,label+'.png'),Buffer.from(screenshot,'base64'));
  assert.equal(report.pass,true,JSON.stringify(report));assert.equal(proxy.stats.upstreamErrors,0,'Upstream failures');
  console.log(JSON.stringify({pass:report.pass,checks:report.checks.length,report:resolve(reports,label+'.json')}));
}finally{await stopProxy(proxy);await stopChild(child);await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
