// Folder picker, settings, Reader and responsive UI through native Chrome.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile, mkdir, rm, writeFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeProbe, findChrome, freePort, proxyFor, quote, ready, stopChild, stopProxy} from './cli-browser-support.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const scratch=resolve(root,'.tmp'), runRoot=resolve(scratch,`workbench-${process.pid}-${Date.now()}`);
assert.ok(runRoot.startsWith(scratch+sep));
const cwd=resolve(runRoot,'sample-workspace'), childFolder=resolve(cwd,'reports & notes');
const screenshots=resolve(scratch,'browser-qa-workbench');
const binaries=resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(root,'target/debug'));

const harness=String.raw`
const $=id=>document.getElementById(id), CWD=__CWD__, CHILD=__CHILD__;
const checks=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,label){for(let i=0;i<300;i++){const found=await test();if(found)return found;await pause(50);}throw new Error('Timed out: '+label);}
function check(value,label){if(!value)throw new Error(label);checks.push(label);}
async function sessions(){return (await(await fetch('/api/sessions',{cache:'no-store'})).json()).sessions;}
async function capture(name,width){document.body.dataset.capture=JSON.stringify({name,width});await until(()=>document.body.dataset.captured===name,'capture '+name);}
function fits(element){const box=element.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth+1&&box.top>=0&&box.bottom<=innerHeight+1;}
function enter(target,key){target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
function address(path){$('directory-address').click();$('directory-path').value=path;enter($('directory-path'),'Enter');}
function pasteMarkdown(value){const data=new DataTransfer();data.setData('text/plain',value);$('reader').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}
function publish(report){document.body.dataset.probeResult=btoa(unescape(encodeURIComponent(JSON.stringify(report))));}
async function main(){
  await until(()=>$('connection-status').textContent==='Connected'&&!$('empty-state').hidden,'empty workspace');
  check((await sessions()).length===0&&$('workspace-tabs').querySelectorAll('.workspace-tab').length===1,'fresh server has one empty workspace');
  await capture('empty-desktop',1280);check(fits($('empty-new')),'desktop empty action fits');
  $('empty-new').click();await until(()=>$('directory-dialog').open&&!$('directory-create').disabled,'picker initial folder');
  check($('directory-breadcrumbs').lastElementChild.textContent==='sample-workspace'&&$('directory-path').hidden,'picker shows current folder as breadcrumbs');
  check($('directory-list').querySelectorAll('.directory-row').length===2,'picker lists owned child folders');
  $('directory-filter').value='reports';$('directory-filter').dispatchEvent(new Event('input',{bubbles:true}));
  check($('directory-list').querySelectorAll('.directory-row').length===1&&$('directory-message').textContent==='1 of 2','folder filter narrows real results');
  let row=$('directory-list').querySelector('.directory-row');row.click();
  check(row.getAttribute('aria-selected')==='true'&&$('directory-selected').textContent==='reports & notes','single click selects child');
  await capture('picker-desktop',1280);
  row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  await until(()=>$('directory-breadcrumbs').lastElementChild.textContent==='reports & notes','double-click folder navigation');
  check($('directory-list').textContent.includes('no subfolders'),'empty folder remains selectable');
  $('directory-back').click();await until(()=>$('directory-breadcrumbs').lastElementChild.textContent==='sample-workspace','back navigation');
  $('directory-forward').click();await until(()=>$('directory-breadcrumbs').lastElementChild.textContent==='reports & notes','forward navigation');
  $('directory-up').click();await until(()=>$('directory-breadcrumbs').lastElementChild.textContent==='sample-workspace','up navigation');
  await capture('picker-mobile',320);check(fits($('directory-dialog'))&&fits($('directory-create')),'picker and Open action fit at 320px');
  await capture('picker-restored',1280);
  address(CWD+'\\missing-folder');await until(()=>!$('directory-error').hidden,'invalid address');
  check($('directory-error-text').textContent.length>0&&$('directory-dialog').open,'invalid location shows inline error');
  await capture('picker-error',1280);
  address(CHILD);await until(()=>$('directory-breadcrumbs').lastElementChild.textContent==='reports & notes'&&!$('directory-create').disabled,'typed valid address');
  $('directory-create').click();await until(async()=>(await sessions()).length===1&&$('pane').dataset.status==='Controlling','terminal created');
  check((await sessions())[0].cwd.toLowerCase().replace(/^\\\\\?\\/,'')===CHILD.toLowerCase(),'selected child reaches native process');
  await capture('terminal-desktop',1280);check(fits($('close-session')),'terminal action fits desktop');
  $('settings').click();check($('preferences-dialog').open,'settings dialog opens');
  $('larger').click();check($('preferences-font').textContent==='15 px','font size increases');
  $('smaller').click();check($('preferences-font').textContent==='14 px','font size decreases');
  $('preferences-close').click();check(!$('preferences-dialog').open,'settings dialog closes');
  $('reader-toggle').click();check(!$('reader').hidden&&$('reader').dataset.view==='empty','Reader opens empty beside terminal');
  const markdown='# Fixture summary\n\n## Checks\n\n- **Safe** Markdown\n- Searchable material\n\n\x60\x60\x60js\nconst answer = 42;\n\x60\x60\x60\n\n<script>window.__injected=true</script>';
  pasteMarkdown(markdown);
  check($('reader').dataset.view==='read'&&$('reader-article').querySelector('h1')?.textContent==='Fixture summary','pasted Markdown renders headings');
  check($('reader-article').querySelector('strong')?.textContent==='Safe'&&$('reader-article').querySelector('code')?.textContent.includes('answer'),'Reader renders emphasis and code');
  check(!window.__injected&&!$('reader-article').querySelector('script'),'Reader leaves HTML inert');
  $('reader-outline-toggle').click();check(!$('reader-outline').hidden&&$('reader-outline').querySelectorAll('button').length===2,'outline follows Markdown headings');
  $('reader-search').value='Searchable';$('reader-search').dispatchEvent(new Event('input',{bubbles:true}));
  check($('reader-count').textContent.includes('1'),'Reader searches within the document');
  await capture('reader-desktop',1280);check(fits($('reader'))&&fits($('pane')),'Reader and terminal fit desktop');
  $('reader-back').click();check($('reader').dataset.view==='list'&&$('reader-list').querySelectorAll('.reader-item').length===1,'document list retains pasted Markdown');
  $('reader-list').querySelector('.reader-open').click();check($('reader').dataset.view==='read','document opens from list');
  await capture('reader-mobile',390);check(fits($('reader'))&&fits($('reader-close')),'Reader remains reachable on mobile');
  await capture('terminal-mobile',390);
  $('reader-close').click();check($('reader').hidden,'Reader closes');
  check(window.__probeErrors.length===0,'no browser runtime errors');
  publish({pass:true,checks,errors:window.__probeErrors});
}
main().catch(error=>publish({pass:false,checks,error:String(error?.stack||error),errors:window.__probeErrors,state:{connection:$('connection-status')?.textContent,picker:$('directory-dialog')?.open,reader:$('reader')?.dataset.view,toast:$('toast-message')?.textContent}}));
`;

