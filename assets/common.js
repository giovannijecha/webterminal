// Small helpers shared by the workspace, pane and folder-picker views.

export function displayPath(path = '') {
  if (path.startsWith('\\\\?\\UNC\\')) return '\\\\' + path.slice(8);
  return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}

export function folderName(path = '') {
  const visible = displayPath(path);
  return visible.split(/[\\/]/).filter(Boolean).at(-1) || visible;
}

// Agents animate a status glyph before their title: Codex a braille spinner,
// Claude a star. The view shows it as activity rather than as text.
const TITLE_STATUS = /^[⠀-⣿✢-✽⏺●]+\s*/u;
function titleParts(title = '') {
  const status = TITLE_STATUS.exec(title)?.[0] || '';
  return {busy:/[⠀-⣿]/u.test(status), text:title.slice(status.length)};
}

export function sessionName(session) {
  if (typeof session?.name === 'string' && session.name.trim()) return session.name.trim();
  const title = displayPath(titleParts(session?.title).text);
  if (title && !/^(?:[a-z]:[\\/]|\\\\)/i.test(title)) return title;
  return folderName(title || session?.cwd || '') || 'Terminal';
}

export function sessionStatus(session) {
  if (!session) return '';
  if (session.alive) return 'Running';
  return `Exited${Number.isInteger(session.exitCode) ? ` (${session.exitCode})` : ''}`;
}

export function stateClass(session) {
  if (session?.alive) return titleParts(session.title ?? session.terminal?.title).busy ? ' live busy' : ' live';
  return Number.isInteger(session?.exitCode) && session.exitCode !== 0 ? ' failed' : '';
}

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', `#icon-${name}`);
  svg.append(use);
  return svg;
}

export const NAME_LIMIT = 80;

export function nameError(name) {
  return [...name.trim()].length > NAME_LIMIT || /[\u0000-\u001f\u007f-\u009f]/.test(name)
    ? `Use at most ${NAME_LIMIT} characters without control characters.` : '';
}

// Replaces an element's text with an input until Enter, Escape or blur.
// `save` returns false to keep editing; the original label is always restored.
export function editInline(label, {value, accessibleName, save, closed = () => {}}) {
  if (label.parentElement.querySelector('.inline-edit')) return;
  const input = document.createElement('input');
  input.className = 'inline-edit';
  input.value = value;
  input.maxLength = 200;
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-label', accessibleName);
  let done = false;
  const finish = (commit, blur = false) => {
    if (done) return;
    if (commit && save(input.value) === false && !blur) { input.focus(); return; }
    done = true;
    input.replaceWith(label);
    closed();
  };
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true, true));
  for (const type of ['click', 'dblclick', 'pointerdown']) input.addEventListener(type, event => event.stopPropagation());
  label.replaceWith(input);
  input.focus();
  input.select();
}
