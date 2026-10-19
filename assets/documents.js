// Reader documents: Markdown pasted or captured from the clipboard.
// Everything lives in this tab's memory; nothing reaches the server or
// browser storage. Pure logic, so Node tests can drive it.
import {markdownTitle} from './markdown.js';

export const DOCUMENT_LIMIT = 20;
export const TEXT_LIMIT = 512 * 1024;
const SNAPSHOT_LIMIT = 256;

// Short single-line copies (paths, commands, tokens) are not documents;
// a long sentence or several lines are.
export function meaningful(text) {
  const value = text.trim();
  return value.length >= 24 && (/\n\s*\S/.test(value) || /(^|\s)(#{1,6} |[-*] |\d+\. |```|\*\*)/.test(value) || value.split(/\s+/).length >= 12);
}

// The system clipboard may hand back CRLF for text written with LF.
const lines = text => String(text).replace(/\r\n?/g, '\n');

export function normalize(text) {
  const value = lines(text);
  return value.length > TEXT_LIMIT ? `${value.slice(0, TEXT_LIMIT)}\n\n*Truncated at 512 KiB.*` : value;
}

// Exact provenance for clipboard text. Only a copy Webterminal recorded with
// a terminal ID (an OSC 52 write) names a terminal; text Webterminal copied
// itself is not a new document (null); anything else is just "Clipboard".
export function clipboardSource(text, copies = []) {
  const value = lines(text), copy = copies.findLast(entry => lines(entry.text) === value);
  if (!copy) return {kind:'clipboard', id:null};
  return copy.id ? {kind:'copy', id:copy.id} : null;
}

export function filterDocuments(docs, {query = '', filter = 'all'} = {}) {
  const needle = query.trim().toLowerCase();
  return docs.filter(doc => (filter !== 'unread' || !doc.read) && (!needle || doc.title.toLowerCase().includes(needle) || doc.text.toLowerCase().includes(needle)));
}

// Up to DOCUMENT_LIMIT documents, plus the terminal name and workspace each
// source had, so a copy from a closed terminal stays named.
export class Documents {
  constructor({now = Date.now, title = markdownTitle} = {}) {
    Object.assign(this, {now, title, local:[], places:new Map(), counter:0});
  }
  // Records where a terminal is while it exists; the last record survives closure.
  remember(id, place) {
    if (!id || !place) return;
    this.places.delete(id);
    this.places.set(id, place);
    if (this.places.size > SNAPSHOT_LIMIT) this.places.delete(this.places.keys().next().value);
  }
  place(id) { return this.places.get(id) || null; }
  // Newest first.
  list() { return [...this.local].sort((a, b) => b.at - a.at); }
  find(key) { return this.local.find(doc => doc.key === key) || null; }
  // Adds pasted or captured text; identical text already listed is returned instead.
  add(text, {kind = 'pasted', id = null, shell = ''} = {}) {
    const value = normalize(text);
    if (!value.trim()) return {doc:null, added:false};
    const existing = this.local.find(doc => doc.text === value);
    if (existing) return {doc:existing, added:false};
    const doc = {key:`d:${++this.counter}`, kind, text:value, title:this.title(value), at:this.now(), id, shell, read:false};
    this.local.push(doc);
    if (this.local.length > DOCUMENT_LIMIT) this.local.splice(0, this.local.length - DOCUMENT_LIMIT);
    return {doc, added:true};
  }
  // Returns what `restore` needs to undo the removal.
  remove(doc) {
    const index = this.local.indexOf(doc);
    if (index >= 0) this.local.splice(index, 1);
    return {doc, index};
  }
  restore({doc, index}) {
    if (this.local.includes(doc)) return;
    this.local.splice(Math.min(index ?? this.local.length, this.local.length), 0, doc);
    if (this.local.length > DOCUMENT_LIMIT) this.local.splice(0, this.local.length - DOCUMENT_LIMIT);
  }
}

// Opt-in clipboard following. Reads happen only while the page is focused;
// the first read after enabling only records what was already there, a read
// that finishes after focus loss is recorded instead of captured, and a read
// started before Follow was switched off or back on is ignored.
export class ClipboardFollower {
  constructor({read, focused, capture, denied = () => {}}) {
    Object.assign(this, {read, focused, capture, denied, enabled:false, generation:0, reading:false, seen:null});
  }
  // Call from a user action so the browser can ask for permission once.
  async enable() {
    const generation = ++this.generation;
    try {
      const text = lines(await this.read());
      if (generation !== this.generation) return false;
      this.seen = text;
    } catch (error) {
      if (generation === this.generation) throw error;
      return false;
    }
    this.enabled = true;
    return true;
  }
  disable() {
    this.generation++;
    this.enabled = false;
  }
  // Text the Reader put on or took from the clipboard is not captured again.
  saw(text) { this.seen = lines(text); }
  async check() {
    if (!this.enabled || this.reading || !this.focused()) return;
    const generation = this.generation;
    this.reading = true;
    try {
      const text = lines(await this.read());
      if (generation !== this.generation || !this.enabled) return;
      if (!this.focused()) { this.seen = text; return; }
      if (text === this.seen) return;
      const primed = this.seen !== null;
      this.seen = text;
      if (primed) this.capture(text);
    } catch (error) {
      // A read refused while still focused means permission was withdrawn.
      if (generation === this.generation && this.enabled && this.focused()) this.denied(error);
    } finally { this.reading = false; }
  }
}