await mkdir(childFolder,{recursive:true});await mkdir(resolve(cwd,'src'),{recursive:true});await mkdir(screenshots,{recursive:true});
await copyFile(resolve(binaries,'webterminal.exe'),resolve(runRoot,'webterminal.exe'));
await copyFile(resolve(binaries,'perf_fixture.exe'),resolve(runRoot,'perf_fixture.exe'));
let child,proxy,lastCapture='';
try{
  const port=await freePort(),env={};
  for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  child=spawn(resolve(runRoot,'webterminal.exe'),['--port',String(port),'--cwd',cwd,'--shell',quote(resolve(runRoot,'perf_fixture.exe'))],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await ready(port,child);proxy=await proxyFor(port,harness.replace('__CWD__',JSON.stringify(cwd)).replace('__CHILD__',JSON.stringify(childFolder)));
  const report=await chromeProbe(await findChrome(),'http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome'),'workbenchStage',async({protocol,evaluate})=>{
    const capture=await evaluate('document.body?.dataset.capture||""');if(!capture||capture===lastCapture)return;
    lastCapture=capture;const {name,width}=JSON.parse(capture);
    await protocol('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const shot=await protocol('Page.captureScreenshot',{format:'png'});
    await writeFile(resolve(screenshots,name+'.png'),Buffer.from(shot.data,'base64'));
    await evaluate('document.body.dataset.captured='+JSON.stringify(name));
  });
  assert.equal(report.pass,true,JSON.stringify(report));assert.equal(proxy.stats.upstreamErrors,0,'Asset GET failures');
  await writeFile(resolve(screenshots,'verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({pass:true,checks:report.checks.length,screenshots}));
}finally{await stopProxy(proxy);await stopChild(child);await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
