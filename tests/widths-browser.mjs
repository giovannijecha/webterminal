// Real ConPTY -> Rust projection/ordered updates -> product DOM regression.
// Uses only an owned child, a private server/config and a disposable Chrome profile.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {copyFile, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromeProbe, findChrome, freePort, proxyFor, quote, ready, stopChild, stopProxy} from './cli-browser-support.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const binaries = resolve(process.env.WEBTERMINAL_TEST_BIN_DIR || join(root, 'target/debug'));
const scratch = join(root, '.tmp');
await mkdir(scratch, {recursive:true});
const runRoot = await mkdtemp(join(scratch, 'widths-'));
const reports = process.env.WEBTERMINAL_WIDTH_REPORT_DIR || join(scratch, `width-reports-${process.pid}-${Date.now()}`);

const harness = String.raw`
import {cellsOf, lineText} from '/render.js';
const $ = id => document.getElementById(id);
const checks = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) {
  for (let i = 0; i < 300; i++) { const value = test(); if (value) return value; await pause(30); }
  throw new Error('Timed out: ' + label);
}
function check(value, label) { if (!value) throw new Error(label); checks.push(label); }
function publish(report) {
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  document.body.dataset.probeResult = btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
}
async function main() {
  await until(() => document.body.dataset.viewportReady && $('connection-status').textContent === 'Connected', 'connection');
  $('new').click();
  const launcher = await until(() => document.querySelector('dialog.launcher[open]'), 'launcher');
  launcher.querySelector('.dlg-foot .btn.primary').click();
  await until(() => $('pane').dataset.status === 'Controlling' && $('terminal-lines').textContent.includes('WIDTH_READY'), 'native fixture');
  const id = (await (await fetch('/api/sessions')).json()).sessions[0].id;
  const peer = new WebSocket('ws://' + location.host + '/ws');
  let latest, seq = 0;
  const errors = [];
  peer.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.type === 'snapshot' && message.id === id) latest = message;
    if (message.type === 'error') errors.push(message);
  });
  await new Promise((resolve, reject) => { peer.onopen = resolve; peer.onerror = reject; });
  const send = message => peer.send(JSON.stringify({id, ...message}));
  send({op:'attach', cols:80, rows:10});
  await until(() => latest, 'test observer');
  send({op:'claim', cols:80, rows:10});
  await until(() => $('pane').dataset.status === 'Observing' && latest.terminal.cols === 80, 'test controller');
  // The UI observes while a second view controls exact acceptance geometries.
  // Its real socket still receives and renders the product's ordered updates.
  async function command(data, title) {
    send({op:'input', epoch:latest.epoch, seq:++seq, data:data+'\r'});
    await until(() => window.__snapshotBodies[id]?.terminal.title === title, title);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  function verify(cols, status, done) {
    const term = window.__snapshotBodies[id].terminal;
    const rows = [...$('terminal-lines').children];
    const texts = term.screen.map(lineText);
    const label = cols + ' columns / ' + status;
    const header = 'Sidebar chiara su desktop, ☰ a scomparsa su mobile';
    const footer = 'Footer: Enter accepts / Esc cancels / ☰ menu';
    check(term.cols === cols && !term.history.length, label + ': geometry and no spurious history');
    check(texts[0] === header + ' '.repeat(cols - [...header].length - 1) + '|', label + ': intact symbol row');
    const source = 'ASK USER: Keep every word of this long answer in order without stale status lines. ';
    const answer = source.repeat(10).slice(0, cols * 2 + 13);
    for (let row = 0; row < 3; row++) check(texts[row+1].trimEnd() === answer.slice(row*cols,(row+1)*cols).trimEnd(), label + ': answer row ' + row);
    check(texts[4].trimEnd() === status && texts.slice(6).every(text => !text.trim()), label + ': one status without stale rows');
    check(texts[5] === footer + ' '.repeat(cols - [...footer].length - 6) + (done ? 'READY|' : 'WAIT |'), label + ': full-width footer');
    check(rows.length === term.rows && rows.every((row,index) => row.textContent === texts[index]), label + ': DOM matches Rust state');
    check(term.screen.every(row => cellsOf(row).every(cell => cell[1] === 1)), label + ': one-cell serialized layout');
    const symbol = [...rows[0].querySelectorAll('.term-cell')].find(node => node.textContent === '☰');
    const cellWidth = parseFloat(getComputedStyle($('terminal-lines')).getPropertyValue('--cell-width'));
    check(symbol && !symbol.classList.contains('wide') && Math.abs(symbol.getBoundingClientRect().width - cellWidth) < .1, label + ': symbol paints one cell');
    const spans = [...rows[5].querySelectorAll('.term-cell')];
    const first = spans[0].getBoundingClientRect(), last = spans.at(-1).getBoundingClientRect();
    check(Math.abs(last.right - first.left - cols * cellWidth) < 1 && Math.abs(first.top-last.top) < .1, label + ': footer fits one rendered row');
    if (done) check(term.cursor[0] === 4 && term.cursor[1] === 4, label + ': cursor after partial updates');
  }
  for (const cols of [80,144,145]) {
    send({op:'resize', epoch:latest.epoch, cols, rows:10});
    await until(() => latest.terminal.cols === cols && window.__snapshotBodies[id]?.terminal.cols === cols, 'resize ' + cols);
    await command('draw', 'WIDTH_DRAWN'); verify(cols, 'Thinking', false);
    await command('work', 'WIDTH_WORKING'); verify(cols, 'Working', false);
    await command('done', 'WIDTH_DONE'); verify(cols, 'Done', true);
    document.body.dataset.capture = String(cols);
    await until(() => document.body.dataset.captured === String(cols), 'screenshot ' + cols);
  }
  check(errors.length === 0 && window.__probeErrors.length === 0, 'no protocol or browser errors');
  send({op:'input', epoch:latest.epoch, seq:++seq, data:'quit\r'});
  peer.close();
  publish({pass:true, checks, userAgent:navigator.userAgent});
}
main().catch(error => publish({pass:false, checks, error:String(error.stack || error), errors:window.__probeErrors, state:{connection:$('connection-status')?.textContent,viewport:document.body.dataset.viewportReady,text:$('terminal-lines')?.textContent,wire:window.__wire.slice(-10)}}));
`;

