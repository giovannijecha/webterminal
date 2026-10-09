// A small CommonMark/GFM subset rendered straight to DOM nodes. Text is never
// parsed as HTML, so pasted content cannot inject markup or scripts.

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const PUNCTUATION = /[!-/:-@[-`{-~]/;
const ENTITIES = {amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', copy:'©', reg:'®', hellip:'…', mdash:'—', ndash:'–', rarr:'→', larr:'←'};
const MAX_DEPTH = 12;

export function renderMarkdown(text) {
  const fragment = document.createDocumentFragment();
  blocks(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'), fragment, 0);
  return fragment;
}

function element(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function interrupts(line) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || /^ {0,3}([-+*]|1[.)])[ \t]+\S/.test(line);
}

function blocks(lines, parent, depth) {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let match;
    if (!line.trim()) { i++; continue; }
    if ((match = line.match(FENCE))) {
      const [, fence, language] = match, indent = line.length - line.trimStart().length, body = [];
      for (i++; i < lines.length; i++) {
        const close = lines[i].trim();
        if (close.length >= fence.length && close === fence[0].repeat(close.length) && /^ {0,3}\S/.test(lines[i])) { i++; break; }
        body.push(lines[i].replace(new RegExp(`^ {0,${indent}}`), ''));
      }
      parent.append(code(body.join('\n'), language));
    } else if ((match = line.match(HEADING))) {
      parent.append(element(`h${match[1].length}`, '', ...inline(match[2] || '', depth)));
      i++;
    } else if (RULE.test(line)) {
      parent.append(document.createElement('hr'));
      i++;
    } else if (QUOTE.test(line) && depth < MAX_DEPTH) {
      const body = [];
      while (i < lines.length && lines[i].trim() && (QUOTE.test(lines[i]) || !interrupts(lines[i]))) body.push(lines[i++].replace(QUOTE, ''));
      const quote = document.createElement('blockquote');
      blocks(body, quote, depth + 1);
      parent.append(quote);
    } else if (ITEM.test(line) && depth < MAX_DEPTH) {
      i = list(lines, i, parent, depth);
    } else if (/^ {4}/.test(line)) {
      const body = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || !lines[i].trim())) body.push(lines[i++].slice(4));
      while (body.length && !body.at(-1).trim()) body.pop();
      parent.append(code(body.join('\n'), ''));
    } else if (line.includes('|') && DELIMITER.test(lines[i + 1] || '') && lines[i + 1].includes('-')) {
      i = table(lines, i, parent, depth);
    } else {
      const body = [line];
      for (i++; i < lines.length && lines[i].trim() && !interrupts(lines[i]); i++) {
        if (SETEXT.test(lines[i]) || (lines[i].includes('|') && DELIMITER.test(lines[i + 1] || '') && lines[i + 1].includes('-'))) break;
        body.push(lines[i]);
      }
      const setext = i < lines.length && lines[i].trim() && SETEXT.exec(lines[i]);
      if (setext) i++;
      const content = inline(body.map(text => text.replace(/^ +/, '')).join('\n').trimEnd(), depth);
      parent.append(element(setext ? (setext[1][0] === '=' ? 'h1' : 'h2') : 'p', '', ...content));
    }
  }
}

function code(text, language) {
  const figure = element('div', 'md-code');
  const bar = element('div', 'md-code-bar', element('span', 'md-code-language', language || 'text'));
  const pre = element('pre', '', element('code', '', text));
  if (language) pre.firstChild.dataset.language = language;
  figure.append(bar, pre);
  return figure;
}

function list(lines, start, parent, depth) {
  const first = lines[start].match(ITEM), ordered = /\d/.test(first[2]), marker = first[2].slice(-1);
  const node = document.createElement(ordered ? 'ol' : 'ul');
  if (ordered && parseInt(first[2], 10) !== 1) node.start = parseInt(first[2], 10);
  let i = start, loose = false;
  while (i < lines.length) {
    const match = lines[i].match(ITEM);
    if (!match || /\d/.test(match[2]) !== ordered || match[2].slice(-1) !== marker || RULE.test(lines[i])) break;
    const gap = match[3].length > 4 ? 1 : Math.max(1, match[3].length);
    const indent = match[1].length + match[2].length + gap;
    const body = [lines[i].slice(match[0].length - match[3].length + gap)];
    let blank = false;
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { blank = true; body.push(''); continue; }
      // Agents often nest two spaces under `1.`; a deeper marker still nests.
      const lead = line.length - line.trimStart().length;
      if (lead >= indent || (lead > match[1].length && ITEM.test(line))) { body.push(line.slice(Math.min(lead, indent))); blank = false; continue; }
      if (blank || ITEM.test(line) || interrupts(line)) break;
      body.push(line.trimStart());
    }
    while (body.length && !body.at(-1).trim()) body.pop();
    if (blank && i < lines.length && ITEM.test(lines[i])) loose = true;
    if (body.some((line, index) => !line.trim() && index < body.length - 1 && body[index + 1].trim() && !/^ /.test(body[index + 1]))) loose = true;
    node.append(listItem(body, depth));
  }
  node.classList.toggle('loose', loose);
  parent.append(node);
  return i;
}

function listItem(body, depth) {
  const item = document.createElement('li');
  const task = body[0].match(/^\[([ xX])\][ \t]+/);
  if (task) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.disabled = true;
    box.checked = task[1] !== ' ';
    item.className = 'md-task';
    item.append(box);
    body[0] = body[0].slice(task[0].length);
  }
  blocks(body, item, depth + 1);
  return item;
}

function cells(line) {
  const text = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const result = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && text[i + 1] === '|') { current += '|'; i++; } else if (text[i] === '|') { result.push(current.trim()); current = ''; } else current += text[i];
  }
  result.push(current.trim());
  return result;
}

function table(lines, start, parent, depth) {
  const head = cells(lines[start]);
  const align = cells(lines[start + 1]).map(cell => cell.endsWith(':') ? (cell.startsWith(':') ? 'center' : 'right') : cell.startsWith(':') ? 'left' : '');
  const row = (values, tag) => element('tr', '', ...head.map((_, index) => element(tag, align[index] ? `align-${align[index]}` : '', ...inline(values[index] || '', depth))));
  const body = document.createElement('tbody');
  let i = start + 2;
  for (; i < lines.length && lines[i].trim() && lines[i].includes('|') && !interrupts(lines[i]); i++) body.append(row(cells(lines[i]), 'td'));
  parent.append(element('div', 'md-table', element('table', '', element('thead', '', row(head, 'th')), body)));
  return i;
}

function decodeEntity(text) {
  const match = text.match(/^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));/);
  if (!match) return null;
  const value = match[1] ? Number(match[1]) : match[2] ? parseInt(match[2], 16) : null;
  if (value !== null) return value > 0 && value <= 0x10ffff ? [String.fromCodePoint(value), match[0].length] : null;
  return ENTITIES[match[3]] ? [ENTITIES[match[3]], match[0].length] : null;
}

function safeUrl(url) {
  const trimmed = url.trim().replace(/^<|>$/g, '');
  return /^(https?:\/\/|mailto:)/i.test(trimmed) ? trimmed : null;
}

function link(href, children) {
  const url = safeUrl(href);
  if (!url) return element('span', 'md-link-text', ...children);
  const anchor = element('a', '', ...children);
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.title = url;
  return anchor;
}

// Finds `](target)` after a bracketed label that starts at `open`.
function linkAt(text, open) {
  let level = 0, close = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '[') level++;
    else if (text[i] === ']' && --level === 0) { close = i; break; }
  }
  if (close < 0 || text[close + 1] !== '(') return null;
  let level2 = 0, end = -1;
  for (let i = close + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '(') level2++;
    else if (text[i] === ')' && --level2 === 0) { end = i; break; }
  }
  if (end < 0) return null;
  const target = text.slice(close + 2, end).trim().match(/^(<[^>]*>|\S+)(?:\s+["'(].*["')])?$/);
  return target ? {label:text.slice(open + 1, close), href:target[1], end:end + 1} : null;
}

function inline(text, depth) {
  const out = [];
  let buffer = '';
  const flush = () => { if (buffer) { out.push(document.createTextNode(buffer)); buffer = ''; } };
  const push = node => { flush(); out.push(node); };
  for (let i = 0; i < text.length;) {
    const char = text[i], rest = text.slice(i);
    let match;
    if (char === '\\' && text[i + 1] === '\n') { push(document.createElement('br')); i += 2; continue; }
    if (char === '\\' && PUNCTUATION.test(text[i + 1] || '')) { buffer += text[i + 1]; i += 2; continue; }
    if (char === '\n') {
      if (/ {2,}$/.test(buffer)) { buffer = buffer.trimEnd(); push(document.createElement('br')); } else buffer = buffer.trimEnd() + '\n';
      i++;
      while (text[i] === ' ') i++;
      continue;
    }
    if (char === '`') {
      const run = rest.match(/^`+/)[0], close = text.indexOf(run, i + run.length);
      let end = close;
      while (end >= 0 && text[end + run.length] === '`') end = text.indexOf(run, end + run.length + 1);
      if (end >= 0) {
        let content = text.slice(i + run.length, end).replace(/\n/g, ' ');
        if (/^ .*[^ ].* $/.test(content)) content = content.slice(1, -1);
        push(element('code', '', content));
        i = end + run.length;
        continue;
      }
      buffer += run; i += run.length; continue;
    }
    if (char === '&' && (match = decodeEntity(rest))) { buffer += match[0]; i += match[1]; continue; }
    if (char === '<' && (match = rest.match(/^<((?:https?:\/\/|mailto:)[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/i))) {
      const href = match[1].includes(':') ? match[1] : `mailto:${match[1]}`;
      push(link(href, [match[1]])); i += match[0].length; continue;
    }
    if ((char === 'h' || char === 'H') && (match = rest.match(/^https?:\/\/[^\s<]+/i)) && !/[\w/]$/.test(buffer)) {
      let url = match[0].replace(/[.,:;!?'"*_~]+$/, '');
      while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
      push(link(url, [url])); i += url.length; continue;
    }
    if ((char === '[' || (char === '!' && text[i + 1] === '[')) && depth < MAX_DEPTH && (match = linkAt(text, char === '!' ? i + 1 : i))) {
      const label = inline(match.label, depth + 1);
      if (char === '!') { const anchor = link(match.href, label.length ? label : ['image']); anchor.classList.add('md-image'); push(anchor); }
      else push(link(match.href, label));
      i = match.end; continue;
    }
    if ((char === '*' || char === '_' || char === '~') && depth < MAX_DEPTH && (match = emphasis(text, i))) {
      push(element(match.tag, '', ...inline(match.content, depth + 1)));
      i = match.end; continue;
    }
    buffer += char; i++;
  }
  flush();
  return out;
}

function emphasis(text, i) {
  const char = text[i], run = text.slice(i).match(char === '*' ? /^\*+/ : char === '_' ? /^_+/ : /^~+/)[0];
  const before = text[i - 1] || ' ', after = text[i + run.length] || ' ';
  if (/\s/.test(after)) return null;
  if (char === '_' && /[\p{L}\p{N}]/u.test(before)) return null;
  const sizes = char === '~' ? (run.length === 2 ? [2] : []) : run.length >= 3 ? [3, 2, 1] : run.length === 2 ? [2, 1] : [1];
  for (const size of sizes) {
    const delimiter = char.repeat(size);
    for (let close = text.indexOf(delimiter, i + size + 1); close >= 0; close = text.indexOf(delimiter, close + 1)) {
      if (/\s/.test(text[close - 1]) || text[close - 1] === '\\' || (size < 3 && text[close - 1] === char)) continue;
      if (char === '_' && /[\p{L}\p{N}]/u.test(text[close + size] || ' ')) continue;
      if (text[close + size] === char && size < 3) continue;
      const content = text.slice(i + size, close);
      if (!content.trim()) continue;
      if (size === 3) return {tag:'strong', content:`${char}${content}${char}`, end:close + 3};
      return {tag:char === '~' ? 'del' : size === 2 ? 'strong' : 'em', content, end:close + size};
    }
  }
  return null;
}

// Returns a short title: the first heading, otherwise the first line of prose.
export function markdownTitle(text) {
  for (const line of text.split(/\r?\n/)) {
    const value = line.replace(/^ {0,3}(#{1,6}|>|[-+*]|\d+[.)])\s+/, '').replace(/\]\([^)]*\)/g, '').replace(/[*_`~#[\]]/g, '').trim();
    if (value && !FENCE.test(line) && !RULE.test(line) && !DELIMITER.test(line)) return value.length > 80 ? `${value.slice(0, 79)}…` : value;
  }
  return 'Untitled';
}
