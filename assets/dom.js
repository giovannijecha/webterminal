// Small DOM and formatting helpers shared by every workbench view.
import {displayPath} from './common.js';

export const $ = id => document.getElementById(id);

const PROPERTIES = new Set(['value', 'checked', 'indeterminate']);

// Creates an element: `class`, `text`, `dataset`, `on<event>` and properties
// are special; any other key becomes an attribute (true → empty value).
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (PROPERTIES.has(key)) node[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  node.append(...children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

export function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon${className ? ` ${className}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

export function badge(label, tone = 'neutral', extra = {}) {
  return el('span', {class:'status-badge', 'data-tone':tone, ...extra}, el('span', {class:'status-label', text:label}));
}

export function counter(count, tone = 'neutral', label = '') {
  return el('span', {class:'status-counter', 'data-tone':tone, title:label || undefined, 'aria-label':label || undefined, text:String(count)});
}

export function avatar(family, name, size = '') {
  const initial = [...(name || '?').trim()][0]?.toUpperCase() || '?';
  return el('span', {class:`avatar${size ? ` ${size}` : ''}`, 'data-family':String(family % 6), 'aria-hidden':'true', text:initial});
}

export function plural(count, word, many = `${word}s`) { return `${count} ${count === 1 ? word : many}`; }

export function ago(ms, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// "up 2h 14m", read after a status such as "Connected · ".
export function uptime(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60000), hours = Math.floor(minutes / 60);
  if (hours >= 48) return `up ${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours ? `up ${hours}h ${minutes % 60}m` : `up ${minutes}m`;
}

export function clock(ms) {
  return new Date(ms).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
}

export function bytes(size) {
  if (!Number.isFinite(size)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}

// A Windows path with break opportunities after each separator.
export function pathText(path, className = 'mono') {
  const span = el('span', {class:className, title:displayPath(path)});
  const parts = displayPath(path).split(/(?<=[\\/])/);
  parts.forEach((part, index) => { span.append(part); if (index < parts.length - 1) span.append(el('wbr')); });
  return span;
}

// Replaces a container's children only when its rendering key changed.
export function patch(container, key, build) {
  if (container.dataset.key === key) return false;
  container.dataset.key = key;
  container.replaceChildren(...[build()].flat(Infinity).filter(Boolean));
  return true;
}

export function storage(kind = 'session') {
  const area = () => kind === 'local' ? localStorage : sessionStorage;
  return {
    get(key) { try { return area().getItem(key); } catch { return null; } },
    set(key, value) { try { area().setItem(key, value); } catch { /* A per-view convenience only. */ } },
  };
}
