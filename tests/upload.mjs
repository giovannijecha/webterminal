import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {DROP_LIMIT, FILE_LIMIT, dropProblem, droppedFiles, pathList, uploadFiles} from '../assets/upload.js';

const file = (name, size = 1) => ({name, size});

test('drops keep files in order and skip folders', () => {
  const a = file('a.txt'), b = file('b.png');
  const item = (value, directory = false) => ({kind:'file', getAsFile:() => value, webkitGetAsEntry:() => ({isDirectory:directory})});
  const transfer = {items:[item(a), item(file('folder', 0), true), {kind:'string'}, item(b)], files:[]};
  assert.deepEqual(droppedFiles(transfer), [a, b]);
  assert.deepEqual(droppedFiles({items:[], files:[a]}), [a]);
  assert.deepEqual(droppedFiles(null), []);
});

test('staged paths are pasted quoted and space separated', () => {
  assert.equal(pathList(['C:\\Temp\\a b.txt', 'C:\\Temp\\c.pdf']), "'C:\\Temp\\a b.txt' 'C:\\Temp\\c.pdf'");
  assert.equal(pathList(["C:\\Temp\\a'b $x ` $(1+2).txt"]), "'C:\\Temp\\a''b $x ` $(1+2).txt'");
  assert.equal(pathList(['C:\\Temp\\a b.txt'], '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoProfile'), "'C:\\Temp\\a b.txt'");
  assert.equal(pathList(['C:\\Temp\\a b.txt'], 'cmd.exe'), '"C:\\Temp\\a b.txt"');
  assert.equal(pathList(['C:\\Temp\\a b.txt'], 'wsl.exe'), '"C:\\Temp\\a b.txt"');
  assert.throws(() => pathList(['C:\\Temp\\a%PATH%.txt'], 'cmd.exe'), /cmd\.exe.*%/);
  assert.throws(() => pathList(['C:\\Temp\\a!PATH!.txt'], 'cmd.exe /v:on'), /cmd\.exe.*!/);
});

test('staged path round trips through the default PowerShell shell', {skip:process.platform !== 'win32'}, () => {
  const path = "C:\\Temp\\a'b $x ` $(1+2) & [one] ; 日本.txt";
  const command = `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(${pathList([path])}))`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {encoding:'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Buffer.from(result.stdout.trim(), 'base64').toString('utf8'), path);
});

test('drops are bounded before anything is uploaded', () => {
  assert.equal(dropProblem([file('a')]), null);
  assert.match(dropProblem(Array.from({length:DROP_LIMIT + 1}, (_, i) => file(`${i}`))), /at most 64/);
  assert.match(dropProblem([file('huge.iso', FILE_LIMIT + 1)]), /huge\.iso is larger than 1 GiB/);
  assert.match(dropProblem([file('a%PATH%.txt')], 'cmd.exe'), /cmd\.exe.*%/);
  assert.match(dropProblem([file('a!PATH!.txt')], 'cmd.exe /v:on'), /cmd\.exe.*!/);
  assert.equal(dropProblem([file('a%PATH%.txt')], 'powershell.exe'), null);
});

test('uploads go one at a time to the controlling view and stop at the first failure', async () => {
  const calls = [];
  const request = async (url, options) => {
    calls.push({url, options});
    if (calls.length === 3) return {ok:false, json:async () => ({error:'Control changed'})};
    return {ok:true, json:async () => ({path:`C:\\staged\\${calls.length}`})};
  };
  const files = [file('report 日本.pdf'), file('a&b=c.txt')];
  const paths = await uploadFiles(files, {id:'s1', view:'v7', epoch:3}, request);
  assert.deepEqual(paths, ['C:\\staged\\1', 'C:\\staged\\2']);
  assert.equal(calls[0].url, `/api/upload?id=s1&view=v7&epoch=3&name=${encodeURIComponent('report 日本.pdf')}`);
  assert.equal(calls[1].url.endsWith('name=a%26b%3Dc.txt'), true);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.body, files[0]);
  const delivered = [];
  await uploadFiles([file('once')], {id:'s1', view:'v7', epoch:3},
    async () => ({ok:true, json:async () => ({path:'C:\\staged\\once'})}), path => delivered.push(path));
  assert.deepEqual(delivered, ['C:\\staged\\once']);
  await assert.rejects(uploadFiles([file('x.bin'), file('never')], {id:'s1', view:'v7', epoch:3}, request), /x\.bin was not uploaded: Control changed/);
  assert.equal(calls.length, 3);
  await assert.rejects(uploadFiles([file('y')], {id:'s1', view:'v7', epoch:3}, async () => { throw new TypeError('network'); }), /y was not uploaded\./);
});

test('completed uploads are delivered before a later file fails', async () => {
  const delivered = [];
  let calls = 0;
  const request = async () => ++calls === 1
    ? {ok:true, json:async () => ({path:'C:\\staged\\first'})}
    : {ok:false, json:async () => ({error:'Connection lost'})};
  await assert.rejects(uploadFiles([file('first'), file('second'), file('third')],
    {id:'s1', view:'v7', epoch:3}, request, path => delivered.push(path)), /second was not uploaded: Connection lost/);
  assert.deepEqual(delivered, ['C:\\staged\\first']);
  assert.equal(calls, 2);
});
