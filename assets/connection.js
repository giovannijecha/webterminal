// The WebSocket connection, request numbering and the terminal input pump.
// Input is chunked and paced so a large paste never floods the socket.
import {state, canInput} from './model.js';

const MAX_QUEUED_INPUT = 1024 * 1024, MAX_SOCKET_BUFFER = 128 * 1024, CHUNK = 4096;
const encoder = new TextEncoder();
const hooks = {message() {}, opened() {}, closed() {}, problem() {}};
const sequences = new Map();
let request = 0, reconnect = 0, timer = 0, queued = 0, queue = [];

export function configure(next) { Object.assign(hooks, next); }

export function nextRequest() {
  if (request === Number.MAX_SAFE_INTEGER) request = 0;
  return ++request;
}

// Returns false, after telling the user why, when the command was not sent.
export function send(command, {quiet = false} = {}) {
  if (state.socket?.readyState !== WebSocket.OPEN) { if (!quiet) hooks.problem('Connection is unavailable. Reconnecting…'); return false; }
  const payload = JSON.stringify(command);
  if (state.socket.bufferedAmount + encoder.encode(payload).length > MAX_SOCKET_BUFFER) { if (!quiet) hooks.problem('Connection is busy. Try again shortly.'); return false; }
  state.socket.send(payload);
  return true;
}

// Sends a command and resolves with its reply: the message `reply` accepts,
// a `busy` answer for the same operation, or null when it was not sent.
// An `error` for the same operation and target rejects.
const waiting = new Set();
export function ask(command, reply = () => false) {
  const request = ['create', 'create-workspace'].includes(command.op) ? nextRequest() : undefined;
  const message = request ? {...command, request} : command;
  return new Promise((resolve, reject) => {
    if (!send(message)) { resolve(null); return; }
    waiting.add({op:command.op, id:command.id, request, reply, resolve, reject});
  });
}
// Returns true when a waiting command consumed the message.
export function settle(message) {
  for (const entry of waiting) {
    const same = message.op === entry.op && (entry.request ? message.request === entry.request : !entry.id || message.id === entry.id);
    if (message.type === 'error' && same) { waiting.delete(entry); entry.reject(new Error(message.message || 'The request failed.')); return true; }
    if ((message.type === 'busy' && same) || (message.type !== 'error' && (entry.request ? message.request === entry.request : entry.reply(message)))) {
      waiting.delete(entry);
      entry.resolve(message);
      return true;
    }
  }
  return false;
}
function abandon() {
  for (const entry of waiting) entry.reject(new Error('The connection closed before the server answered.'));
  waiting.clear();
}

export function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket = socket;
  state.connected = false;
  socket.addEventListener('open', () => { reconnect = 0; hooks.opened(); });
  socket.addEventListener('message', event => {
    if (state.socket !== socket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    hooks.message(message);
  });
  socket.addEventListener('close', event => {
    if (state.socket !== socket) return;
    state.connected = false;
    state.view = null;
    clearInput();
    abandon();
    // A server that announced its own shutdown is not reconnected to.
    const retry = !state.stopping;
    hooks.closed(event);
    if (retry) setTimeout(connect, Math.min(8000, 350 * 2 ** reconnect++));
  });
  socket.addEventListener('error', () => socket.close());
}

export function resetInput() { sequences.clear(); clearInput(); }
export function clearInput() {
  queue = [];
  queued = 0;
  clearTimeout(timer);
  timer = 0;
}
export function discardInput(id) {
  queue = queue.filter(message => message.id !== id);
  queued = queue.reduce((total, message) => total + message.bytes, 0);
}

// Queues input for a terminal this view controls; returns a problem or ''.
export function queueInput(id, data) {
  const shot = state.snapshots.get(id);
  if (!data || !canInput(id)) return '';
  const bytes = encoder.encode(data).length;
  if (bytes + queued > MAX_QUEUED_INPUT) return 'Terminal input is backed up or exceeds the 1 MiB limit.';
  let chunk = '', count = 0;
  const push = () => queue.push({id, epoch:shot.epoch, data:chunk, bytes:encoder.encode(chunk).length});
  for (const character of data) {
    chunk += character;
    if (++count === CHUNK) { push(); chunk = ''; count = 0; }
  }
  if (chunk) push();
  queued += bytes;
  if (!timer) pump();
  return '';
}

function pump() {
  timer = 0;
  const next = queue[0];
  if (!next) return;
  if (!canInput(next.id) || state.snapshots.get(next.id)?.epoch !== next.epoch) {
    discardInput(next.id);
    if (queue.length) pump();
    return;
  }
  const seq = (sequences.get(next.id) || 0) + 1;
  const payload = JSON.stringify({op:'input', id:next.id, epoch:next.epoch, seq, data:next.data});
  if (state.socket?.readyState !== WebSocket.OPEN) { clearInput(); return; }
  if (state.socket.bufferedAmount + encoder.encode(payload).length > MAX_SOCKET_BUFFER) { timer = setTimeout(pump, 20); return; }
  state.socket.send(payload);
  sequences.set(next.id, seq);
  queue.shift();
  queued -= next.bytes;
  if (queue.length) timer = setTimeout(pump, 5);
}
