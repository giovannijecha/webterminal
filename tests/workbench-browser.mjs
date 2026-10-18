// Launcher and folder picker, Settings, Reader, every page at five widths and
// narrow pane switching with long paths, through native Chrome.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeProbe, findChrome, freePort, proxyFor, quote, ready, stopChild, stopProxy} from './cli-browser-support.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const scratch=resolve(root,'.tmp'), runRoot=resolve(scratch,`workbench-${process.pid}-${Date.now()}`);
assert.ok(runRoot.startsWith(scratch+sep));
const cwd=resolve(runRoot,'sample-workspace'), childFolder=resolve(cwd,'reports & notes');
const longFolder=resolve(cwd,'a-deliberately-long-folder-name-that-must-wrap-or-truncate-in-pane-headers','and-a-nested-segment-with-more-words');
const screenshots=resolve(scratch,'browser-qa-workbench');
const binaries=resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(root,'target/debug'));

const harness=String.raw`
const $=id=>document.getElementById(id), CWD=__CWD__, CHILD=__CHILD__, LONG=__LONG__;
const PAGES=['overview','workspace','attention','reader','processes','files','settings','appearance'], WIDTHS=[1440,1024,768,390,320];
const checks=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,label){for(let i=0;i<300;i++){const found=await test();if(found)return found;await pause(50);}throw new Error('Timed out: '+label);}
function check(value,label){if(!value)throw new Error(label);checks.push(label);}
async function sessions(){return (await(await fetch('/api/sessions',{cache:'no-store'})).json()).sessions;}
// Resizes the viewport; a shot also saves a screenshot.
async function capture(name,width,shot=true){document.body.dataset.capture=JSON.stringify({name,width,shot});await until(()=>document.body.dataset.captured===name,'capture '+name);}
function fits(element){const box=element.getBoundingClientRect();return box.width>0&&box.left>=0&&box.right<=innerWidth+1&&box.top>=0&&box.bottom<=innerHeight+1;}
function noSideScroll(){const page=document.querySelector('#main > .page:not([hidden])');return document.documentElement.scrollWidth<=innerWidth+1&&$('main').scrollWidth<=$('main').clientWidth+1&&page.scrollWidth<=page.clientWidth+1;}
function enter(target,key){target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
function address(path){$('directory-address').click();$('directory-path').value=path;enter($('directory-path'),'Enter');}
function same(a,b){return a.toLowerCase().replace(/^\\\\\?\\/,'')===b.toLowerCase();}
function launcher(){return document.querySelector('dialog.launcher[open]');}
function go(page){document.querySelector('.navigation-item[data-page="'+page+'"]').click();return until(()=>!$('page-'+page).hidden,'page '+page);}
function focused(){return document.querySelector('#panes > .pane.focused:not([hidden])');}
// A shown pane that follows output keeps its live cursor in view.
function following(pane){const cursor=pane.querySelector('[id$="terminal-lines"] .cursor'),scroll=pane.querySelector('[id$="terminal-scroll"]');if(!cursor||pane.querySelector('[id$="follow"]').textContent!=='Following output')return false;const a=cursor.getBoundingClientRect(),b=scroll.getBoundingClientRect();return a.top>=b.top-1&&a.bottom<=b.bottom+1;}
function shownPanes(){return [...$('panes').children].filter(pane=>!pane.hidden&&pane.querySelector('[id$="terminal-scroll"]').clientWidth>0);}
function menuItem(menu,label){return [...menu.querySelectorAll('.menu-item')].find(item=>item.textContent.includes(label));}
function pasteMarkdown(value){const data=new DataTransfer();data.setData('text/plain',value);$('page-reader').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}
function publish(report){document.body.dataset.probeResult=btoa(unescape(encodeURIComponent(JSON.stringify(report))));}
async function open(folder,count){
  $('new').click();await until(launcher,'launcher');$('launch-folder').value=folder;
  launcher().querySelector('.dlg-foot .btn.primary').click();
  await until(async()=>(await sessions()).length===count&&!launcher()&&focused()?.dataset.status==='Controlling','terminal '+count);
}
async function main(){
  await until(()=>$('connection-status').textContent==='Connected'&&!$('empty-state').hidden,'empty workspace');
  check((await sessions()).length===0&&document.querySelectorAll('#navigation-projects .navigation-project[data-workspace]').length===1,'fresh server has one empty workspace');
  await capture('empty-desktop',1280);check(fits($('empty-new')),'desktop empty action fits');

  $('empty-new').click();await until(launcher,'launcher');
  check(same($('launch-folder').value,CWD),'launcher starts in the server folder');
  launcher().querySelector('.folder-row > button:last-child').click();
  await until(()=>$('directory-dialog').open&&!$('directory-create').disabled,'picker initial folder');
  check($('directory-breadcrumbs').lastElementChild.textContent==='sample-workspace'&&$('directory-path').hidden,'picker shows current folder as breadcrumbs');
  check($('directory-list').querySelectorAll('.directory-row').length===3,'picker lists owned child folders');
  $('directory-filter').value='reports';$('directory-filter').dispatchEvent(new Event('input',{bubbles:true}));
  check($('directory-list').querySelectorAll('.directory-row').length===1&&$('directory-message').textContent==='1 of 3','folder filter narrows real results');
  let row=$('directory-list').querySelector('.directory-row');row.click();
  check(row.getAttribute('aria-selected')==='true'&&$('directory-selected').textContent==='reports & notes','single click selects child');
  await capture('picker-desktop',1280);
  row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
  await until(()=>$('directory-breadcrumbs').lastElementChild.textContent==='reports & notes','double-click folder navigation');
  check($('directory-list').textContent.includes('no subfolders'),'empty folder remains selectable');
  $('directory-back').click();await until(()=>$('directory-breadcrumbs').lastElementChild.textContent==='sample-workspace','back navigation');
  $('directory-forward').click();await until(()=>$('directory-breadcrumbs').lastElementChild.textContent==='reports & notes','forward navigation');
  $('directory-up').click();await until(()=>$('directory-breadcrumbs').lastElementChild.textContent==='sample-workspace','up navigation');
  await capture('picker-mobile',320);check(fits($('directory-dialog'))&&fits($('directory-create')),'picker and its action fit at 320px');
  await capture('picker-restored',1280);
  address(CWD+'\\missing-folder');await until(()=>!$('directory-error').hidden,'invalid address');
  check($('directory-error-text').textContent.length>0&&$('directory-dialog').open,'invalid location shows inline error');
  await capture('picker-error',1280);
  address(CHILD);await until(()=>$('directory-breadcrumbs').lastElementChild.textContent==='reports & notes'&&!$('directory-create').disabled,'typed valid address');
  $('directory-create').click();await until(()=>!$('directory-dialog').open,'picker closes');
  check(launcher()&&same($('launch-folder').value,CHILD),'picked folder returns to the launcher without opening a terminal');
  check((await sessions()).length===0,'choosing a folder alone starts nothing');
  await capture('launcher-desktop',1280);
  launcher().querySelector('.dlg-foot .btn.primary').click();
  await until(async()=>(await sessions()).length===1&&$('pane').dataset.status==='Controlling','terminal created');
  check(same((await sessions())[0].cwd,CHILD),'selected child reaches native process');
  await capture('terminal-desktop',1280);check(fits($('pane-menu')),'terminal actions fit desktop');

  await go('settings');$('settings-tab-terminal').click();
  const panel=$('settings-panel-terminal'),step=label=>panel.querySelector('[aria-label="'+label+' terminal text"]').click();
  step('Larger');await until(()=>$('settings-font-value').textContent==='14 px','larger');check(true,'font size increases');
  step('Smaller');await until(()=>$('settings-font-value').textContent==='13 px','smaller');check(true,'font size decreases');
  step('Larger');const footer=document.querySelector('#page-settings .prefs-footer');await until(()=>!footer.hidden,'unsaved bar');
  check(getComputedStyle(document.documentElement).getPropertyValue('--font-size').trim()!=='14px','terminals wait for Save');
  [...footer.querySelectorAll('button')].find(button=>button.textContent==='Save changes').click();
  await until(()=>footer.hidden&&getComputedStyle(document.documentElement).getPropertyValue('--font-size').trim()==='14px','saved font');
  check(true,'saved font size reaches the terminals');
  await go('appearance');await until(()=>$('appearance-font-value')?.textContent==='14 px','appearance');check(true,'Appearance shows the saved size');

  await go('reader');await until(()=>document.querySelector('#reader-content .reader-root'),'reader');
  check(document.querySelector('.reader-empty:not([hidden]) h2')?.textContent==='No replies yet','Reader starts empty');
  const markdown='# Fixture summary\n\n## Checks\n\n- **Safe** Markdown\n- Searchable material\n\n\x60\x60\x60js\nconst answer = 42;\n\x60\x60\x60\n\n<script>window.__injected=true</script>';
  pasteMarkdown(markdown);
  const prose=()=>document.querySelector('.reader-prose'),readerRoot=()=>document.querySelector('.reader-root');
  await until(()=>readerRoot().dataset.panel==='detail'&&prose().querySelector('h1')?.textContent==='Fixture summary','pasted document');
  check(true,'pasted Markdown renders headings');
  check(prose().querySelector('strong')?.textContent==='Safe'&&prose().querySelector('code')?.textContent.includes('answer'),'Reader renders emphasis and code');
  check(!window.__injected&&!prose().querySelector('script'),'Reader leaves HTML inert');
  const actions=document.querySelector('[aria-label="Reply actions"]');actions.click();
  const menu=await until(()=>document.querySelector('.menu[aria-label="Reply actions"]'),'reply menu');
  menuItem(menu,'On this page').click();
  const outline=await until(()=>document.querySelector('.menu[aria-label="On this page"]'),'outline');
  check(outline.querySelectorAll('.menu-item').length===2,'outline follows Markdown headings');
  menuItem(outline,'Checks').click();
  actions.click();menuItem(await until(()=>document.querySelector('.menu[aria-label="Reply actions"]'),'reply menu again'),'Find in reply').click();
  await until(()=>document.activeElement===$('reader-find'),'find field');
  $('reader-find').value='Searchable';$('reader-find').dispatchEvent(new Event('input',{bubbles:true}));
  check(document.querySelector('.reader-find-count').textContent.includes('1'),'Reader searches within the document');
  await capture('reader-desktop',1280);check(fits(document.querySelector('.reader-detail')),'Reader document fits desktop');
  document.querySelector('.reader-back').click();
  await until(()=>readerRoot().dataset.panel==='list','list');
  check(document.querySelectorAll('.reader-index .reader-reply').length===1,'document list retains pasted Markdown');
  document.querySelector('.reader-index .reader-reply').click();await until(()=>readerRoot().dataset.panel==='detail','reopen');check(true,'document opens from list');
  await capture('reader-mobile',390);check(fits(document.querySelector('.reader-back'))&&noSideScroll(),'Reader remains reachable on mobile');

  for(const page of PAGES){
    await go(page);
    for(const width of WIDTHS){
      await capture(page+'-'+width,width,width===1440||width===390);
      check(noSideScroll()&&fits(document.querySelector('#page-'+page+' .topbar')),page+' fits at '+width+'px');
    }
  }

  await go('workspace');await capture('long-paths',1280,false);
  await open(LONG,2);
  await until(()=>$('workspace-context').textContent.includes('and-a-nested-segment'),'second terminal context');
  const twoPaneNodes=[...$('panes').children];
  check(LONG.length>CHILD.length&&$('workspace-context').textContent.includes('and-a-nested-segment'),'two terminals have unequal workspace paths');
  check(document.querySelectorAll('.header-path-slot .header-context-sizer[aria-hidden="true"]').length===2,'workspace header reserves both actual paths');
  for(const width of [1440,1024,768,390,320]){
    await capture('two-path-context-'+width,width,false);
    const dimensions=()=>({header:document.querySelector('#page-workspace .topbar').getBoundingClientRect().height,scroll:focused().querySelector('[id$="terminal-scroll"]').clientHeight});
    $('pane-tabs').children[0].click();
    await until(()=>focused()===twoPaneNodes[0]&&$('workspace-context').textContent.includes('reports & notes'),'short path focus at '+width+'px');
    await until(()=>{const scroll=focused().querySelector('[id$="terminal-scroll"]');return scroll.scrollWidth<=scroll.clientWidth+1;},'short pane refits at '+width+'px');
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const base=dimensions();
    for(let round=0;round<3;round++)for(const index of [1,0]){
      $('pane-tabs').children[index].click();
      await until(()=>focused()===twoPaneNodes[index]&&$('pane-tabs').children[index].getAttribute('aria-pressed')==='true','two-path pane '+index+' at '+width+'px');
      await until(()=>{const scroll=focused().querySelector('[id$="terminal-scroll"]');return scroll.scrollWidth<=scroll.clientWidth+1;},'context pane refits at '+width+'px');
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const current=dimensions();
      check(Math.abs(current.header-base.header)<1&&Math.abs(current.scroll-base.scroll)<1,'workspace header and terminal height stay stable at '+width+'px, pane '+index+', round '+round+' '+JSON.stringify({base,current}));
      check([...$('panes').children].every((pane,paneIndex)=>pane===twoPaneNodes[paneIndex]),'pane DOM survives context focus at '+width+'px, pane '+index+', round '+round);
    }
  }
  await capture('restore-grid-after-context-switching',1280,false);
  for(let count=3;count<=4;count++)await open(LONG,count);
  check($('new').getAttribute('aria-disabled')==='true','a full workspace disables New terminal');
  // Long history in every pane, so a lost follow position cannot hide behind a short screen.
  // Wait for the grid's native size first: ConPTY repaints earlier rows when a later resize keeps the cursor in view.
  const {state,currentWorkspace}=await import('/model.js'),sizes=()=>new Set(currentWorkspace().sessions.map(id=>{const term=state.snapshots.get(id)?.terminal;return term&&term.cols+'x'+term.rows;}));
  await until(()=>[...$('panes').children].every(pane=>pane.dataset.status==='Controlling')&&sizes().size===1&&!sizes().has(undefined),'every pane controls the settled grid size');
  for(const pane of [...$('panes').children]){const data=new DataTransfer();data.setData('text/plain','history\r');pane.querySelector('[id$="keyboard"]').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}
  await until(()=>[...$('panes').children].every(pane=>pane.querySelector('[id$="terminal-lines"]').textContent.includes('HISTORY_READY')),'history in every pane');
  for(const width of [390,320]){
    await capture('switch-'+width,width);
    for(let round=0;round<3;round++){
      for(let index=0;index<$('pane-tabs').children.length;index++){const tab=$('pane-tabs').children[index];
        tab.click();await until(()=>$('pane-tabs').children[index]?.getAttribute('aria-pressed')==='true'&&focused()===$('panes').children[index],'pane '+index);
        const pane=focused(),path=pane.querySelector('[id$="terminal-path"]').parentElement,scroll=pane.querySelector('[id$="terminal-scroll"]');
        // The terminal refits to the newly shown pane; its long path is clipped by its strip.
        await until(()=>scroll.scrollWidth<=scroll.clientWidth+1&&following(pane),'pane '+index+' refits and follows at '+width+'px');
        if(!(noSideScroll()&&fits(pane.querySelector('[id$="pane-header"]'))&&path.getBoundingClientRect().right<=innerWidth+1)){const box=node=>JSON.stringify(node.getBoundingClientRect());throw new Error('pane '+index+' overflows at '+width+'px: '+JSON.stringify({side:noSideScroll(),doc:document.documentElement.scrollWidth,main:[$('main').scrollWidth,$('main').clientWidth],header:box(pane.querySelector('[id$="pane-header"]')),path:box(path),viewport:[innerWidth,innerHeight]}));}
      }
    }
    check(true,'repeated pane switching keeps long paths inside '+width+'px');
  }
  await capture('terminal-mobile',390);
  await capture('terminal-wide-size',1440,false);
  await until(()=>shownPanes().length===4&&shownPanes().every(following),'panes follow output after the layout changes');
  check(noSideScroll(),'four panes share the desktop and keep following output');
  await capture('terminal-wide',1440);
  check(window.__probeErrors.length===0,'no browser runtime errors');
  publish({pass:true,checks,errors:window.__probeErrors});
}
main().catch(error=>publish({pass:false,checks,error:String(error?.stack||error),errors:window.__probeErrors,state:{connection:$('connection-status')?.textContent,picker:$('directory-dialog')?.open,launcher:Boolean(launcher()),page:document.querySelector('#main > .page:not([hidden])')?.id,dock:$('dock')?.textContent}}));
`;

