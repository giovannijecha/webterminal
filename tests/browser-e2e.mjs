// Test-only same-origin proxy: it injects one owned harness module and rewrites
// Host/Origin toward the private backend. Product CSP is forwarded unchanged.
// Direct Host/Origin rejection is covered by tests/transport.rs.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile, mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {createServer, request as httpRequest, get as httpGet} from 'node:http';
import {createServer as createPortServer, connect as netConnect} from 'node:net';
import {resolve, join, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const target = resolve(root, 'target');
const scratch = resolve(root, '.tmp');
const runRoot = resolve(scratch, 'browser-e2e-' + process.pid + '-' + Date.now());
if (!runRoot.startsWith(scratch + sep)) throw new Error('Test directory escaped scratchpad');
const chromePaths = [
  join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
];
let chrome;
for (const path of chromePaths) { try { await stat(path); chrome = path; break; } catch {} }
if (!chrome) throw new Error('System Chrome was not found');
const binDirectory = resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(root,'target/debug'));
const binaries = {webterminal:resolve(binDirectory,'webterminal.exe'),fixture:resolve(binDirectory,'native_fixture.exe')};
for (const path of Object.values(binaries)) await stat(path);

const harness = String.raw`
const ESC = '\x1b';
const PHASE = __PHASE__;
const CWD = __CWD__;
const SCREENSHOT = __SCREENSHOT__;
const results = JSON.parse(sessionStorage.getItem('browserE2eResults') || '[]');
const $ = id => document.getElementById(id);
const pause = async ms => { await fetch('/e2e-pause?ms='+ms,{cache:'no-store'}); };
async function until(probe, label) {
  for (let attempt=0; attempt<500; attempt++) {
    const value = await probe();
    if (value) return value;
    await pause(50);
  }
  throw new Error('Timed out waiting for ' + label);
}
function verify(value, label) { if (!value) throw new Error(label); results.push({pass:true,label}); }
async function sessions() { const response=await fetch('/api/sessions',{cache:'no-store'}); const body=await response.text(); if (!response.ok) throw new Error('Sessions HTTP '+response.status+': '+body); return JSON.parse(body).sessions; }
function sameCwd(path) { return (path.startsWith('\\\\?\\') ? path.slice(4) : path).toLowerCase() === CWD.toLowerCase(); }
function terminalText() { return $('terminal-lines').textContent || ''; }
function key(name, code, options={}, keyCode=0, type='keydown') {
  const event = new KeyboardEvent(type,{key:name,code,bubbles:true,cancelable:true,...options});
  Object.defineProperty(event,'keyCode',{value:keyCode});
  $('keyboard').dispatchEvent(event);
}
async function newTerminal(expectedCount) {
  await pause(300);
  $('new').click();
  await until(() => $('directory-dialog').open, 'directory dialog; new='+$('new').outerHTML+' toast='+$('toast').textContent);
  await until(() => !$('directory-create').disabled, 'directory browser');
  $('directory-create').click();
  await until(async () => (await sessions()).length === expectedCount, 'session creation');
  await until(() => $('pane').dataset.status === 'Controlling', 'terminal control');
}
function navigate(path) {
  $('directory-address').click();
  $('directory-path').value=path;
  $('directory-path').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
}
function socket() {
  return new Promise((resolve,reject) => {
    const ws = new WebSocket('ws://' + location.host + '/ws');
    const messages=[];
    ws.onmessage = event => { try { messages.push(JSON.parse(event.data)); } catch {} };
    ws.onopen = () => resolve({ws,messages});
    ws.onerror = () => reject(new Error('observer WebSocket failed'));
  });
}
async function observer(id) {
  const peer = await socket();
  peer.ws.send(JSON.stringify({op:'attach',id,cols:80,rows:24}));
  const snapshot = await until(() => peer.messages.find(message => message.type==='snapshot' && message.id===id), 'observer snapshot');
  return {...peer,snapshot};
}
async function echo() {
  if (sessionStorage.getItem('browserE2eStep') !== 'reloaded') {
    const initial = await sessions();
    verify(initial.length === 0, 'fresh server has no sessions');
    await newTerminal(1);
    await until(() => terminalText().includes('READY'), 'first READY');
    const first = (await sessions())[0];
    verify(sameCwd(first.cwd), 'first cwd is selected directory');
    $('new-workspace').click();
    await until(() => $('workspace-tabs').querySelectorAll('.workspace-tab').length===2, 'second workspace');
    await newTerminal(2);
    await until(() => terminalText().includes('READY'), 'second READY');
    const all = await sessions();
    verify(all[0].id !== all[1].id && all.every(item => sameCwd(item.cwd)), 'independent sessions share a cwd');
    if (SCREENSHOT) {
      document.body.dataset.e2eScreenshot='ready';
      await until(() => document.body.dataset.e2eScreenshot==='captured', 'fixture screenshot');
    }
    sessionStorage.setItem('browserE2eStep','reloaded');
    sessionStorage.setItem('browserE2eFirst',all[0].id);
    sessionStorage.setItem('browserE2eSecond',all[1].id);
    sessionStorage.setItem('browserE2eResults',JSON.stringify(results));
    location.reload();
    return 'reloading';
  }
  const first=sessionStorage.getItem('browserE2eFirst');
  const second=sessionStorage.getItem('browserE2eSecond');
  await pause(1000);
  await until(() => $('workspace-tabs').querySelectorAll('.workspace-tab').length===2 && terminalText().includes('READY'), 'restored snapshot after reload');
  verify((await sessions()).length===2, 'browser reload kept both sessions');
  await until(() => $('pane').dataset.status==='Controlling', 'control after reload');
  verify($('pane').hidden===false, 'restored active terminal is visible');

  $('new').click();
  await until(() => $('directory-dialog').open, 'directory dialog');
  navigate(CWD+'\\missing-e2e');
  await until(() => !$('directory-error').hidden, 'invalid directory error');
  verify((await sessions()).length===2, 'invalid directory did not create a session');
  $('directory-dialog').close();

  const copied=[];
  const clipboard=navigator.clipboard;
  const originalWrite=clipboard.writeText;
  clipboard.writeText=async value=>{copied.push(value);};
  const markdown='# Fixture clipboard\n\nA complete owned document copied by the terminal.';
  const bytes=new TextEncoder().encode(markdown);
  const data=btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(''));
  const frameClipboard=()=>window.__appSocket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'clipboard',id:second,data})}));
  frameClipboard();await until(()=>$('notice-dialog').open,'clipboard consent notice');
  $('notice-cancel').click();
  verify(copied.length===0,'declined OSC 52 copy leaves clipboard alone');
  frameClipboard();await until(()=>$('notice-dialog').open,'second clipboard consent notice');
  $('notice-confirm').click();await until(()=>copied.length===1,'approved clipboard write');
  verify(copied[0]===markdown,'approved OSC 52 copy preserves UTF-8 text');
  clipboard.writeText=originalWrite;

  const peer=await observer(second);
  verify(peer.snapshot.controller !== peer.messages.find(message=>message.type==='hello').view, 'second browser view observes');
  peer.ws.send(JSON.stringify({op:'input',id:second,epoch:peer.snapshot.epoch,seq:1,data:'BAD\r'}));
  await until(() => peer.messages.some(message=>message.type==='error'), 'observer input rejection');
  verify(!terminalText().includes('BAD'), 'observer input did not reach terminal');
  peer.ws.send(JSON.stringify({op:'claim',id:second,cols:80,rows:24}));
  await until(() => $('pane').dataset.status==='Observing', 'control transfer to observer');
  $('take-control').click();
  await until(() => $('pane').dataset.status==='Controlling', 'UI takes control back');
  peer.ws.close();

  $('keyboard').focus();
  for (const character of 'hello ') key(character,character===' '?'Space':'Key'+character.toUpperCase());
  const transfer=new DataTransfer(); transfer.setData('text/plain','café🙂');
  $('keyboard').dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));
  key('Enter','Enter',{},13);
  await until(() => terminalText().includes('ECHO:hello café🙂'), 'Unicode echo through ConPTY');
  await until(() => $('pane').dataset.status.startsWith('Exited'), 'normal echo exit');
  verify(terminalText().includes('ECHO:hello café🙂'), 'browser keyboard and paste reached fixture');
  $('close-session').click();
  await until(async () => (await sessions()).length===1, 'close second session');
  verify((await sessions())[0].id===first && (await sessions())[0].alive, 'closing second left first running');
  $('workspace-tabs').querySelector('.workspace-tab:not(.active)').click();
  await until(() => terminalText().includes('READY') && $('pane').dataset.status==='Controlling', 'first workspace resumes');
  $('keyboard').focus();
  for (const character of 'other') key(character,'Key'+character.toUpperCase());
  key('Enter','Enter',{},13);
  await until(() => terminalText().includes('ECHO:other'), 'first independent echo');
  await until(() => $('pane').dataset.status.startsWith('Exited'), 'first normal exit');
  $('close-session').click();
  await until(async () => (await sessions()).length===0, 'close first session');
  await until(() => !$('empty-state').hidden, 'empty state');
  verify($('empty-state').hidden===false, 'empty state returns');

  // Feed a restarted server's frames through the actual app WebSocket handler.
  // Reused IDs and lower sequence numbers must never retain prior screen DOM.
  const fake={id:'s1',cwd:CWD,title:'Old session',alive:true,controller:'synthetic',exitCode:null};
  const frame=message=>window.__appSocket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(message)}));
  const snapshot=(seq,text)=>({type:'snapshot',id:'s1',seq,epoch:1,controller:'synthetic',alive:true,exitCode:null,terminal:{cols:80,rows:1,cursor:[0,0,false,'block'],title:text,alternate:false,modes:{},history:[],screen:[{wrapped:false,cells:[...text].map(character=>[character,1,'#dce4ed','#10151c',0,''])}]}});
  const workspace=$('workspace-tabs').querySelector('.workspace-tab.active').dataset.workspace;
  frame({type:'sessions',sessions:[fake],workspaces:[{id:workspace,name:null,sessions:['s1']}]});
  frame(snapshot(9000,'OLD SCREEN'));
  await until(() => terminalText().includes('OLD SCREEN'), 'old server screen');
  verify(true, 'old server screen was rendered');
  frame({type:'hello',view:'synthetic',cwd:CWD,shell:'fixture'});
  verify(!terminalText().includes('OLD SCREEN'), 'new hello clears stale screen');
  frame(snapshot(1,'NEW SCREEN'));
  await until(() => terminalText().includes('NEW SCREEN'), 'new server screen');
  verify(true, 'reused session accepts lower sequence after hello');
  const changed=snapshot(2,'UPDATED SCREEN');
  frame({...changed,type:'update',base:1,terminal:{...changed.terminal,history:undefined,screen:undefined,screenChanges:[[0,changed.terminal.screen[0]]]}});
  await until(() => terminalText().includes('UPDATED SCREEN'), 'ordered update screen');
  verify(true, 'ordered row update reaches actual app renderer');
  const stale=snapshot(3,'STALE PATCH');
  frame({...stale,type:'update',base:1,terminal:{...stale.terminal,history:undefined,screen:undefined,screenChanges:[[0,stale.terminal.screen[0]]]}});
  verify(!terminalText().includes('STALE PATCH')&&$('pane').dataset.status==='Connecting\u2026', 'wrong update base gates input and requests a fresh attachment');
  frame(snapshot(4,'RESTORED SCREEN'));
  await until(() => terminalText().includes('RESTORED SCREEN'), 'restored screen');
  verify(true, 'full snapshot repairs an interrupted update stream');
}
async function records() {
  await newTerminal(1);
  await until(() => terminalText().includes('RECORDS_READY'), 'records fixture ready');
  const id=(await sessions())[0].id;
  const peer=await observer(id);
  await until(() => peer.messages.some(message=>message.type==='snapshot' && message.terminal.modes.win32), 'negotiated Win32 input mode');
  verify(true,'ConPTY requested Win32 input mode');
  peer.ws.close();
  $('keyboard').focus();
  key('Enter','Enter',{shiftKey:true},13);
  key('Enter','Enter',{shiftKey:true},13,'keyup');
  key(' ','Space',{ctrlKey:true},32);
  key(' ','Space',{ctrlKey:true},32,'keyup');
  await until(() => terminalText().includes('KEY 13 13 16') && terminalText().includes('KEY 32 0 8'), 'native modified key records');
  await until(() => $('pane').dataset.status.startsWith('Exited'), 'records normal exit');
  verify(terminalText().includes('KEY 13 13 16') && terminalText().includes('KEY 32 0 8'), 'native console received Shift+Enter and Ctrl+Space');
}
async function main() {
  try { const outcome=PHASE==='echo' ? await echo() : await records(); if (outcome==='reloading') return; }
  catch (error) { results.push({pass:false,label:String(error?.stack || error)+' UI '+JSON.stringify({tabs:$('workspace-tabs').querySelectorAll('.workspace-tab').length,text:terminalText().slice(0,120),status:$('pane').dataset.status,active:$('workspace-tabs').querySelector('.workspace-tab.active')?.dataset.workspace,toast:$('toast').textContent,errors:window.__e2eErrors})}); }
  const report={phase:PHASE,pass:results.every(result=>result.pass),results,userAgent:navigator.userAgent};
  sessionStorage.removeItem('browserE2eResults');
  const bytes=new TextEncoder().encode(JSON.stringify(report));
  document.body.dataset.e2eResult=btoa(Array.from(bytes,byte=>String.fromCharCode(byte)).join(''));
}
await main();
`;

