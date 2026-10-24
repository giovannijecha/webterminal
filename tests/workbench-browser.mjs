// Launcher and folder picker, Settings, every page at four desktop sizes and
// pane focus with long paths in a full grid, through native Chrome.
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
// Long enough to truncate the one-line context and Overview paths without
// exceeding the native process working-directory limit in the runner's
// longer checkout path.
const longFolder=resolve(cwd,'long-header-context','and-a-nested-segment');
const screenshots=resolve(scratch,'browser-qa-workbench');
const binaries=resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(root,'target/debug'));

const harness=String.raw`
const $=id=>document.getElementById(id), CWD=__CWD__, CHILD=__CHILD__, LONG=__LONG__;
const PAGES=['overview','workspace','processes','files','settings'], SIZES=[[1920,1080],[1440,900],[1366,768],[1280,720]];
const checks=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,label){for(let i=0;i<300;i++){const found=await test();if(found)return found;await pause(50);}throw new Error('Timed out: '+label);}
function check(value,label){if(!value)throw new Error(label);checks.push(label);}
async function sessions(){return (await(await fetch('/api/sessions',{cache:'no-store'})).json()).sessions;}
// Resizes the viewport; a shot also saves a screenshot.
async function capture(name,width,shot=true,height=900){document.body.dataset.capture=JSON.stringify({name,width,height,shot});await until(()=>document.body.dataset.captured===name,'capture '+name);}
function fits(element){const box=element.getBoundingClientRect();return box.width>0&&box.left>=0&&box.right<=innerWidth+1&&box.top>=0&&box.bottom<=innerHeight+1;}
function noSideScroll(){const page=document.querySelector('#main > .page:not([hidden])');return document.documentElement.scrollWidth<=innerWidth+1&&$('main').scrollWidth<=$('main').clientWidth+1&&page.scrollWidth<=page.clientWidth+1;}
function enter(target,key){target.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
function address(path){$('directory-address').click();$('directory-path').value=path;enter($('directory-path'),'Enter');}
function same(a,b){return a.toLowerCase().replace(/^\\\\\?\\/,'')===b.toLowerCase();}
function launcher(){return document.querySelector('dialog.launcher[open]');}
// The terminals page is the selected workspace's row; other pages have their own items.
function go(page){document.querySelector(page==='workspace'?'#navigation-projects .navigation-workspace-row .navigation-item[aria-current], #navigation-projects .navigation-workspace-row .navigation-item':'#sidebar [data-page="'+page+'"]').click();return until(()=>!$('page-'+page).hidden,'page '+page);}
function focused(){return document.querySelector('#panes > .pane.focused:not([hidden])');}
// A shown pane that follows output keeps its live cursor in view.
function following(pane){const cursor=pane.querySelector('[id$="terminal-lines"] .cursor'),scroll=pane.querySelector('[id$="terminal-scroll"]');if(!cursor||pane.querySelector('[id$="follow"]').textContent!=='Following output')return false;const a=cursor.getBoundingClientRect(),b=scroll.getBoundingClientRect();return a.top>=b.top-1&&a.bottom<=b.bottom+1;}
function shownPanes(){return [...$('panes').children].filter(pane=>!pane.hidden&&pane.querySelector('[id$="terminal-scroll"]').clientWidth>0);}
function menuItem(menu,label){return [...menu.querySelectorAll('.menu-item')].find(item=>item.textContent.includes(label));}
// A click on a pane focuses it. The release matters: a press alone holds the
// renderer still for a text selection.
function choose(pane){const scroll=pane.querySelector('[id$="terminal-scroll"]');for(const type of ['pointerdown','pointerup'])scroll.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,button:0}));}
function publish(report){document.body.dataset.probeResult=btoa(unescape(encodeURIComponent(JSON.stringify(report))));}
async function open(folder,count){
  $('new').click();await until(launcher,'launcher');$('launch-folder').value=folder;
  launcher().querySelector('.dlg-foot .btn.primary').click();
  await until(async()=>{
    const error=launcher()?.querySelector('.dlg-error:not([hidden])');
    if(error)throw new Error('Terminal launch failed: '+error.textContent);
    return (await sessions()).length===count&&!launcher()&&focused()?.dataset.status==='Controlling';
  },'terminal '+count);
}
async function main(){
  await until(()=>$('connection-status').textContent==='Connected'&&!$('empty-state').hidden,'empty workspace');
  check((await sessions()).length===0&&document.querySelectorAll('#navigation-projects .navigation-project[data-workspace]').length===1,'fresh server has one empty workspace');
  await capture('empty-desktop',1280);check(fits($('empty-new')),'desktop empty action fits');

  const {state:connectionState}=await import('/model.js'), {renderSidebar}=await import('/sidebar.js');
  const originalConnection={connected:connectionState.connected,hello:connectionState.hello,stopping:connectionState.stopping};
  try{
    for(const width of [1280,1920]){
      Object.assign(connectionState,originalConnection);renderSidebar();await capture('footer-connected-'+width,width,false);
      const baseline=$('sidebar').getBoundingClientRect(),mainLeft=$('main').getBoundingClientRect().left,footerHeight=document.querySelector('.sb-foot').getBoundingClientRect().height;
      for(const [name,hello,stopping] of [['connecting',null,false],['reconnecting',originalConnection.hello,false],['stopped',originalConnection.hello,true]]){
        Object.assign(connectionState,{connected:false,hello,stopping});renderSidebar();await capture('footer-'+name+'-'+width,width,true);
        const sidebar=$('sidebar').getBoundingClientRect(),settings=$('settings-button').getBoundingClientRect();
        check(Math.abs(sidebar.width-baseline.width)<.5,name+' keeps sidebar width at '+width+'px: '+sidebar.width+' vs '+baseline.width);
        check(settings.right<=sidebar.right-1&&settings.left>=sidebar.left,name+' keeps Settings inside the sidebar');
        check($('main').getBoundingClientRect().left===mainLeft&&noSideScroll(),name+' leaves the page position and width unchanged');
        check(document.querySelector('.sb-foot').getBoundingClientRect().height===footerHeight,name+' keeps footer height stable');
        check(document.querySelector('.server-text').title.includes($('uptime').textContent),name+' exposes the complete connection detail');
      }
    }
  }finally{Object.assign(connectionState,originalConnection);renderSidebar();}
  await capture('footer-restored',1280,false);

  localStorage.setItem('webterminal.recentFolders',JSON.stringify(['\\\\?\\'+CWD,CWD,CWD.toLowerCase().replaceAll('\\','/')+'/',CHILD,'\\\\?\\'+CHILD,LONG]));

  $('empty-new').click();await until(launcher,'launcher');
  const {openLauncher:reopenLauncher}=await import('/launcher.js');
  const firstLauncher=launcher();
  firstLauncher.close();
  const reopened=reopenLauncher();
  check(reopenLauncher()===reopened,'repeated open while the previous dialog closes reuses one pending launcher');
  await until(()=>launcher()&&launcher()!==firstLauncher,'launcher reopens while its close event is pending');
  check(document.querySelectorAll('dialog.launcher[open]').length===1,'a closing launcher does not suppress the next open');
  launcher().querySelector('button[value="cancel"]').click();
  await reopened;
  check(!launcher(),'Cancel does not reveal an extra queued launcher');
  reopenLauncher();await until(launcher,'launcher after Cancel');
  check(same($('launch-folder').value,CWD),'launcher starts in the server folder');
  launcher().querySelector('.folder-row > button:first-of-type').click();
  const recents=document.querySelector('[role="menu"][aria-label="Recent folders"]');
  const recentItems=[...recents.querySelectorAll('.menu-item')];
  await capture('recent-folders-deduplicated',1280);
  check(recentItems.length===3,'recent menu collapses saved verbatim, case and separator aliases');
  check(fits(recents)&&recentItems.every(fits),'recent menu and every folder stay inside the viewport');
  check(JSON.parse(localStorage.getItem('webterminal.recentFolders')).length===3,'reading recent folders repairs the saved history');
  check(recentItems.every(item=>item.title&&item.textContent.endsWith(item.title)),'truncated recent paths expose their complete target');
  check(recentItems.map(item=>item.textContent.split(' — ')[0]).join('|')==='sample-workspace|reports & notes|and-a-nested-segment','long recent paths show their distinguishing folder name first');
  check(!recentItems.some(item=>item.title.startsWith('\\\\?\\')),'recent paths use ordinary Windows spelling');
  enter(recents,'Home');document.activeElement.click();
  check(same($('launch-folder').value,CWD),'a recent folder restores the complete input path');
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
  await capture('picker-compact',1280,true,720);check(fits($('directory-dialog'))&&fits($('directory-create')),'picker and its action fit at 1280x720');
  await capture('picker-restored',1280);
  address(CWD+'\\missing-folder');await until(()=>!$('directory-error').hidden,'invalid address');
  check($('directory-error-text').textContent.length>0&&$('directory-dialog').open,'invalid location shows inline error');
  await capture('picker-error',1280);
  address(CHILD);await until(()=>$('directory-breadcrumbs').lastElementChild.textContent==='reports & notes'&&!$('directory-create').disabled,'typed valid address');
  $('directory-create').click();await until(()=>!$('directory-dialog').open,'picker closes');
  check(launcher()&&same($('launch-folder').value,CHILD),'picked folder returns to the launcher without opening a terminal');
  launcher().querySelector('.folder-row > button:last-child').click();
  await until(()=>$('directory-dialog').open&&!$('directory-create').disabled,'picker reopens at current input');
  check($('directory-breadcrumbs').lastElementChild.textContent==='reports & notes','Browse reuses the folder currently in the launcher');
  $('directory-dialog').querySelector('button[value="cancel"]').click();await until(()=>!$('directory-dialog').open,'picker returns to launcher');
  check((await sessions()).length===0,'choosing a folder alone starts nothing');
  await capture('launcher-desktop',1280);
  launcher().querySelector('.dlg-foot .btn.primary').click();
  await until(async()=>(await sessions()).length===1&&$('pane').dataset.status==='Controlling','terminal created');
  check(same((await sessions())[0].cwd,CHILD),'selected child reaches native process');
  await capture('terminal-desktop',1280);check(fits($('pane-menu')),'terminal actions fit desktop');

  await go('settings');
  (await until(()=>$('settings-tab-terminal'),'settings tabs')).click();
  const panel=$('settings-panel-terminal'),step=label=>panel.querySelector('[aria-label="'+label+' terminal text"]').click();
  step('Larger');await until(()=>$('settings-font-value').textContent==='14 px','larger');check(true,'font size increases');
  step('Smaller');await until(()=>$('settings-font-value').textContent==='13 px','smaller');check(true,'font size decreases');
  step('Larger');const footer=document.querySelector('#page-settings .prefs-footer');await until(()=>!footer.hidden,'unsaved bar');
  check(getComputedStyle(document.documentElement).getPropertyValue('--font-size').trim()!=='14px','terminals wait for Save');
  [...footer.querySelectorAll('button')].find(button=>button.textContent==='Save changes').click();
  await until(()=>footer.hidden&&getComputedStyle(document.documentElement).getPropertyValue('--font-size').trim()==='14px','saved font');
  check(true,'saved font size reaches the terminals');
  await go('overview');await go('settings');
  await until(()=>$('settings-tab-terminal').getAttribute('aria-selected')==='true'&&$('settings-font-value').textContent==='14 px','settings return');
  check(true,'Settings reopens on the Terminal tab with the saved size');
  check(!document.querySelector('[data-page="reader"],[data-page="appearance"],#page-reader,#page-appearance'),'retired pages have no navigation or view');
  (await import('/model.js')).go('reader');
  await until(()=>!$('page-workspace').hidden,'unknown page fallback');
  check(document.querySelectorAll('#main > .page:not([hidden])').length===1,'an unknown page falls back to the terminals');

  for(const page of PAGES){
    await go(page);
    for(const [width,height] of SIZES){
      await capture(page+'-'+width+'x'+height,width,true,height);
      check(noSideScroll()&&fits(document.querySelector('#page-'+page+' .topbar')),page+' fits at '+width+'x'+height);
      const root=document.querySelector({overview:'.overview',processes:'.process-root',files:'.files-layout',settings:'.prefs-root'}[page]||'#panes');
      if(page!=='workspace'){
        const content=$(''+page+'-content'),style=getComputedStyle(content),available=content.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
        check(Math.abs(root.getBoundingClientRect().width-available)<1,page+' uses its available desktop width at '+width+'x'+height);
      }
    }
  }

  await go('workspace');await capture('long-paths',1280,false);
  await open(LONG,2);
  await until(()=>$('workspace-context').textContent.includes('and-a-nested-segment'),'second terminal context');
  const twoPaneNodes=[...$('panes').children];
  check(LONG.length>CHILD.length&&$('workspace-context').title.includes('and-a-nested-segment'),'two terminals have unequal workspace paths');
  check(getComputedStyle($('workspace-context')).whiteSpace==='nowrap','workspace context keeps one line; its tooltip keeps the whole path');
  for(const [width,height] of SIZES){
    await capture('two-path-context-'+width+'x'+height,width,false,height);
    check($('workspace-title').scrollWidth<=$('workspace-title').clientWidth,'workspace title '+JSON.stringify($('workspace-title').textContent)+' is not truncated at '+width+'px');
    const dimensions=()=>({header:document.querySelector('#page-workspace .topbar').getBoundingClientRect().height,scroll:focused().querySelector('[id$="terminal-scroll"]').clientHeight});
    choose(twoPaneNodes[0]);
    await until(()=>focused()===twoPaneNodes[0]&&$('workspace-context').textContent.includes('reports & notes'),'short path focus at '+width+'px');
    await until(()=>{const scroll=focused().querySelector('[id$="terminal-scroll"]');return scroll.scrollWidth<=scroll.clientWidth+1;},'short pane refits at '+width+'px');
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const bases=[dimensions()];
    for(let round=0;round<3;round++)for(const index of [1,0]){
      choose(twoPaneNodes[index]);
      await until(()=>focused()===twoPaneNodes[index],'two-path pane '+index+' at '+width+'px');
      await until(()=>{const scroll=focused().querySelector('[id$="terminal-scroll"]');return scroll.scrollWidth<=scroll.clientWidth+1;},'context pane refits at '+width+'px');
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const current=dimensions(),base=bases[index]||(bases[index]=current),context=$('workspace-context').getBoundingClientRect(),bar=document.querySelector('#page-workspace .topbar').getBoundingClientRect();
      check(Math.abs(current.header-bases[0].header)<1&&Math.abs(current.scroll-base.scroll)<1,'workspace header and terminal height stay stable at '+width+'px, pane '+index+', round '+round+' '+JSON.stringify({base,current}));
      check(context.right<=bar.right+1,'workspace context stays inside its header at '+width+'px');
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
  // The smallest desktop sizes: every pane of a full grid keeps its header, path and live cursor in place.
  for(const [width,height] of [[1280,720],[1366,768]]){
    await capture('switch-'+width+'x'+height,width,true,height);
    check([...$('panes').children].every(pane=>{const follow=pane.querySelector('[id$="follow"]');return follow.getBoundingClientRect().height<=16&&getComputedStyle(follow,'::before').content!=='none';}),'every pane footer keeps its live status on one line at '+width+'px');
    for(let round=0;round<3;round++){
      for(const pane of [...$('panes').children]){
        choose(pane);await until(()=>focused()===pane,'pane focus at '+width+'px');
        const path=pane.querySelector('[id$="terminal-path"]').parentElement,scroll=pane.querySelector('[id$="terminal-scroll"]');
        // The terminal keeps its fitted size; its long path is clipped by its strip.
        await until(()=>scroll.scrollWidth<=scroll.clientWidth+1&&following(pane),'pane refits and follows at '+width+'px');
        const header=pane.querySelector('[id$="pane-header"]').getBoundingClientRect(),strip=path.getBoundingClientRect(),box=pane.getBoundingClientRect();
        if(!(noSideScroll()&&fits(pane.querySelector('[id$="pane-header"]'))&&strip.right<=box.right+1&&header.right<=box.right+1)){const show=node=>JSON.stringify(node.getBoundingClientRect());throw new Error('pane overflows at '+width+'px: '+JSON.stringify({side:noSideScroll(),doc:document.documentElement.scrollWidth,main:[$('main').scrollWidth,$('main').clientWidth],header:show(pane.querySelector('[id$="pane-header"]')),path:show(path),pane:show(pane),viewport:[innerWidth,innerHeight]}));}
      }
    }
    check(shownPanes().length===4,'a full workspace shows all four panes at '+width+'x'+height);
    check(true,'repeated pane focus keeps long paths inside each pane at '+width+'x'+height);
  }
  await capture('terminal-wide-size',1440,false);
  await until(()=>shownPanes().length===4&&shownPanes().every(following),'panes follow output after the layout changes');
  check(noSideScroll(),'four panes share the desktop and keep following output');
  await capture('terminal-wide',1440);
  // Overview, Processes and Dropped files describe the live grid, never sample data.
  await go('overview');
  const inventory=()=>[...document.querySelectorAll('#overview-content tr.inventory-row')],bulk=()=>document.querySelector('#overview-content .inventory-bulk');
  await until(()=>inventory().length===4,'overview rows');
  inventory()[0].querySelector('input[type="checkbox"]').click();
  await until(()=>!bulk().hidden&&bulk().textContent.includes('1 selected'),'one terminal selected');
  const search=$('inventory-search');search.value='and-a-nested-segment';search.dispatchEvent(new Event('input',{bubbles:true}));
  await until(()=>inventory().length===3,'search narrows the overview');
  check(document.querySelector('#overview-content .inventory-hidden:not([hidden])')?.textContent.includes('1 terminal is hidden by the search.'),'Overview counts the terminal the search hides');
  check(bulk().querySelector('.inventory-bulk-detail').textContent.includes('1 hidden by the filter'),'the bulk bar keeps the hidden selection in its count');
  await capture('overview-hidden-selection',1440);
  const table=document.querySelector('#overview-content .inventory-table'),actions=inventory()[0].querySelector('.inventory-cell-actions').getBoundingClientRect();
  check(Math.abs(actions.right-table.getBoundingClientRect().right)<=1,'grouped Overview columns fill the table width');
  check(inventory().every(row=>row.querySelector('.inventory-sub').getBoundingClientRect().height<=20),'long Overview paths stay on one truncated line');
  [...bulk().querySelectorAll('button')].find(button=>button.textContent==='Clear').click();
  await until(()=>bulk().hidden,'selection cleared');
  search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));
  await until(()=>inventory().length===4,'search cleared');
  check(true,'clearing the search and selection restores every row');
  await go('processes');
  const items=()=>[...document.querySelectorAll('#processes-content li.process-item')];
  await until(()=>items().length===4,'process rows');
  check(items().every(item=>/^\d+( of \d+)?$/.test(item.querySelector('.process-row .process-count').textContent)),'each terminal row counts its real processes');
  items()[0].querySelector('.process-row').click();
  await until(()=>items()[0].querySelector('.process-row').getAttribute('aria-expanded')==='true'&&items()[0].querySelector('.process-tree .process-node'),'process tree');
  check(items()[0].querySelector('.process-tree').textContent.includes('perf_fixture'),'an expanded row lists the terminal process tree');
  const processPid=items()[0].querySelector('.process-pid').textContent.replace(/\D/g,'');
  await capture('processes-expanded',1440);
  items()[0].querySelector('.process-row').click();
  await until(()=>items()[0].querySelector('.process-row').getAttribute('aria-expanded')==='false'&&!items()[0].querySelector('.process-detail'),'process row collapses');
  const processSearch=$('process-search');
  processSearch.value=processPid;processSearch.dispatchEvent(new Event('input',{bubbles:true}));
  await until(()=>items().length===1&&items()[0].querySelector('.process-row').getAttribute('aria-expanded')==='true','a matching process opens its tree');
  check(items()[0].querySelector('.process-tree').textContent.includes(processPid),'process search exposes its matching PID');
  processSearch.value='';processSearch.dispatchEvent(new Event('input',{bubbles:true}));
  await until(()=>items().every(item=>item.querySelector('.process-row').getAttribute('aria-expanded')==='false'),'clearing process search restores the collapsed trees');
  // A different workspace detaches these terminals. Another view owns the target
  // before Processes explicitly navigates, attaches, measures and claims it.
  const original=currentWorkspace().id,target=currentWorkspace().sessions[0],workspaceActions=await import('/actions.js');
  await workspaceActions.createWorkspace();
  await until(()=>currentWorkspace().id!==original&&!state.attachments.has(target),'empty workspace detaches the original terminals');
  const emptyWorkspace=currentWorkspace().id,watcher=new WebSocket('ws://'+location.host+'/ws'),messages=[];
  watcher.addEventListener('message',event=>messages.push(JSON.parse(event.data)));
  try{
    await new Promise((resolve,reject)=>{watcher.addEventListener('open',resolve,{once:true});watcher.addEventListener('error',reject,{once:true});});
    const hello=await until(()=>messages.find(message=>message.type==='hello'),'other view hello');
    watcher.send(JSON.stringify({op:'attach',id:target,cols:80,rows:24}));
    await until(()=>messages.find(message=>message.type==='snapshot'&&message.id===target&&message.controller===hello.view),'other view controls detached terminal');
    await go('processes');
    const targetRow=()=>document.querySelector('.process-item[data-id="'+target+'"]');
    await until(targetRow,'observing process row');targetRow().querySelector('.process-row').click();
    const claim=await until(()=>[...targetRow().querySelectorAll('button')].find(button=>button.textContent==='Take control'),'process control action');
    await capture('processes-observing',1440);claim.click();
    await until(()=>state.selected===original&&state.snapshots.get(target)?.controller===state.view&&state.attachments.get(target)?.ready&&!$('page-workspace').hidden,'process action attaches and transfers control');
    check((await import('/model.js')).canInput(target),'Processes Take control enables the owning terminal only after attachment and snapshot');
    await until(()=>messages.some(message=>message.id===target&&message.controller===state.view),'previous controller becomes observer');
    check(true,'Processes transfers a terminal from another workspace and another browser view');
    await go('processes');targetRow().querySelector('.process-row').click();
    if(!targetRow().querySelector('.process-actions'))targetRow().querySelector('.process-row').click();
    check([...targetRow().querySelectorAll('.process-actions button')].some(button=>button.textContent.startsWith('Interrupt')&&button.getAttribute('aria-disabled')==='false'),'the claimed process row exposes its guarded Interrupt action');
    await workspaceActions.closeWorkspace(emptyWorkspace);
    await until(()=>!state.workspaces.some(workspace=>workspace.id===emptyWorkspace),'empty fixture workspace removed');
  }finally{watcher.close();}
  await go('files');
  check(document.querySelector('#files-content .files-empty:not([hidden]) h2')?.textContent==='No staged copies','Dropped files starts empty without sample rows');
  const {stageDrop}=await import('/transfers.js'),{paneFor}=await import('/workspace.js');
  await stageDrop(paneFor(target),[new File(['owned first upload'],'review-first.txt',{type:'text/plain'})]);
  await until(()=>state.files.files.some(file=>file.name==='review-first.txt'),'first staged review fixture');
  const firstFile=await until(()=>[...document.querySelectorAll('.files-name')].find(button=>button.textContent==='review-first.txt'),'staged file row');
  firstFile.click();
  const inspector=$('files-inspector');
  await until(()=>!inspector.hidden&&inspector.querySelector('h2').textContent==='review-first.txt','staged file details');
  inspector.querySelector('[data-action="remove"]').focus();
  await stageDrop(paneFor(target),[new File(['owned second upload'],'review-second.txt',{type:'text/plain'})]);
  await until(()=>state.files.files.length===2&&document.querySelectorAll('.files-row').length===2,'second upload refreshes the file list');
  check(inspector.contains(document.activeElement)&&document.activeElement.dataset.action==='remove'&&inspector.querySelector('h2').textContent==='review-first.txt','incoming uploads preserve the selected details and keyboard focus');
  for(const [width,height] of [[1280,720],[1920,1080]]){
    await capture('files-inspector-'+width+'x'+height,width,true,height);
    check(fits(inspector)&&[...inspector.querySelectorAll('button')].every(fits),'staged file details and actions fit at '+width+'x'+height);
    const active=document.activeElement,box=active.getBoundingClientRect(),hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
    check(active===hit||active.contains(hit),'file details keyboard focus is not covered by notifications at '+width+'x'+height);
  }
  inspector.querySelector('[data-action="close"]').click();
  check(inspector.hidden&&document.activeElement.closest('.files-row'),'closing details restores focus to the file list');
  [...document.querySelectorAll('.files-name')].find(button=>button.textContent==='review-first.txt').click();
  await until(()=>!inspector.hidden,'details reopen for removal');
  inspector.querySelector('[data-action="remove"]').click();
  const removal=await until(()=>[...document.querySelectorAll('dialog[open]')].find(dialog=>dialog.querySelector('h2')?.textContent==='Remove staged copy?'),'copy removal confirmation');
  [...removal.querySelectorAll('.dlg-foot button')].find(button=>button.textContent==='Remove staged copy').click();
  await until(()=>state.files.files.length===1&&!state.files.files.some(file=>file.name==='review-first.txt'),'exact staged copy removed');
  check(state.files.files[0].name==='review-second.txt','removing a staged copy preserves the other copy');
  const copy=state.files.files[0];
  await(await import('/connection.js')).ask({op:'remove-copy',id:copy.id,epoch:state.snapshots.get(copy.session).epoch},message=>message.type==='copy-removed'&&message.id===copy.id);
  await until(()=>state.files.files.length===0,'owned upload fixtures removed');
  await go('workspace');
  const {problem,toasts}=await import('/ui.js');
  const terminalHeight=()=>focused().querySelector('[id$="terminal-scroll"]').clientHeight;
  async function toastBaseline(width,height){
    await capture('toast-base-'+width,width,false,height);
    // A pending native resize can still remove a horizontal scrollbar.
    await until(()=>{const scroll=focused().querySelector('[id$="terminal-scroll"]');return scroll.scrollWidth<=scroll.clientWidth+1;},'terminal refits before '+width+'px toast baseline');
    return terminalHeight();
  }
  const base1280=await toastBaseline(1280,720);
  for(let index=0;index<3;index++)problem('Long error '+index,'A detailed local error with a long path: '+('C:\\nested\\folder\\'.repeat(180)));
  await Promise.all([...$('toasts').querySelectorAll('.toast')].flatMap(card=>card.getAnimations()).map(animation=>animation.finished.catch(()=>{})));
  const toastCheck=(label,baseline)=>{
    const cards=[...$('toasts').querySelectorAll('.toast')];
    check(cards.length===3,label+' keeps all three errors');
    check(cards.every(card=>fits(card)&&fits(card.querySelector('button[aria-label^="Dismiss"]'))),label+' keeps every dismiss button reachable');
    check(cards.every(card=>{const body=card.querySelector('.toast-body'),text=body.querySelector('p');return fits(body.querySelector('h2'))&&text.scrollHeight>text.clientHeight&&getComputedStyle(text).overflowY==='auto';}),label+' keeps titles visible and scrolls long error text');
    const first=cards[0].getBoundingClientRect(),second=cards[1].getBoundingClientRect(),gap=(first.bottom+second.top)/2;
    check(gap>first.bottom&&gap<second.top&&document.elementFromPoint(first.left+20,gap)!==$('toasts'),label+' passes pointer events between cards');
    check(terminalHeight()===baseline,label+' leaves terminal geometry unchanged');
  };
  await capture('toast-three-long-1280x720',1280,true,720);toastCheck('1280x720',base1280);
  const base1366=await toastBaseline(1366,768);
  await capture('toast-three-long-1366x768',1366,true,768);toastCheck('1366x768',base1366);
  for(const card of [...$('toasts').querySelectorAll('.toast')])toasts.hide(card);
  await capture('toast-restored',1440,false);
  check(window.__probeErrors.length===0,'no browser runtime errors');
  publish({pass:true,checks,errors:window.__probeErrors});
}
main().catch(error=>publish({pass:false,checks,error:String(error?.stack||error),errors:window.__probeErrors,state:{connection:$('connection-status')?.textContent,picker:$('directory-dialog')?.open,launcher:Boolean(launcher()),page:document.querySelector('#main > .page:not([hidden])')?.id,toasts:$('toasts')?.textContent?.slice(0,200)}}));
`;

