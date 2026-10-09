// Optional browser -> WebSocket -> ConPTY acceptance for installed Codex/Claude.
// Only an owned loopback API returns fixed text. All CLI profiles are disposable.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {copyFile, mkdir, rm, stat} from 'node:fs/promises';
import {join, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeProbe, findChrome, freePort, proxyFor, quote, ready, stopChild, stopProxy} from './cli-browser-support.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const target=resolve(root,'target');
const chrome=await findChrome();
const binDirectory=resolve(process.env.WEBTERMINAL_TEST_BIN_DIR||resolve(target,'debug'));
const binaries={webterminal:resolve(binDirectory,'webterminal.exe'),isolated:resolve(binDirectory,'isolated_cli.exe'),fixture:resolve(binDirectory,'api_fixture.exe')};
const executables={
  codex:process.env.WEBTERMINAL_CODEX_EXE||join(process.env.LOCALAPPDATA||'', 'Programs','OpenAI','Codex','bin','codex.exe'),
  claude:process.env.WEBTERMINAL_CLAUDE_EXE||join(process.env.USERPROFILE||'', '.local','bin','claude.exe'),
};
const selected=process.argv[2];
if(selected&&!['codex','claude'].includes(selected))throw new Error('Use codex or claude');
for(const path of Object.values(binaries))await stat(path);
for(const kind of selected?[selected]:['codex','claude'])await stat(executables[kind]);