async function freePort() {
  const server = createPortServer();
  await new Promise((resolveListen,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolveListen); });
  const port=server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}
async function serverReady(port, child) {
  for (let attempt=0;attempt<200;attempt++) {
    if (child.exitCode !== null) throw new Error('Webterminal exited before serving');
    try {
      const status = await new Promise((resolveStatus,reject) => {
        const request=httpGet({hostname:'127.0.0.1',port,path:'/api/info',headers:{Host:'127.0.0.1:'+port}}, response=>{response.resume();resolveStatus(response.statusCode);});
        request.once('error',reject);
      });
      if (status===200) return;
    } catch {}
    await new Promise(resolvePause=>setTimeout(resolvePause,50));
  }
  throw new Error('Webterminal did not become ready');
}
async function proxyFor(backendPort, source) {
  const backendOrigin='http://127.0.0.1:'+backendPort;
  const sockets=new Set();
  const stats={http:0,upgrades:0,upstreamErrors:0,browserAborts:0,paths:{},status:{},failures:[]};
  const server=createServer((request,response) => {
    stats.http++; stats.paths[request.url]=(stats.paths[request.url]||0)+1;
    if (request.url.startsWith('/e2e-pause?ms=')) {
      const ms=Math.max(0,Math.min(1000,Number(new URL(request.url,'http://127.0.0.1').searchParams.get('ms'))||0));
      setTimeout(()=>{response.writeHead(204,{'Cache-Control':'no-store'});response.end();},ms);
      return;
    }
    if (request.url==='/e2e-harness.js') {
      response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      response.end(source); return;
    }
    if (request.url==='/e2e-prelude.js') {
      response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store'});
      response.end("window.__e2eErrors=[];window.addEventListener('error',event=>window.__e2eErrors.push(String(event.message)+' '+event.filename));window.addEventListener('unhandledrejection',event=>window.__e2eErrors.push(String(event.reason)));const NativeWebSocket=window.WebSocket;window.WebSocket=class extends NativeWebSocket{constructor(...args){super(...args);window.__appSocket??=this}};");return;
    }
    let settled=false;
    let backendStatus=null;
    const started=Date.now();
    const headers={Host:'127.0.0.1:'+backendPort,Connection:'close'};
    const upstream=httpRequest({hostname:'127.0.0.1',port:backendPort,path:request.url,method:'GET',headers,agent:false}, upstreamResponse => {
      backendStatus=upstreamResponse.statusCode;
      stats.status[request.url]=backendStatus;
      const chunks=[];
      upstreamResponse.on('data',chunk=>chunks.push(chunk));
      upstreamResponse.on('error',failed);
      upstreamResponse.on('end',()=>{
        if (settled) return;
        settled=true;
        let body=Buffer.concat(chunks);
        if (request.url==='/' && backendStatus===200) {
          const html=body.toString('utf8');
          assert.ok(html.includes('</body>'),'product index changed');
          body=Buffer.from(html.replace('<script type="module" src="/app.js"></script>','<script src="/e2e-prelude.js"></script><script type="module" src="/app.js"></script>').replace('</body>','<script type="module" src="/e2e-harness.js"></script></body>'),'utf8');
        }
        const forwarded={...upstreamResponse.headers,'content-length':String(body.length)};
        delete forwarded['transfer-encoding']; delete forwarded.connection;
        response.writeHead(backendStatus,forwarded);
        response.end(body);
      });
    });
    function failed(error) {
      if (settled) return;
      settled=true;
      stats.upstreamErrors++;
      stats.failures.push({path:request.url,code:error.code||null,message:error.message,backendStatus,elapsedMs:Date.now()-started,browserAborted:request.aborted,downstreamClosed:response.destroyed});
      if (!response.destroyed) {response.writeHead(502);response.end(String(error));}
    }
    // IncomingMessage 'close' also fires for a completed GET. Only the
    // response closing before it finishes means the browser abandoned it.
    function browserAborted() {
      if (settled) return;
      settled=true;
      stats.browserAborts++;
      upstream.destroy();
    }
    request.on('aborted',browserAborted);
    response.on('close',()=>{if (!response.writableEnded) browserAborted();});
    upstream.setTimeout(5000,()=>upstream.destroy(new Error('Backend GET timeout')));
    upstream.on('error',failed);
    upstream.end();
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade',(browser, socket, head)=>{
    stats.upgrades++;
    const upstream=netConnect(backendPort,'127.0.0.1',()=>{
      const headers={Host:'127.0.0.1:'+backendPort,Origin:backendOrigin,Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':browser.headers['sec-websocket-key'],'Sec-WebSocket-Version':'13'};
      const lines=['GET '+browser.url+' HTTP/1.1',...Object.entries(headers).map(([name,value])=>name+': '+value),'',''];
      upstream.write(lines.join('\r\n'));
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
    upstream.on('error',()=>{stats.upstreamErrors++;socket.destroy();});
    socket.on('error',()=>upstream.destroy());
  });
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen);});
  return {server,sockets,stats,port:server.address().port};
}
async function chromeProbe(url,profile,screenshotPath) {
  await mkdir(profile,{recursive:true});
  const child=spawn(chrome,['--headless=new','--remote-debugging-port=0','--window-size=1280,900','--user-data-dir='+profile,url],{windowsHide:true});
  let errors='';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data',chunk=>{errors+=chunk;});
  let devtools;
  try {
    let port;
    for (let attempt=0;attempt<100;attempt++) {
      if (child.exitCode!==null) throw new Error('Chrome exited before DevTools started: '+errors.slice(-1000));
      try {port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]);if (port) break;} catch {}
      await new Promise(resolvePause=>setTimeout(resolvePause,100));
    }
    if (!port) throw new Error('Chrome DevTools port did not appear: '+errors.slice(-1000));
    let page;
    for (let attempt=0;attempt<100;attempt++) {
      try {
        const targets=await new Promise((resolveTargets,reject)=>{
          const request=httpGet({hostname:'127.0.0.1',port,path:'/json/list'},response=>{
            let body='';response.setEncoding('utf8');response.on('data',chunk=>{body+=chunk;});response.on('end',()=>{try{resolveTargets(JSON.parse(body));}catch(error){reject(error);}});
          });request.once('error',reject);
        });
        page=targets.find(target=>target.type==='page' && target.url===url);
        if (page) break;
      } catch {}
      await new Promise(resolvePause=>setTimeout(resolvePause,100));
    }
    if (!page) throw new Error('Chrome page target did not appear');
    devtools=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolveOpen,reject)=>{devtools.addEventListener('open',resolveOpen,{once:true});devtools.addEventListener('error',reject,{once:true});});
    let nextId=0;
    const pending=new Map();
    devtools.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const {resolveResult,rejectResult}=pending.get(message.id);
      pending.delete(message.id);
      if (message.error) rejectResult(new Error(message.error.message)); else resolveResult(message.result);
    });
    function protocol(method,params) {
      const id=++nextId;
      return new Promise((resolveResult,rejectResult)=>{
        pending.set(id,{resolveResult,rejectResult});
        devtools.send(JSON.stringify({id,method,params}));
      });
    }
    function evaluate(expression) { return protocol('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}).then(result=>result.result?.value); }
    let encoded;
    let captured=false;
    for (let attempt=0;attempt<225;attempt++) {
      if (child.exitCode!==null) throw new Error('Chrome exited before fixture finished: '+errors.slice(-1000));
      if (screenshotPath && !captured && await evaluate('document.body?.dataset.e2eScreenshot === "ready"').catch(()=>false)) {
        const screenshot=await protocol('Page.captureScreenshot',{format:'png'});
        await writeFile(screenshotPath,Buffer.from(screenshot.data,'base64'));
        captured=true;
        await evaluate('document.body.dataset.e2eScreenshot = "captured"');
      }
      try {encoded=await evaluate('document.body?.dataset.e2eResult || ""');} catch {}
      if (encoded) break;
      await new Promise(resolvePause=>setTimeout(resolvePause,200));
    }
    if (!encoded) {
      const state=await evaluate('JSON.stringify({stage:sessionStorage.getItem("browserE2eStep"),status:document.getElementById("pane")?.dataset.status,text:document.getElementById("terminal-lines")?.textContent?.slice(0,120),errors:window.__e2eErrors})').catch(()=>null);
      throw new Error('Chrome fixture did not finish: '+state+' '+errors.slice(-1000));
    }
    return JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
  } finally {
    devtools?.close();
    if (child.exitCode===null) {child.kill();await Promise.race([new Promise(resolveExit=>child.once('exit',resolveExit)),new Promise(resolveWait=>setTimeout(resolveWait,3000))]);}
  }
}
async function phase(name,copied) {
  const cwd=resolve(runRoot,name+'-cwd');
  const profile=resolve(runRoot,name+'-profile');
  await mkdir(cwd,{recursive:true});
  const backendPort=await freePort();
  const command='"'+copied.fixture+'" --'+name;
  const environment={};
  for (const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP']) if (process.env[key]) environment[key]=process.env[key];
  const child=spawn(copied.webterminal,['--port',String(backendPort),'--cwd',cwd,'--shell',command],{cwd,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let serverOutput='';
  child.stdout.on('data',chunk=>{serverOutput+=chunk;});
  child.stderr.on('data',chunk=>{serverOutput+=chunk;});
  let proxy;
  try {
    await serverReady(backendPort,child);
    const generated=harness.replace('const PHASE = __PHASE__;','const PHASE = '+JSON.stringify(name)+';').replace('const CWD = __CWD__;','const CWD = '+JSON.stringify(cwd)+';').replace('const SCREENSHOT = __SCREENSHOT__;','const SCREENSHOT = '+String(Boolean(process.env.WEBTERMINAL_E2E_SCREENSHOT && name==='echo'))+';');
    proxy=await proxyFor(backendPort,generated);
    const report=await chromeProbe('http://127.0.0.1:'+proxy.port+'/',profile,process.env.WEBTERMINAL_E2E_SCREENSHOT && name==='echo' ? resolve(scratch,'webterminal-ui.png') : null);
    for (const result of report.results) console.log((result.pass?'PASS ':'FAIL ')+name+': '+result.label);
    console.log(name+' Chrome '+report.userAgent);
    console.log(name+' proxy GET failures '+JSON.stringify({upstream:proxy.stats.upstreamErrors,browserAborts:proxy.stats.browserAborts,details:proxy.stats.failures}));
    assert.equal(report.pass,true,name+' browser-to-ConPTY checks failed');
    assert.equal(proxy.stats.upstreamErrors,0,name+' backend GET failed');
    return report;
  } catch (error) { throw new Error(name+' phase: '+error.message+'\n'+serverOutput.slice(-1500)+'\nproxy '+JSON.stringify(proxy?.stats)); }
  finally {
    if (proxy) { for (const socket of proxy.sockets) socket.destroy(); await new Promise(resolveClose=>proxy.server.close(resolveClose)); }
    if (child.exitCode===null) {child.kill();await Promise.race([new Promise(resolveExit=>child.once('exit',resolveExit)),new Promise(resolveWait=>setTimeout(resolveWait,3000))]);}
  }
}

await mkdir(runRoot,{recursive:true});
const copied={webterminal:resolve(runRoot,'webterminal.exe'),fixture:resolve(runRoot,'native_fixture.exe')};
await copyFile(binaries.webterminal,copied.webterminal);
await copyFile(binaries.fixture,copied.fixture);
const selected=process.argv[2];
if (selected && !['echo','records'].includes(selected)) throw new Error('Use echo or records');
try { if (!selected || selected==='echo') await phase('echo',copied); if (!selected || selected==='records') await phase('records',copied); }
finally { await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(error=>console.error('Test cleanup:',error.message)); }
