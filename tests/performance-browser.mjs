// Comparable end-to-end measurements with an owned ConPTY child and Chrome.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile, mkdir, rm, writeFile} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeProbe,findChrome,freePort,proxyFor,ready,stopChild,stopProxy,quote} from './cli-browser-support.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const target=resolve(root,'target');
const binaries=resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || resolve(target,'perf-build/debug'));
const runRoot=resolve(target,`performance-${process.pid}-${Date.now()}`);
assert.ok(runRoot.startsWith(target+sep));
const reports=resolve(target,'performance');
const label=process.argv[2] || 'current';
const flowOnly=process.argv[3]==='flow';
assert.match(label,/^[a-z0-9-]+$/);
await mkdir(runRoot,{recursive:true});await mkdir(reports,{recursive:true});
await copyFile(resolve(binaries,'webterminal.exe'),resolve(runRoot,'webterminal.exe'));
await copyFile(resolve(binaries,'perf_fixture.exe'),resolve(runRoot,'perf_fixture.exe'));

const harness=String.raw`
const FLOW_ONLY=__FLOW_ONLY__;
import {TerminalRenderer} from '/render.js';
const $=id=>document.getElementById(id);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,label){for(let i=0;i<800;i++){if(test())return;await pause(10);}throw new Error('Timed out: '+label);}
const renders=[];const parse=[];const deliveries=[];
const originalRender=TerminalRenderer.prototype.render;
TerminalRenderer.prototype.render=function(...args){const start=performance.now();const result=originalRender.apply(this,args);renders.push(performance.now()-start);return result;};
const originalParse=JSON.parse;
JSON.parse=function(text,...args){const start=performance.now();const result=originalParse(text,...args);if(['snapshot','update'].includes(result?.type)){parse.push(performance.now()-start);deliveries.push({time:performance.now(),bytes:new TextEncoder().encode(text).length});}return result;};
function send(text){const data=new DataTransfer();data.setData('text/plain',text);$('keyboard').dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));}
async function painted(){await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}
function summary(samples){const sorted=[...samples].sort((a,b)=>a-b);return{samples:samples.length,median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.ceil(sorted.length*.95)-1],min:sorted[0],max:sorted.at(-1)};}
const report={workloads:[],userAgent:navigator.userAgent,viewport:[innerWidth,innerHeight]};
const frameGaps=[];let lastFrame=0;let recordFrames=false;
function frame(time){if(recordFrames&&lastFrame)frameGaps.push(time-lastFrame);lastFrame=recordFrames?time:0;requestAnimationFrame(frame);}
if(FLOW_ONLY)requestAnimationFrame(frame);
async function workload(name,command,marker,sequence){
  document.body.dataset.perfWorkload=name;
  if(command){send(command+'\r');await until(()=>$('terminal-lines').textContent.includes(marker),'workload '+name);await painted();}
  const samples=[];const renderSamples=[];const parseSamples=[];const receivedSamples=[];const payloads=[];
  for(let index=0;index<108;index++){
    if(FLOW_ONLY&&index===8)recordFrames=true;
    const tag=String(sequence+index).padStart(5,'0');const start=performance.now();
    renders.length=0;parse.length=0;deliveries.length=0;
    send('probe:'+tag+'\r');
    await until(()=>$('terminal-lines').textContent.includes('ACK:'+tag),'echo '+tag);
    const delivered=deliveries.findLast(item=>item.time>=start);
    await painted();
    if(index>=8){samples.push(performance.now()-start);renderSamples.push(renders.reduce((a,b)=>a+b,0));parseSamples.push(parse.reduce((a,b)=>a+b,0));receivedSamples.push((delivered?.time||start)-start);payloads.push(delivered?.bytes||0);}
  }
  recordFrames=false;
  const last=window.__snapshotBodies[Object.keys(window.__snapshotBodies)[0]];
  report.workloads.push({name,latencyMs:summary(samples),renderMs:summary(renderSamples),parseMs:summary(parseSamples),receiveMs:summary(receivedSamples),payloadBytes:summary(payloads),historyRows:last.terminal.history.length,domNodes:$('terminal-lines').querySelectorAll('*').length,raw:{latencyMs:samples,renderMs:renderSamples,parseMs:parseSamples,receiveMs:receivedSamples,payloadBytes:payloads}});
}
async function main(){
  await until(()=>$('connection-status').textContent==='Connected','connection');$('new').click();await until(()=>!$('directory-create').disabled,'directory');$('directory-create').click();await until(()=>$('view-status').textContent==='Controlling'&&$('terminal-lines').textContent.includes('PERF_READY'),'fixture');
  if(FLOW_ONLY){send('history\r');await until(()=>$('terminal-lines').textContent.includes('HISTORY_READY'),'flow history');await workload('active-tui-output','stream','STREAM_READY',3000);report.frameGapMs=summary(frameGaps);report.rawFrameGapMs=frameGaps;}
  else{await workload('shell-empty','', '',0);await workload('shell-history-600','history','HISTORY_READY',1000);await workload('alternate-tui','tui','TUI_READY',2000);}
  report.errors=window.__probeErrors;report.pass=!report.errors.length;
  const bytes=new TextEncoder().encode(JSON.stringify(report));document.body.dataset.probeResult=btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));
  document.body.dataset.perfWorkload='finished';
}
main().catch(error=>{document.body.dataset.probeResult=btoa(JSON.stringify({pass:false,error:String(error),errors:window.__probeErrors}));});
`;

const environment={};
for(const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP'])if(process.env[key])environment[key]=process.env[key];
let child,proxy;
try{
  const port=await freePort();
  child=spawn(resolve(runRoot,'webterminal.exe'),['--port',String(port),'--cwd',runRoot,'--shell',quote(resolve(runRoot,'perf_fixture.exe'))],{cwd:runRoot,env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await ready(port,child);proxy=await proxyFor(port,harness.replace('__FLOW_ONLY__',JSON.stringify(flowOnly)));
  let stage='',profileStarted=false,profile;
  const counters=[];
  const onPoll=process.env.WEBTERMINAL_PERF_PROFILE ? async ({protocol,evaluate})=>{
    if(!profileStarted){await protocol('Performance.enable',{});await protocol('Profiler.enable',{});await protocol('Profiler.start',{});profileStarted=true;}
    const next=await evaluate('document.body.dataset.perfWorkload||"starting"');
    if(next!==stage){counters.push({stage:next,...await protocol('Performance.getMetrics',{})});stage=next;}
    if(next==='finished'&&!profile)profile=(await protocol('Profiler.stop',{})).profile;
  } : undefined;
  const report=await chromeProbe(await findChrome(),'http://127.0.0.1:'+proxy.port+'/',resolve(runRoot,'chrome'),'probeStage',onPoll);
  assert.equal(report.pass,true,JSON.stringify(report));assert.equal(proxy.stats.upstreamErrors,0,'Upstream failures');
  report.buildDirectory=binaries;report.label=label;report.proxy=proxy.stats;
  if(profile){await writeFile(resolve(reports,label+'.cpuprofile'),JSON.stringify(profile));await writeFile(resolve(reports,label+'-counters.json'),JSON.stringify(counters,null,2));}
  await writeFile(resolve(reports,label+'.json'),JSON.stringify(report,null,2));
  for(const workload of report.workloads){const {raw,...summary}=workload;console.log(JSON.stringify(summary));}
  console.log('Report: '+resolve(reports,label+'.json'));
}finally{await stopProxy(proxy);await stopChild(child);await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