const harness=String.raw`
const KIND=__KIND__;
const CWD=__CWD__;
const results=JSON.parse(sessionStorage.getItem('apiBrowserResults')||'[]');
const $=id=>document.getElementById(id);
const text=()=>$('terminal-lines').textContent||'';
function liveText(){
  const shot=window.__snapshotBodies[sessionStorage.getItem('webterminal.active')];
  return (shot?.terminal?.screen||[]).map(line=>line.cells.filter(cell=>cell[1]>0).map(cell=>cell[0]).join('')).join('\n');
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(probe,label,attempts=400){
  for(let i=0;i<attempts;i++){const found=await probe();if(found)return found;await pause(50)}
  throw new Error('Timed out: '+label);
}
function check(value,label){if(!value)throw new Error(label);results.push(label)}
function key(name,code,options={},keyCode=0){
  for(const type of ['keydown','keyup']){
    const event=new KeyboardEvent(type,{key:name,code,bubbles:true,cancelable:true,...options});
    Object.defineProperty(event,'keyCode',{value:keyCode});
    $('keyboard').dispatchEvent(event);
  }
}
function paste(value){
  const transfer=new DataTransfer();transfer.setData('text/plain',value);
  $('keyboard').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
}
async function sessions(){
  const response=await fetch('/api/sessions',{cache:'no-store'});
  if(!response.ok)throw new Error('Sessions HTTP '+response.status);
  return (await response.json()).sessions;
}
async function counts(){return (await (await fetch('/probe-counts',{cache:'no-store'})).json())}
async function create(){
  $('new').click();
  await until(()=>$('directory-dialog').open,'directory dialog');
  $('directory-path').value=CWD;$('directory-go').click();
  await until(()=>!$('directory-create').disabled,'owned working directory');
  $('directory-create').click();
  await until(async()=>(await sessions()).length===1,'CLI session creation');
  await until(()=>$('view-status').textContent==='Controlling','CLI control');
}
function forbidden(){
  const visible=liveText().toLowerCase();
  if(visible.includes('terms of service')||visible.includes('sign in with')||visible.includes('oauth'))throw new Error('Unexpected terms or authentication step; stopped');
  if(KIND==='codex'&&visible.includes('administrator')&&!visible.includes('set up the codex agent sandbox'))throw new Error('Unexpected host setup step; stopped');
}
async function onboarding(){
  let actions=0;
  for(let i=0;i<200;i++){
    forbidden();
    const screen=liveText();
    if(KIND==='codex'){
      if(screen.includes('Trust this folder?')){
        check(CWD.toLowerCase().includes('cli-api-browser-'),'trust prompt is for owned folder');
        key('Enter','Enter',{},13);actions++;await pause(500);continue;
      }
      if(screen.includes('Set up the Codex agent sandbox')){
        key('Escape','Escape',{},27);actions++;
        await until(()=>!liveText().includes('Set up the Codex agent sandbox'),'optional sandbox menu cancellation',100);
        continue;
      }
      if(screen.includes('fixture-model')&&!screen.includes('Trust this folder?')&&!screen.includes('Set up the Codex agent sandbox')){
        await pause(1200);
        if(liveText().includes('fixture-model')&&!liveText().includes('Set up the Codex agent sandbox'))break;
        continue;
      }
    }else{
      if(screen.includes('Choose the text style')){key('Enter','Enter',{},13);actions++;await pause(700);continue}
      if(screen.includes('Detected a custom API key')){
        key('ArrowUp','ArrowUp',{},38);key('Enter','Enter',{},13);actions++;await pause(700);continue;
      }
      if(screen.includes('Security notes:')&&screen.includes('Press Enter to continue')){key('Enter','Enter',{},13);actions++;await pause(700);continue}
      if(screen.includes('Accessing workspace:')&&screen.includes('Yes, I trust this folder')){
        check(CWD.toLowerCase().includes('cli-api-browser-'),'Claude trust prompt is for owned folder');
        key('ArrowDown','ArrowDown',{},40);key('Enter','Enter',{},13);actions++;await pause(700);continue;
      }
      if(screen.includes('fixture-model')&&!screen.includes('Detected a custom API key')&&!screen.includes('Accessing workspace:'))break;
    }
    await pause(100);
    if(i===199)throw new Error('CLI did not reach a recognized local composer');
  }
  forbidden();
  check(liveText().includes('fixture-model')&&!liveText().includes('Set up the Codex agent sandbox'),'real '+KIND+' composer rendered');
  check(actions<=5,'only known local onboarding steps used');
}
function observer(id){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket('ws://'+location.host+'/ws');
    let hello,snapshot;
    ws.onopen=()=>ws.send(JSON.stringify({op:'attach',id,cols:80,rows:24}));
    ws.onmessage=event=>{
      const m=JSON.parse(event.data);
      if(m.type==='hello')hello=m;
      if(m.type==='snapshot'&&m.id===id)snapshot=m;
      if(hello&&snapshot)resolve({ws,hello,snapshot});
    };
    ws.onerror=()=>reject(new Error('Observer WebSocket failed'));
  });
}
async function main(){
  try{
    if(sessionStorage.getItem('apiBrowserStage')!=='reloaded'){
      check((await sessions()).length===0,'fresh server has no sessions');
      check((await counts()).prompts===0,'loopback API has no prompt requests before TUI');
      await create();
      await pause(1500);
      const id=(await sessions())[0].id;
      await onboarding();
      const peer=await observer(id);
      check(peer.snapshot.controller!==peer.hello.view,'second browser view observes');
      const colors=new Set(peer.snapshot.terminal.screen.flatMap(line=>line.cells)
        .filter(cell=>cell[1]>0&&cell[0].trim()&&cell[2]!=='#d4d4d4').map(cell=>cell[2]));
      const rendered=new Set([...$('terminal-lines').querySelectorAll('.term-cell')]
        .filter(node=>node.textContent.trim()).map(node=>getComputedStyle(node).color));
      check([...colors].some(hex=>rendered.has('rgb('+[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16)).join(', ')+')')),
        'CLI foreground colors reach Rust state and browser rendering');
      check(peer.snapshot.terminal.modes.win32===true,'CLI negotiated Win32 keyboard');
      check(peer.snapshot.terminal.modes.bracketedPaste===true,'CLI negotiated bracketed paste');
      peer.ws.close();
      $('keyboard').focus();
      paste('Webterminal local fixture draft caf\u00e9 \ud83d\ude42');
      await until(()=>text().includes('draft caf\u00e9')&&text().includes('\ud83d\ude42'),'Unicode draft');
      await pause(250);
      key('Backspace','Backspace',{},8);
      await until(()=>!text().includes('\ud83d\ude42'),'Unicode grapheme deletion');
      paste('X');
      await until(()=>text().includes('draft caf\u00e9 X'),'Unicode replacement');
      check(true,'Unicode editing survives idle Backspace');
      const size=$('terminal-size').textContent;
      $('larger').click();
      await until(()=>$('terminal-size').textContent!==size,'browser resize');
      await until(()=>text().includes('draft caf\u00e9 X'),'draft redraw after resize');
      check(true,'draft survives native resize');
      paste('\nsecond line');
      await until(()=>text().includes('second line'),'bracketed multiline draft');
      await pause(300);
      check((await counts()).prompts===0,'multiline paste did not submit to API');
      check((await sessions())[0].alive,'CLI remained in composer before Enter');
      const enterBefore={...window.__enterRecords};
      key('Enter','Enter',{},13);
      await until(()=>window.__enterRecords.down===enterBefore.down+1&&window.__enterRecords.up===enterBefore.up+1,'one browser Enter key pair');
      check(true,'one Enter down and one Enter up crossed WebSocket');
      await until(()=>text().includes('Webterminal local fixture response.'),'fixed loopback response',500);
      await pause(700);
      const afterEnter=(await counts()).prompts;
      check(afterEnter>=1,'only explicit Enter submitted fixture prompt');
      sessionStorage.setItem('apiBrowserResults',JSON.stringify(results));
      sessionStorage.setItem('apiBrowserId',id);
      sessionStorage.setItem('apiBrowserPostCount',String(afterEnter));
      sessionStorage.setItem('apiBrowserStage','reloaded');
      location.reload();return;
    }
    const id=sessionStorage.getItem('apiBrowserId');
    await until(()=>text().includes('Webterminal local fixture response.')&&$('view-status').textContent==='Controlling','restored response snapshot',500);
    check((await sessions()).find(item=>item.id===id)?.alive,'browser reload kept CLI session');
    check(text().includes('Webterminal local fixture response.'),'response survived browser reload');
    const peer=await observer(id);
    check(peer.snapshot.controller!==peer.hello.view,'reloaded terminal has an observing peer');
    peer.ws.close();
    $('keyboard').focus();
    if(KIND==='codex'){
      paste('/quit');await pause(300);key('Enter','Enter',{},13);
    }else{
      for(let i=0;i<3;i++){key('c','KeyC',{ctrlKey:true},67);await pause(500)}
    }
    await until(async()=>!(await sessions()).find(item=>item.id===id)?.alive,'normal '+KIND+' exit',300);
    await until(()=>$('view-status').textContent.startsWith('Exited'),'exit snapshot');
    check((await sessions()).find(item=>item.id===id)?.exitCode===0,'CLI exited with code 0');
    check((await counts()).prompts===Number(sessionStorage.getItem('apiBrowserPostCount')),'reload and quit made no API requests');
  }catch(error){
    results.push({fail:String(error?.stack||error),status:$('view-status').textContent,screen:liveText().slice(-1500),text:text().slice(-1000),errors:window.__probeErrors,snapshots:window.__snapshots?.slice(-4),wire:window.__wire?.slice(-8)});
  }
  const report={kind:KIND,pass:results.every(item=>typeof item==='string'),results,userAgent:navigator.userAgent};
  document.body.dataset.probeResult=btoa(Array.from(new TextEncoder().encode(JSON.stringify(report)),byte=>String.fromCharCode(byte)).join(''));
}
await main();
`;

