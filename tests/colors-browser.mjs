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
  check(cell('DEFAULT_TEXT')[2]==='#cccccc'&&cell('DEFAULT_TEXT')[3]==='#1e1e1e',label+' default reset');
  verifyAttributes(label);verifyBands(label);
}
function verifyAttributes(label){
  const attrs=['STYLE_BOLD','STYLE_FAINT','STYLE_INVERSE','STYLE_RESET'].map(marker=>cell(marker)[4]);
  check(attrs.join()==='1,2,32,0',label+' Rust bold, faint, inverse and resets');
  const [bold,faint,inverse,reset]=['STYLE_BOLD','STYLE_FAINT','STYLE_INVERSE','STYLE_RESET'].map(marker=>getComputedStyle(element(marker)));
  check(Number(bold.fontWeight)>=700&&Number(reset.fontWeight)<700,label+' browser bold and reset weight');
  check(faint.color!==reset.color&&faint.backgroundColor==='rgb(30, 30, 30)',label+' faint dims glyphs only');
  check(inverse.color==='rgb(30, 30, 30)'&&inverse.backgroundColor==='rgb(204, 204, 204)',label+' inverse swaps default colors');
  check(reset.color==='rgb(204, 204, 204)'&&reset.backgroundColor==='rgb(30, 30, 30)',label+' attributes reset to defaults');
}
// Every painted band, including rows reflowed in history, keeps its extent.
function verifyBands(label,limit=Infinity){
  const all=rows(),lines=$('terminal-lines').children,cols=current().terminal.cols;
  const unit=parseFloat($('terminal-lines').style.getPropertyValue('--cell-width'));
  const gray=cells=>cells.every(c=>c[3]==='#303030');
  let bands=0;
  for(let index=0;index<Math.min(all.length,limit);index++){
    if(!all[index].cells.map(c=>c[0]).join('').startsWith('BAND_TEXT'))continue;
    bands++;const where=label+' band row '+index;const spaces=all[index+2].cells;
    check(gray(all[index].cells)&&gray(all[index+1].cells),where+' Rust text and blank bands reach the edge');
    check(gray(spaces.slice(0,17))&&spaces.slice(17).every(c=>c[3]==='#1e1e1e'),where+' Rust explicit spaces keep their extent');
    for(const row of [index,index+1]){
      const nodes=[...lines[row].querySelectorAll('.term-cell')];const width=nodes.reduce((sum,node)=>sum+node.getBoundingClientRect().width,0);
      check(nodes.length&&nodes.every(node=>getComputedStyle(node).backgroundColor==='rgb(48, 48, 48)')&&Math.abs(width-cols*unit)<1,where+' browser row '+row+' is gray to the edge');
    }
  }
  check(bands>0,label+' bands present');
}
async function shot(name,row){
  const scroll=$('terminal-scroll');if(row!==undefined)$('terminal-lines').children[row].scrollIntoView({block:'center'});
  document.body.dataset.shot=name;await until(()=>document.body.dataset.shotDone===name,'screenshot '+name);scroll.scrollTop=scroll.scrollHeight;
}
// Two steps through Settings, saved like a user would, then back to the terminal.
async function resizeFont(label){
  const cols=current().terminal.cols,page=name=>document.querySelector('.navigation-item[data-page="'+name+'"]').click();
  page('settings');await until(()=>$('settings-tab-terminal'),'settings');$('settings-tab-terminal').click();
  const step=document.querySelector('#settings-panel-terminal [aria-label="'+label+' terminal text"]');step.click();step.click();
  const footer=document.querySelector('#page-settings .prefs-footer');await until(()=>!footer.hidden,'unsaved settings');
  [...footer.querySelectorAll('button')].find(button=>button.textContent==='Save changes').click();await until(()=>footer.hidden,'settings saved');
  page('workspace');await until(()=>current().terminal.cols!==cols,'native resize');await pause(150);
}
function rgb(hex){return 'rgb('+[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16)).join(', ')+')';}
function completed(){
  const text=rows().map(row=>row.cells.filter(cell=>cell[1]!==0).map(cell=>cell[0]).join('')).join('\n');
  return Math.max(-1,...[...text.matchAll(/COLOR_DONE:(\d+)/g)].map(match=>Number(match[1])));
}
async function paintAndWait(command){
  const before=completed();send(command+'\r');
  await until(()=>completed()>before&&$('terminal-lines').textContent.includes('COLOR_DONE:'+completed()),'completed '+command);
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
  $('new').click();await until(()=>document.querySelector('dialog.launcher[open]'),'launcher');document.querySelector('dialog.launcher[open] .dlg-foot .btn.primary').click();
  await until(()=>$('pane').dataset.status==='Controlling'&&$('terminal-lines').textContent.includes('PAINT_END'),'color fixture');
  check($('terminal-lines').textContent.includes('COLOR_ENABLED=true'),'CLI-style color detection ignores the redirected host');
  verifyColors('initial');await paintAndWait('scroll');verifyColors('scrollback update');
  check(current().terminal.history.length>0,'colored output remains in bounded history');
  await resizeFont('Larger');verifyBands('narrowed history',current().terminal.history.length-2);await paintAndWait('paint');verifyColors('resized');
  await resizeFont('Smaller');await resizeFont('Smaller');verifyBands('widened history',current().terminal.history.length-2);await paintAndWait('paint');verifyColors('widened');
  await shot('widened-history',rows().findIndex(row=>row.cells.map(c=>c[0]).join('').startsWith('BAND_TEXT')));await shot('widened-screen');
  await paintAndWait('alternate');check(current().terminal.alternate,'alternate buffer entered');verifyColors('alternate');
  await paintAndWait('primary');check(!current().terminal.alternate,'primary restored');verifyColors('primary restored');
  sessionStorage.setItem('colorSession',current().id);sessionStorage.setItem('colorStage','reconnect');
  sessionStorage.setItem('colorChecks',JSON.stringify(checks));location.reload();
}
if(sessionStorage.getItem('colorStage')==='reconnect')checks.push(...JSON.parse(sessionStorage.getItem('colorChecks')));
main().catch(error=>{document.body.dataset.probeResult=btoa(JSON.stringify({pass:false,error:String(error),checks,errors:window.__probeErrors}));});
`;

const environment={};
for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[key])environment[key]=process.env[key];
Object.assign(environment,{TERM:'dumb',NO_COLOR:'1',CLICOLOR:'0',CLICOLOR_FORCE:'0',FORCE_COLOR:'0',TERM_PROGRAM:'fixture-host'});
let child,proxy,screenshot;const shots={};
try{
  const port=await freePort();
  child=spawn(resolve(runRoot,'webterminal.exe'),['--port',String(port),'--cwd',runRoot,'--shell',quote(resolve(runRoot,'color_fixture.exe'))+' --interactive','--config',resolve(runRoot,'settings.json')],{cwd:runRoot,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await ready(port,child);proxy=await proxyFor(port,harness);
  const report=await chromeProbe(await findChrome(),'http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome'),'colorStage',async({protocol,evaluate})=>{
    if(!screenshot&&await evaluate('document.getElementById("terminal-lines")?.textContent.includes("RGB_TEXT")'))screenshot=(await protocol('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data;
    const name=await evaluate('document.body?.dataset.shot||""');
    if(name&&!shots[name]){shots[name]=(await protocol('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data;await evaluate('document.body.dataset.shotDone='+JSON.stringify(name));}
  });
  report.proxy=proxy.stats;report.buildDirectory=binaries;
  await writeFile(resolve(reports,label+'.json'),JSON.stringify(report,null,2));
  if(screenshot)await writeFile(resolve(reports,label+'.png'),Buffer.from(screenshot,'base64'));
  for(const [name,data] of Object.entries(shots))await writeFile(resolve(reports,label+'-'+name+'.png'),Buffer.from(data,'base64'));
  assert.equal(report.pass,true,JSON.stringify(report));assert.equal(proxy.stats.upstreamErrors,0,'Upstream failures');
  console.log(JSON.stringify({pass:report.pass,checks:report.checks.length,report:resolve(reports,label+'.json')}));
}finally{await stopProxy(proxy);await stopChild(child);await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
