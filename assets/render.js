// Null means a terminal default; indexed colors follow the selected palette.
const decoded = new WeakMap();
export function cellsOf(line) {
  if (!line) return [];
  let cells = decoded.get(line);
  if (cells) return cells;
  cells = [];
  for (const [fg,bg,attrs,link,payload] of line.runs || []) {
    if (typeof payload === 'string') {
      for (const text of payload) cells.push([text,1,fg,bg,attrs,link]);
    } else {
      for (const [text,width] of payload) cells.push([text,width,fg,bg,attrs,link]);
    }
  }
  decoded.set(line,cells);
  return cells;
}

export function terminalColor(color, foreground = true) {
  if (color == null) return foreground ? 'var(--terminal-fg)' : 'var(--terminal-bg)';
  if (Number.isInteger(color)) {
    if (color < 16) return `var(--ansi-${color})`;
    if (color < 232) {
      const n = color - 16, component = v => v === 0 ? 0 : 55 + v * 40;
      return `rgb(${component(Math.floor(n/36))}, ${component(Math.floor(n/6)%6)}, ${component(n%6)})`;
    }
    const gray = 8 + (color - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  return color;
}

// Draw connecting terminal strokes on cell edges, independent of font metrics.
const STRETCHABLE = '\u2500\u2501\u2550\u2580\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588\u2591\u2592\u2593\u2594';
function graphic(span, text) {
  if (!text || (text.length > 1 && (!STRETCHABLE.includes(text[0]) || [...text].some(ch => ch !== text[0])))) return;
  const code = text.charCodeAt(0);
  text = text[0];
  if (code < 0x2500 || code > 0x259f) return;
  const boxes = [[0x2500,0x2502,0x250c,0x2510,0x2514,0x2518,0x251c,0x2524,0x252c,0x2534,0x253c],[0x2501,0x2503,0x250f,0x2513,0x2517,0x251b,0x2523,0x252b,0x2533,0x253b,0x254b],[0x2550,0x2551,0x2554,0x2557,0x255a,0x255d,0x2560,0x2563,0x2566,0x2569,0x256c]].map(row => String.fromCharCode(...row));
  const arms = ['lr','ud','rd','ld','ru','lu','urd','uld','lrd','lru','lrud'];
  let shape = '', weight = 1;
  for (let index = 0; index < boxes.length; index++) {
    const position = boxes[index].indexOf(text);
    if (position >= 0) { shape = arms[position]; weight = index + 1; break; }
  }
  const rounded = [0x256d,0x256e,0x2570,0x256f].indexOf(code);
  if (rounded >= 0) shape = ['rd','ld','ru','lu'][rounded];
  const block = code >= 0x2580 && code <= 0x259f;
  if (!shape && !block) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
  svg.setAttribute('viewBox','0 0 100 100');
  svg.setAttribute('preserveAspectRatio','none');
  svg.setAttribute('aria-hidden','true');
  function rectangle(x,y,width,height,opacity = 1) {
    const node = document.createElementNS(svg.namespaceURI,'rect');
    for (const [key,value] of Object.entries({x,y,width,height,opacity,fill:'currentColor'})) node.setAttribute(key,value);
    svg.append(node);
  }
  function path(data, width = 1) {
    const node = document.createElementNS(svg.namespaceURI,'path');
    for (const [key,value] of Object.entries({d:data,fill:'none',stroke:'currentColor','stroke-width':width,'vector-effect':'non-scaling-stroke'})) node.setAttribute(key,value);
    svg.append(node);
  }
  if (block) {
    if (code === 0x2580) rectangle(0,0,100,50);
    else if (code <= 0x2588) rectangle(0,100-(code-0x2580)*12.5,100,(code-0x2580)*12.5);
    else if (code <= 0x258f) rectangle(0,0,(0x2590-code)*12.5,100);
    else if (code === 0x2590) rectangle(50,0,50,100);
    else if (code <= 0x2593) rectangle(0,0,100,100,(code-0x2590)*.25);
    else if (code === 0x2594) rectangle(0,0,100,12.5);
    else if (code === 0x2595) rectangle(87.5,0,12.5,100);
    else {
      const quadrants = [4,8,1,13,9,7,11,2,6,14][code-0x2596];
      for (let n = 0; n < 4; n++) if (quadrants & (1 << n)) rectangle(n%2*50,Math.floor(n/2)*50,50,50);
    }
  } else if (rounded >= 0) {
    path(['M100 50H75Q50 50 50 75V100','M0 50H25Q50 50 50 75V100','M100 50H75Q50 50 50 25V0','M0 50H25Q50 50 50 25V0'][rounded]);
  } else if (weight === 3) {
    path({
      lr:'M0 38H100M0 62H100',ud:'M38 0V100M62 0V100',
      rd:'M100 38H38V100M100 62H62V100',ld:'M0 38H62V100M0 62H38V100',
      ru:'M100 62H38V0M100 38H62V0',lu:'M0 62H62V0M0 38H38V0',
      urd:'M38 0V100M62 0V38H100M62 100V62H100',
      uld:'M62 0V100M38 0V38H0M38 100V62H0',
      lrd:'M0 38H100M0 62H38V100M100 62H62V100',
      lru:'M0 62H100M0 38H38V0M100 38H62V0',
      lrud:'M0 38H38V0M62 0V38H100M100 62H62V100M38 100V62H0',
    }[shape]);
  } else {
    const stroke = weight === 2 ? 12 : 7;
    if (shape.includes('l')) rectangle(0,50-stroke/2,50+stroke/2,stroke);
    if (shape.includes('r')) rectangle(50-stroke/2,50-stroke/2,50+stroke/2,stroke);
    if (shape.includes('u')) rectangle(50-stroke/2,0,stroke,50+stroke/2);
    if (shape.includes('d')) rectangle(50-stroke/2,50-stroke/2,stroke,50+stroke/2);
  }
  const glyph = document.createElement('span');
  glyph.className = 'graphic-text';
  while (span.firstChild) glyph.append(span.firstChild);
  span.classList.add('graphic');
  span.append(glyph,svg);
}

function safeLink(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function lineText(line) {
  return cellsOf(line).filter(cell => cell[1] !== 0).map(cell => cell[0] || ' ').join('');
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
    this.nextIdentity = 0;
    this.measure();
    new ResizeObserver(() => this.measure()).observe(scroll);
    // Visible rows must allow glyph ink beyond their line box. Chrome's
    // automatic paint containment clips that ink even with an overflow margin.
    this.visibility = new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.style.contentVisibility = entry.isIntersecting ? 'visible' : 'auto';
    }, {root:scroll, rootMargin:'32px 0px'});
  }

  measure() {
    const style = getComputedStyle(this.lines);
    // Resize checks measure often; one canvas context serves every call.
    const context = this.context ??= document.createElement('canvas').getContext('2d');
    context.font = `${style.fontSize} ${style.fontFamily}`;
    this.cellWidth = context.measureText('M').width || 8;
    this.lineHeight = parseFloat(style.lineHeight) || 19;
    this.lines.style.setProperty('--cell-width', `${this.cellWidth}px`);
  }

  dimensions(maxCols = 300, maxRows = 120) {
    this.measure();
    const style = getComputedStyle(this.scroll);
    const width = (this.scroll.clientWidth || window.innerWidth) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const height = (this.scroll.clientHeight || Math.max(300, window.innerHeight - 125)) - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
    return {cols: Math.max(2, Math.min(maxCols, Math.floor(width / this.cellWidth))), rows: Math.max(1, Math.min(maxRows, Math.floor(height / this.lineHeight)))};
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
    this.visibility.disconnect();
    this.snapshot = null;
    this.pending = null;
    this.frozen = false;
    this.rowCache = [];
    this.lineCache = new WeakMap();
    this.nextIdentity = 0;
    this.matches = [];
    this.matchIndex = -1;
    this.lines.replaceChildren();
  }

  setSearch(query) {
    this.search = query.toLocaleLowerCase();
    this.searchRevision = (this.searchRevision || 0) + 1;
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
    const oldCursor = this.lines.querySelector('.cursor.block')?.getAnimations().find(animation => animation.animationName === 'cursor-blink');
    const cursorStart = oldCursor?.startTime;
    const nextCache = [];
    for (let index = 0; index < all.length; index++) {
      const line = all[index];
      let info = this.lineCache.get(line);
      if (!info) {
        info = {text:lineText(line), key:line.rev ?? `local-${++this.nextIdentity}`};
        this.lineCache.set(line, info);
      }
      const text = info.text;
      if (info.searchRevision !== this.searchRevision) {
        info.searchRevision = this.searchRevision;
        info.hitRanges = [];
        if (query) {
          const source = info.lower ??= text.toLocaleLowerCase();
          let from = 0;
          while (from <= source.length - query.length && info.hitRanges.length < 10000) {
            const start = source.indexOf(query, from);
            if (start < 0) break;
            const end = start + query.length;
            info.hitRanges.push({start,end});
            from = Math.max(start + 1,end);
          }
        }
      }
      const hitRanges = info.hitRanges || [];
      for (const range of hitRanges) {
        if (this.matches.length >= 10000) break;
        this.matches.push({line:index,...range});
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
      row.style.contentVisibility = 'visible';
      this.visibility.observe(row);
      row.dataset.index = index;
      row.dataset.wrapped = line?.wrapped ? 'true' : 'false';
      let offset = 0;
      let column = 0;
      const cells = cellsOf(line);
      for (let cellIndex = 0; cellIndex < cells.length; cellIndex++) {
        const cell = cells[cellIndex];
        const width = cell[1];
        if (width === 0) continue;
        let content = cell[0] || ' ';
        let columns = width === 2 ? 2 : 1;
        const attr = Number(cell[4]) || 0;
        const cursorHere = snapshot.controller && snapshot.alive && index === history.length + cursor[1] && column <= cursor[0] && cursor[0] < column + columns && cursor[2];
        const hit = hitRanges.findIndex(range => range.start < offset + content.length && range.end > offset);
        // Adjacent ASCII cells share native advances; repeated rules share one shape. Keep graphemes,
        // wide cells, cursor and individual search matches as separate spans.
        if (width === 1 && content.length === 1 && ((content >= ' ' && content <= '~') || STRETCHABLE.includes(content)) && !cursorHere) {
          while (cellIndex + 1 < cells.length) {
            const next = cells[cellIndex + 1];
            const text = next[0] || ' ';
            if (next[1] !== 1 || text.length !== 1 || (STRETCHABLE.includes(cell[0]) ? text !== cell[0] : text < ' ' || text > '~') ||
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
        const fg = terminalColor(cell[2]), bg = terminalColor(cell[3],false);
        const foreground = inverse ? bg : fg;
        const background = inverse ? fg : bg;
        // Faint text dims its glyphs toward the background, never the cell itself.
        span.style.color = attr & 2 ? `color-mix(in srgb, ${foreground} 58%, ${background})` : foreground;
        span.style.backgroundColor = background;
        if (attr & 1) span.classList.add('bold');
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
          span.style.setProperty('--cursor-cell-fg', span.style.color);
          span.style.setProperty('--cursor-cell-bg', background);
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
        graphic(span,content);
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
    for (const item of this.rowCache) if (!retained.has(item.row)) {
      this.visibility.unobserve(item.row);
      item.row.remove();
    }
    let position = this.lines.firstChild;
    for (const {row} of nextCache) {
      if (row === position) position = position.nextSibling;
      else this.lines.insertBefore(row, position);
    }
    this.rowCache = nextCache;
    if (cursorStart != null) {
      const animation = this.lines.querySelector('.cursor.block')?.getAnimations().find(item => item.animationName === 'cursor-blink');
      if (animation && animation !== oldCursor) animation.startTime = cursorStart;
    }
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