await mkdir(childFolder,{recursive:true});await mkdir(resolve(cwd,'src'),{recursive:true});await mkdir(longFolder,{recursive:true});await mkdir(screenshots,{recursive:true});
await copyFile(resolve(binaries,'webterminal.exe'),resolve(runRoot,'webterminal.exe'));
await copyFile(resolve(binaries,'perf_fixture.exe'),resolve(runRoot,'perf_fixture.exe'));
let child,proxy,lastCapture='';
try{
  const port=await freePort(),env={},settings=resolve(runRoot,'settings.json');
  for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  child=spawn(resolve(runRoot,'webterminal.exe'),['--port',String(port),'--cwd',cwd,'--shell',quote(resolve(runRoot,'perf_fixture.exe')),'--config',settings],{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await ready(port,child);proxy=await proxyFor(port,harness.replace('__CWD__',JSON.stringify(cwd)).replace('__CHILD__',JSON.stringify(childFolder)).replace('__LONG__',JSON.stringify(longFolder)),{uploads:true});
  const report=await chromeProbe(await findChrome(),'http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome'),'workbenchStage',async({protocol,evaluate})=>{
    const capture=await evaluate('document.body?.dataset.capture||""');if(!capture||capture===lastCapture)return;
    lastCapture=capture;const {name,width,height,shot}=JSON.parse(capture);
    await protocol('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    if(shot)await writeFile(resolve(screenshots,name+'.png'),Buffer.from((await protocol('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await evaluate('document.body.dataset.captured='+JSON.stringify(name));
  });
  assert.equal(report.pass,true,JSON.stringify({...report,checks:report.checks.length}));assert.equal(proxy.stats.upstreamErrors,0,'Asset GET failures');
  assert.equal(JSON.parse(await readFile(settings,'utf8')).settings.fontSize,14,'Saved font size reaches the settings file');
  await writeFile(resolve(screenshots,'verification.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({pass:true,checks:report.checks.length,screenshots}));
}finally{await stopProxy(proxy);await stopChild(child);await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
