const DEFAULT_FG = '#d4d4d4';
const DEFAULT_BG = '#121314';

function safeLink(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function lineText(line) {
  return (line?.cells || []).filter(cell => cell[1] !== 0).map(cell => cell[0] || ' ').join('');
}

export class TerminalRenderer {
  constructor(scroll, lines) {
    this.scroll = scroll;
    this.lines = lines;
    this.snapshot = null;
    this.search = '';
    this.matches = [];
    this.matchIndex = -1;
    this.frozen = false;
    this.pending = null;
    this.rowCache = [];
    this.lineCache = new WeakMap();
    this.measure();
    new ResizeObserver(() => this.measure()).observe(scroll);
  }

  measure() {
    const style = getComputedStyle(this.lines);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `${style.fontSize} ${style.fontFamily}`;
    this.cellWidth = context.measureText('M').width || 8;
    this.lineHeight = parseFloat(style.lineHeight) || 19;
    this.lines.style.setProperty('--cell-width', `${this.cellWidth}px`);
  }

  dimensions() {
    this.measure();
    const style = getComputedStyle(this.scroll);
    const width = (this.scroll.clientWidth || window.innerWidth) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = (this.scroll.clientHeight || Math.max(300, window.innerHeight - 125)) - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return {cols: Math.max(2, Math.min(300, Math.floor(width / this.cellWidth))), rows: Math.max(2, Math.min(120, Math.floor(height / this.lineHeight)))};
  }

  setFrozen(value) {
    this.frozen = value;
    if (!value && this.pending) {
      const pending = this.pending;
      this.pending = null;
      this.render(pending);
    }
  }

  clear() {
    this.snapshot = null;
    this.pending = null;
    this.frozen = false;
    this.rowCache = [];
    this.lineCache = new WeakMap();
    this.matches = [];
    this.matchIndex = -1;
    this.lines.replaceChildren();
  }

  setSearch(query) {
    this.search = query.toLocaleLowerCase();
    this.matchIndex = -1;
    if (this.snapshot) this.render(this.snapshot, true);
    return this.matches.length;
  }

  nextMatch(direction) {
    if (!this.matches.length) return null;
    this.matchIndex = (this.matchIndex + direction + this.matches.length) % this.matches.length;
    this.highlightActive();
    const match = this.matches[this.matchIndex];
    this.lines.children[match.line]?.scrollIntoView({block: 'center'});
    return {index: this.matchIndex + 1, total: this.matches.length};
  }

  highlightActive() {
    this.lines.querySelectorAll('.active-match').forEach(node => node.classList.remove('active-match'));
    const match = this.matches[this.matchIndex];
    if (!match) return;
    const row = this.lines.children[match.line];
    row?.querySelectorAll('.match').forEach(node => {
      if (+node.dataset.end > match.start && +node.dataset.start < match.end) node.classList.add('active-match');
    });
  }

  render(snapshot, force = false) {
    if (this.frozen && !force) { this.pending = snapshot; return; }
    const term = snapshot?.terminal;
    if (!term) return;
    const history = term.alternate ? [] : term.history || [];
    const all = history.concat(term.screen || []);
    const nearBottom = this.scroll.scrollHeight - this.scroll.clientHeight - this.scroll.scrollTop < this.lineHeight * 2;
    const oldTop = this.scroll.scrollTop;
    const oldHeight = this.scroll.scrollHeight;
    this.snapshot = snapshot;
    this.matches = [];
    const query = this.search;
    const reusable = new Map();
    if (!force) for (const item of this.rowCache) {
      if (!reusable.has(item.key)) reusable.set(item.key, []);
      reusable.get(item.key).push(item.row);
    }
    const nextCache = [];
    for (let index = 0; index < all.length; index++) {
      const line = all[index];
      let info = this.lineCache.get(line);
      if (!info) {
        info = {text:lineText(line), key:JSON.stringify(line)};
        this.lineCache.set(line, info);
      }
      const text = info.text;
      const hitRanges = [];
      if (query) {
        const source = text.toLocaleLowerCase();
        let from = 0;
        while (from <= source.length - query.length && this.matches.length < 10000) {
          const start = source.indexOf(query, from);
          if (start < 0) break;
          const end = start + query.length;
          this.matches.push({line: index, start, end});
          hitRanges.push({start, end});
          from = Math.max(start + 1, end);
        }
      }
      const cursor = term.cursor || [];
      const cursorKey = snapshot.controller && snapshot.alive && index === history.length + cursor[1] && cursor[2] ? `${cursor[0]}:${cursor[3]}` : '';
      const key = `${info.key}|${cursorKey}`;
      const cached = reusable.get(key)?.shift();
      if (cached) {
        cached.dataset.index = index;
        nextCache.push({key, row:cached});
        continue;
      }
      const row = document.createElement('div');
      row.className = 'term-line';
      row.dataset.index = index;
      row.dataset.wrapped = line?.wrapped ? 'true' : 'false';
      row.setAttribute('aria-label', text);
      let offset = 0;
      let column = 0;
      const cells = line?.cells || [];
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
        const cell = cells[cellIndex];
        const width = cell[1];
        if (width === 0) continue;
        let content = cell[0] || ' ';
        let columns = width === 2 ? 2 : 1;
        const attr = Number(cell[4]) || 0;
        const cursorHere = snapshot.controller && snapshot.alive && index === history.length + cursor[1] && column <= cursor[0] && cursor[0] < column + columns && cursor[2];
        const hit = hitRanges.findIndex(range => range.start < offset + content.length && range.end > offset);
        // Adjacent ASCII cells share native monospace advances. Keep graphemes,
        // wide cells, cursor and individual search matches as separate spans.
        if (width === 1 && content.length === 1 && content >= ' ' && content <= '~' && !cursorHere) {
          while (cellIndex + 1 < cells.length) {
            const next = cells[cellIndex + 1];
            const text = next[0] || ' ';
            if (next[1] !== 1 || text.length !== 1 || text < ' ' || text > '~' ||
                next[2] !== cell[2] || next[3] !== cell[3] || (Number(next[4]) || 0) !== attr || next[5] !== cell[5] ||
                (snapshot.controller && snapshot.alive && index === history.length + cursor[1] && cursor[2] && column + columns === cursor[0]) ||
                hitRanges.findIndex(range => range.start < offset + content.length + 1 && range.end > offset + content.length) !== hit) break;
            content += text;
            columns++;
            cellIndex++;
          }
        }
        const span = document.createElement('span');
        span.className = 'term-cell';
        span.style.width = `calc(${columns} * var(--cell-width))`;
        if (width === 2) span.classList.add('wide');
        const inverse = Boolean(attr & 32);
        span.style.color = inverse ? (cell[3] || DEFAULT_BG) : (cell[2] || DEFAULT_FG);
        span.style.backgroundColor = inverse ? (cell[2] || DEFAULT_FG) : (cell[3] || DEFAULT_BG);
        if (attr & 1) span.classList.add('bold');
        if (attr & 2) span.classList.add('dim');
        if (attr & 4) span.classList.add('italic');
        if (attr & 8) span.classList.add('underline');
        if (attr & 16) span.classList.add('blink');
        if (attr & 64) span.classList.add('hidden-text');
        if (attr & 128) span.classList.add('strike');
        span.dataset.start = offset;
        span.dataset.end = offset + content.length;
        if (hit >= 0) span.classList.add('match');
        if (cursorHere) {
          span.classList.add('cursor', cursor[3] || 'block');
        }
        const href = safeLink(cell[5]);
        if (href) {
          const anchor = document.createElement('a');
          anchor.href = href;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          anchor.textContent = content;
          span.append(anchor);
        } else span.textContent = content;
        row.append(span);
        offset += content.length;
        column += columns;
      }
      if (!row.childNodes.length) row.textContent = ' ';
      nextCache.push({key, row});
    }
    // Keep unchanged rows attached so text input does not invalidate the whole
    // scrollback's layout. Remove obsolete rows before placing the replacements.
    const retained = new Set(nextCache.map(item => item.row));
    for (const item of this.rowCache) if (!retained.has(item.row)) item.row.remove();
    let position = this.lines.firstChild;
    for (const {row} of nextCache) {
      if (row === position) position = position.nextSibling;
      else this.lines.insertBefore(row, position);
    }
    this.rowCache = nextCache;
    if (nearBottom || term.alternate) this.scroll.scrollTop = this.scroll.scrollHeight;
    else this.scroll.scrollTop = Math.max(0, oldTop + this.scroll.scrollHeight - oldHeight);
    this.highlightActive();
  }

  cellAt(event) {
    if (!this.snapshot?.terminal) return null;
    const rect = this.lines.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / this.cellWidth) + 1;
    const yAll = Math.floor((event.clientY - rect.top) / this.lineHeight);
    const history = this.snapshot.terminal.alternate ? 0 : (this.snapshot.terminal.history || []).length;
    const y = yAll - history + 1;
    const term = this.snapshot.terminal;
    if (x < 1 || x > term.cols || y < 1 || y > term.rows) return null;
    return {x, y};
  }

  selectionText() {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) return '';
    const text = selection.toString();
    const start = selection.getRangeAt(0).startContainer.parentElement?.closest('.term-line');
    const end = selection.getRangeAt(0).endContainer.parentElement?.closest('.term-line');
    if (!start || !end || !this.lines.contains(start) || !this.lines.contains(end)) return text;
    const first = Number(start.dataset.index);
    const last = Number(end.dataset.index);
    const parts = text.split(/\r?\n/);
    if (parts.length !== last - first + 1) return text;
    let result = '';
    for (let index = 0; index < parts.length; index++) {
      result += parts[index];
      if (index + 1 < parts.length && this.lines.children[first + index]?.dataset.wrapped !== 'true') result += '\n';
    }
    return result;
  }
}
