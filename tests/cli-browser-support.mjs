// Owned, test-only loopback proxy and disposable headless Chrome runner.
// The proxy rewrites Host/Origin for the owned fixture; product validation is
// exercised separately in Rust transport tests. No browser security is disabled.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, readFile, stat} from 'node:fs/promises';
import {createServer, get as httpGet, request as httpRequest} from 'node:http';
import {connect as netConnect, createServer as portServer} from 'node:net';
import {join} from 'node:path';
import {mergeUpdate} from '../assets/updates.js';

export async function findChrome() {
  for(const path of [
    join(process.env.PROGRAMFILES||'C:\\Program Files','Google','Chrome','Application','chrome.exe'),
    join(process.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Google','Chrome','Application','chrome.exe'),
  ]) { try { await stat(path); return path; } catch {} }
  throw new Error('System Chrome was not found');
}
export async function freePort() {
  const server=portServer();
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen);});
  const port=server.address().port;
  await new Promise(resolveClose=>server.close(resolveClose));
  return port;
}
export async function ready(port,child) {
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
export const prelude = "const assembleUpdate=" + mergeUpdate.toString() + ";window.__probeErrors=[];window.__snapshots=[];window.__snapshotBodies={};window.__wire=[];window.__enterRecords={down:0,up:0};window.addEventListener('error',e=>window.__probeErrors.push(String(e.message)));window.addEventListener('unhandledrejection',e=>window.__probeErrors.push(String(e.reason)));const NativeWebSocket=window.WebSocket;window.WebSocket=class extends NativeWebSocket{constructor(...args){super(...args);if(!window.__appSocket||window.__appSocket.readyState===NativeWebSocket.CLOSED)window.__appSocket=this;this.addEventListener('message',e=>{if(this!==window.__appSocket)return;try{let m=JSON.parse(e.data);if(m.type==='update'){m=assembleUpdate(window.__snapshotBodies[m.id],m);if(!m){window.__probeErrors.push('Invalid ordered update');return;}}if(m.type==='snapshot'){window.__snapshots.push({id:m.id,epoch:m.epoch,seq:m.seq,modes:m.terminal?.modes});window.__snapshotBodies[m.id]=m}if(m.type==='attached')window.__wire.push({type:m.type,id:m.id,request:m.request})}catch{}})}send(data){try{const m=JSON.parse(data);if(['attach','input','resize'].includes(m.op))window.__wire.push({op:m.op,id:m.id,epoch:m.epoch,request:m.request});if(m.op==='input')for(const record of m.data.matchAll(/\\x1b\\[13;28;13;([01]);\\d+;1_/g))window.__enterRecords[record[1]==='1'?'down':'up']++}catch{}return super.send(data)}};";
export async function proxyFor(backendPort,source,extra={}) {
  const backendOrigin='http://127.0.0.1:'+backendPort;
  const sockets=new Set();
  const stats={http:0,upgrades:0,upstreamErrors:0,browserAborts:0};
  const server=createServer((request,response)=>{
    stats.http++;
    if(request.url.startsWith('/probe-pause?ms=')) {
      const ms=Math.max(0,Math.min(500,Number(new URL(request.url,'http://127.0.0.1').searchParams.get('ms'))||0));
      setTimeout(()=>{response.writeHead(204,{'Cache-Control':'no-store'});response.end();},ms);
      return;
    }
    if(request.url==='/probe-counts'&&extra.counts) {
      response.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
      response.end(JSON.stringify(extra.counts()));return;
    }
    if(request.url==='/probe-harness.js'||request.url==='/probe-prelude.js') {
      const body=request.url==='/probe-harness.js'?source:prelude;
      response.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
      response.end(body);return;
    }
    let settled=false;
    const upstream=httpRequest({hostname:'127.0.0.1',port:backendPort,path:request.url,method:'GET',headers:{Host:'127.0.0.1:'+backendPort,Connection:'close'},agent:false},upstreamResponse=>{
      const chunks=[];
      upstreamResponse.on('data',chunk=>chunks.push(chunk));
      upstreamResponse.on('error',failed);
      upstreamResponse.on('end',()=>{
        if(settled) return;
        settled=true;
        let body=Buffer.concat(chunks);
        if(request.url==='/'&&upstreamResponse.statusCode===200) {
          const html=body.toString('utf8');
          assert.ok(html.includes('</body>'),'Product index changed');
          body=Buffer.from(html.replace('</body>','<script src="/probe-prelude.js"></script><script type="module" src="/probe-harness.js"></script></body>'));
        }
        const headers={...upstreamResponse.headers,'content-length':String(body.length)};
        delete headers['transfer-encoding'];delete headers.connection;
        response.writeHead(upstreamResponse.statusCode,headers);
        response.end(body);
      });
    });
    function failed(error) { if(settled)return;settled=true;stats.upstreamErrors++;if(!response.destroyed){response.writeHead(502);response.end(String(error));} }
    function browserAborted() {
      if(settled)return;
      settled=true;stats.browserAborts++;
      upstream.destroy();
    }
    request.on('aborted',browserAborted);
    response.on('close',()=>{if(!response.writableEnded)browserAborted();});
    upstream.setTimeout(5000,()=>upstream.destroy(new Error('Backend GET timeout')));
    upstream.on('error',failed);
    upstream.end();
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.on('upgrade',(browser,socket,head)=>{
    stats.upgrades++;
    const upstream=netConnect(backendPort,'127.0.0.1',()=>{
      const headers={Host:'127.0.0.1:'+backendPort,Origin:backendOrigin,Upgrade:'websocket',Connection:'Upgrade','Sec-WebSocket-Key':browser.headers['sec-websocket-key'],'Sec-WebSocket-Version':'13'};
      upstream.write(['GET '+browser.url+' HTTP/1.1',...Object.entries(headers).map(([name,value])=>name+': '+value),'',''].join('\r\n'));
      if(head.length)upstream.write(head);
      socket.pipe(upstream);upstream.pipe(socket);
    });
    upstream.on('error',()=>{stats.upstreamErrors++;socket.destroy();});
    socket.on('error',()=>upstream.destroy());
  });
  await new Promise((resolveListen,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolveListen);});
  return {server,sockets,stats,port:server.address().port};
}
export async function chromeProbe(chrome,url,profile,stageKey='probeStage',onPoll) {
  await mkdir(profile,{recursive:true});
  const child=spawn(chrome,['--headless=new','--remote-debugging-port=0','--window-size=1280,900','--user-data-dir='+profile,url],{windowsHide:true});
  let errors='';child.stderr.setEncoding('utf8');child.stderr.on('data',part=>{errors+=part;});
  let devtools;
  try {
    let port;
    for(let i=0;i<100;i++) {
      if(child.exitCode!==null)throw new Error('Chrome exited: '+errors.slice(-500));
      try{port=Number((await readFile(join(profile,'DevToolsActivePort'),'utf8')).split(/\r?\n/)[0]);if(port)break;}catch{}
      await new Promise(resolvePause=>setTimeout(resolvePause,100));
    }
    if(!port)throw new Error('Chrome DevTools port missing');
    let page;
    for(let i=0;i<100;i++) {
      try{
        const targets=await new Promise((resolveTargets,reject)=>{
          const call=httpGet({hostname:'127.0.0.1',port,path:'/json/list'},response=>{
            let body='';response.setEncoding('utf8');response.on('data',part=>{body+=part;});response.on('end',()=>{try{resolveTargets(JSON.parse(body));}catch(error){reject(error);}});
          });call.once('error',reject);
        });
        page=targets.find(item=>item.type==='page'&&item.url===url);if(page)break;
      }catch{}
      await new Promise(resolvePause=>setTimeout(resolvePause,100));
    }
    if(!page)throw new Error('Chrome page target missing');
    devtools=new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolveOpen,reject)=>{devtools.addEventListener('open',resolveOpen,{once:true});devtools.addEventListener('error',reject,{once:true});});
    let nextId=0;const pending=new Map();
    devtools.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(!message.id||!pending.has(message.id))return;
      const {resolveResult,rejectResult}=pending.get(message.id);pending.delete(message.id);
      if(message.error)rejectResult(new Error(message.error.message));else resolveResult(message.result);
    });
    function protocol(method,params){
      const id=++nextId;
      return new Promise((resolveResult,rejectResult)=>{
        pending.set(id,{resolveResult,rejectResult});
        devtools.send(JSON.stringify({id,method,params}));
      });
    }
    function evaluate(expression){return protocol('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true}).then(result=>result.result?.value);}
    for(let i=0;i<480;i++) {
      if(child.exitCode!==null)throw new Error('Chrome exited during probe: '+errors.slice(-500));
      if(onPoll) await onPoll({protocol,evaluate});
      const encoded=await evaluate('document.body?.dataset.probeResult||""').catch(()=>null);
      if(encoded)return JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));
      await new Promise(resolvePause=>setTimeout(resolvePause,200));
    }
    const state=await evaluate('JSON.stringify({stage:sessionStorage.getItem('+JSON.stringify(stageKey)+'),text:document.getElementById("terminal-lines")?.textContent?.slice(-700),errors:window.__probeErrors})').catch(()=>null);
    throw new Error('Chrome probe timed out: '+state+' '+errors.slice(-500));
  }finally{
    devtools?.close();
    if(child.exitCode===null){child.kill();await Promise.race([new Promise(resolveExit=>child.once('exit',resolveExit)),new Promise(resolveWait=>setTimeout(resolveWait,3000))]);}
  }
}
export function quote(text){return '"'+text.replaceAll('"','\\"')+'"';}
export async function stopChild(child){
  if(child?.exitCode===null){child.kill();await Promise.race([new Promise(resolveExit=>child.once('exit',resolveExit)),new Promise(resolveWait=>setTimeout(resolveWait,3000))]);}
}
export async function stopProxy(proxy){
  if(proxy){for(const socket of proxy.sockets)socket.destroy();await new Promise(resolveClose=>proxy.server.close(resolveClose));}
}