function environment(){
  const env={};
  for(const key of ['SystemRoot','SystemDrive','WINDIR','PATH','PATHEXT','ComSpec','ProgramFiles','ProgramFiles(x86)','ProgramW6432','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  return env;
}
async function fixture(path){
  const child=spawn(path,[],{env:environment(),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='';let stderr='';
  child.stdout.on('data',part=>{stdout+=part;});
  child.stderr.on('data',part=>{stderr+=part;});
  for(let i=0;i<100;i++){
    const line=stdout.split(/\r?\n/)[0];
    if(/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(line))return {child,origin:line.slice(0,-3),counts(){return {prompts:(stderr.match(/POST \/v1\/(?:responses|messages) #/g)||[]).length,routes:stderr.trim().split(/\r?\n/).filter(Boolean)}}};
    if(child.exitCode!==null)throw new Error('Loopback API fixture exited before startup');
    await new Promise(resolvePause=>setTimeout(resolvePause,50));
  }
  throw new Error('Loopback API fixture did not announce its port');
}
function command(kind,copied,profile,exe,origin){
  const parts=[copied.isolated,profile,'--fixture-api',origin,exe];
  if(kind==='codex'){
    parts.push('--no-daemon','--strict-config','-m','fixture-model','-s','read-only','-a','never');
    for(const value of [
      'model_provider="local_fixture"',
      'model_providers.local_fixture.name="Local fixture"',
      `model_providers.local_fixture.base_url="${origin}/v1"`,
      'model_providers.local_fixture.wire_api="responses"',
      'model_providers.local_fixture.requires_openai_auth=false',
      'model_providers.local_fixture.supports_websockets=false',
      'model_providers.local_fixture.request_max_retries=0',
      'model_providers.local_fixture.stream_max_retries=0',
      'web_search="disabled"','check_for_update_on_startup=false',
      'analytics.enabled=false','history.persistence="none"',
    ])parts.push('-c',value);
  }else parts.push('--bare','--restricted','--tools','','--strict-mcp-config','--model','fixture-model');
  return parts.map(quote).join(' ');
}
async function phase(kind){
  const runRoot=resolve(target,`cli-api-browser-${kind}-${process.pid}-${Date.now()}`);
  assert.ok(runRoot.startsWith(target+sep));
  await mkdir(runRoot,{recursive:true});
  let api,webterminal,proxy;
  try{
    const copied=Object.fromEntries(Object.keys(binaries).map(name=>[name,resolve(runRoot,name+'.exe')]));
    for(const name of Object.keys(binaries))await copyFile(binaries[name],copied[name]);
    const cwd=resolve(runRoot,'work');
    const profile=resolve(runRoot,'cli-profile');
    await mkdir(cwd,{recursive:true});await mkdir(profile,{recursive:true});
    api=await fixture(copied.fixture);
    const backendPort=await freePort();
    webterminal=spawn(copied.webterminal,['--port',String(backendPort),'--cwd',cwd,'--shell',command(kind,copied,profile,executables[kind],api.origin)],{cwd,env:environment(),windowsHide:true,stdio:['ignore','pipe','pipe']});
    let serverOutput='';webterminal.stdout.on('data',part=>{serverOutput+=part;});webterminal.stderr.on('data',part=>{serverOutput+=part;});
    await ready(backendPort,webterminal);
    proxy=await proxyFor(backendPort,harness.replace('__KIND__',JSON.stringify(kind)).replace('__CWD__',JSON.stringify(cwd)),{counts:api.counts});
    const report=await chromeProbe(chrome,'http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome-profile'),'apiBrowserStage');
    for(const item of report.results)console.log((typeof item==='string'?'PASS ':'FAIL ')+kind+': '+(typeof item==='string'?item:JSON.stringify(item)));
    const version=spawnSync(executables[kind],['--version'],{encoding:'utf8',windowsHide:true});
    console.log(kind+' version '+(version.stdout||version.stderr).trim());
    console.log(kind+' Chrome '+report.userAgent);
    console.log(kind+' API '+JSON.stringify(api.counts()));
    console.log(kind+' proxy '+JSON.stringify(proxy.stats));
    assert.equal(report.pass,true,kind+' browser acceptance failed');
    assert.equal(proxy.stats.upstreamErrors,0,kind+' proxy had upstream errors');
    assert.ok(api.counts().prompts>=1&&api.counts().prompts<=4,kind+' fixture request count escaped expected bounds');
    assert.ok(api.counts().routes.every(route=>/^(?:POST \/v1\/(?:responses|messages|messages\/count_tokens)|GET \/v1\/models) #\d+$/.test(route)),kind+' used an unexpected fixture route');
  }finally{
    await stopProxy(proxy);await stopChild(webterminal);await stopChild(api?.child);
    await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
if(!selected||selected==='codex')await phase('codex');
if(!selected||selected==='claude')await phase('claude');