await mkdir(childFolder,{recursive:true});await mkdir(resolve(cwd,'src'),{recursive:true});await mkdir(longFolder,{recursive:true});await mkdir(screenshots,{recursive:true});
await copyFile(resolve(binaries,'webterminal.exe'),resolve(runRoot,'webterminal.exe'));
await copyFile(resolve(binaries,'perf_fixture.exe'),resolve(runRoot,'perf_fixture.exe'));
let child,proxy,lastCapture='';
try{
  const port=await freePort(),env={},settings=resolve(runRoot,'settings.json');
  for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  child=spawn(resolve(runRoot,'webterminal.exe'),['--port',String(port),'--cwd',cwd,'--shell',quote(resolve(runRoot,'perf_fixture.exe')),'--config',settings],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await ready(port,child);proxy=await proxyFor(port,harness.replace('__CWD__',JSON.stringify(cwd)).replace('__CHILD__',JSON.stringify(childFolder)).replace('__LONG__',JSON.stringify(longFolder)));
  const report=await chromeProbe(await findChrome(),'http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome'),'workbenchStage',async({protocol,evaluate})=>{
    const capture=await evaluate('document.body?.dataset.capture||""');if(!capture||capture===lastCapture)return;
    lastCapture=capture;const {name,width,shot}=JSON.parse(capture);
    await protocol('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    if(shot)await writeFile(resolve(screenshots,name+'.png'),Buffer.from((await protocol('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await evaluate('document.body.dataset.captured='+JSON.stringify(name));
  });
  assert.equal(report.pass,true,JSON.stringify(report));assert.equal(proxy.stats.upstreamErrors,0,'Asset GET failures');
  assert.equal(JSON.parse(await readFile(settings,'utf8')).settings.fontSize,14,'Saved font size reaches the settings file');
  await writeFile(resolve(screenshots,'verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({pass:true,checks:report.checks.length,screenshots}));
}finally{await stopProxy(proxy);await stopChild(child);await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