let child, proxy, viewportReady = false, lastCapture = '';
try {
  await mkdir(reports, {recursive:true});
  for (const name of ['webterminal.exe', 'native_fixture.exe']) await copyFile(join(binaries,name),join(runRoot,name));
  const env = {};
  for (const key of ['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP']) if (process.env[key]) env[key] = process.env[key];
  const port = await freePort();
  child = spawn(join(runRoot,'webterminal.exe'), ['--port',String(port),'--cwd',runRoot,'--config',join(runRoot,'settings.json'),'--shell',quote(join(runRoot,'native_fixture.exe'))+' --width-ui'], {cwd:runRoot,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  await ready(port,child);
  proxy = await proxyFor(port,harness);
  const report = await chromeProbe(await findChrome(),'http://127.0.0.1:'+proxy.port+'/',join(runRoot,'chrome'),'widthStage',async ({protocol,evaluate}) => {
    if (!viewportReady) {
      await protocol('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
      viewportReady = true;
    }
    await evaluate('if(document.body) document.body.dataset.viewportReady="true"');
    const capture = await evaluate('document.body.dataset.capture || ""');
    if (capture && capture !== lastCapture) {
      const shot = await protocol('Page.captureScreenshot',{format:'png'});
      await writeFile(join(reports,'width-'+capture+'.png'),Buffer.from(shot.data,'base64'));
      await evaluate('document.body.dataset.captured='+JSON.stringify(capture));
      lastCapture = capture;
    }
  });
  await writeFile(join(reports,'verification.json'),JSON.stringify(report,null,2));
  assert.equal(report.pass,true,JSON.stringify(report));
  assert.equal(proxy.stats.upstreamErrors,0,'Upstream failures');
  console.log(JSON.stringify({pass:true,checks:report.checks.length,reports}));
} finally {
  await stopProxy(proxy);
  await stopChild(child);
  await rm(runRoot,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
