import {displayPath, icon} from './workbench.js';

const $ = id => document.getElementById(id);

// Display normal DOS/UNC paths while retaining canonical paths for the server.
export function pathCrumbs(path) {
  const visible = displayPath(path).replaceAll('/', '\\');
  const root = visible.match(/^[a-z]:\\/i)?.[0] || visible.match(/^\\\\[^\\]+\\[^\\]+(?:\\|$)/)?.[0];
  if (!root) return [{label:visible, path}];
  const native = value => path.startsWith('\\\\?\\UNC\\') ? '\\\\?\\UNC\\' + value.slice(2) : path.startsWith('\\\\?\\') ? '\\\\?\\' + value : value;
  let current = root;
  const result = [{label:root.endsWith('\\') ? root.slice(0, -1) : root, path:native(root)}];
  for (const name of visible.slice(root.length).split('\\').filter(Boolean)) {
    current += (current.endsWith('\\') ? '' : '\\') + name;
    result.push({label:name, path:native(current)});
  }
  return result;
}

export class DirectoryPicker {
  constructor({startDirectory, create}) {
    this.startDirectory = startDirectory;
    this.create = create;
    this.token = 0;
    this.request = null;
    this.data = null;
    this.selected = null;
    this.visible = [];
    this.ready = false;
    $('directory-go').addEventListener('click', () => this.load(this.requestedPath(), true));
    $('directory-up').addEventListener('click', () => this.up());
    $('directory-home').addEventListener('click', () => this.load(this.initial, true));
    $('directory-create').addEventListener('click', () => this.commit());
    $('directory-path').addEventListener('input', () => {
      this.invalidate();
      this.data = null;
      this.selected = null;
      $('directory-up').disabled = true;
      $('directory-filter').disabled = true;
      $('directory-breadcrumbs').replaceChildren();
      $('directory-message').classList.remove('error');
      $('directory-message').textContent = '';
      $('directory-error').hidden = true;
      this.placeholder('Press Enter to open this location.');
      this.selection();
    });
    $('directory-path').addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.load(this.requestedPath(), true); }
      if (event.key === 'ArrowDown') { event.preventDefault(); this.rows()[0]?.focus(); }
    });
    $('directory-filter').addEventListener('input', () => { this.selected = null; this.render(); });
    $('directory-filter').addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === 'ArrowDown') { event.preventDefault(); this.rows()[0]?.focus(); }
    });
    $('directory-list').addEventListener('keydown', event => this.listKey(event));
    $('directory-dialog').addEventListener('keydown', event => {
      if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); this.up(); }
    });
    $('directory-dialog').addEventListener('close', () => { if (!$('directory-dialog').open) this.invalidate(); });
  }

  open() {
    this.initial = this.startDirectory();
    $('directory-dialog').showModal();
    this.load(this.initial);
    $('directory-path').focus();
    $('directory-path').select();
  }

  invalidate() {
    this.token++;
    this.request?.abort();
    this.request = null;
    this.ready = false;
    $('directory-create').disabled = true;
    $('directory-list').setAttribute('aria-busy', 'false');
  }

  requestedPath() {
    const entered = $('directory-path').value.trim();
    return this.data && entered === displayPath(this.data.path) ? this.data.path : entered;
  }

  async load(path, focusList = false) {
    this.invalidate();
    const token = this.token;
    const request = new AbortController();
    this.request = request;
    this.data = null;
    this.selected = null;
    $('directory-path').value = displayPath(path);
    $('directory-filter').value = '';
    $('directory-filter').disabled = true;
    $('directory-up').disabled = true;
    $('directory-error').hidden = true;
    $('directory-message').classList.remove('error');
    $('directory-message').textContent = 'Loading…';
    $('directory-breadcrumbs').replaceChildren();
    $('directory-list').setAttribute('aria-busy', 'true');
    this.placeholder('Loading folders…');
    this.selection();
    try {
      if (!path) throw new Error('Enter a folder location.');
      const response = await fetch(`/api/directories?path=${encodeURIComponent(path)}`, {cache:'no-store', signal:request.signal});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Folder unavailable (${response.status})`);
      if (token !== this.token || !$('directory-dialog').open) return null;
      this.data = data;
      this.ready = true;
      this.request = null;
      $('directory-path').value = displayPath(data.path);
      $('directory-up').disabled = !data.parent;
      $('directory-filter').disabled = false;
      $('directory-list').setAttribute('aria-busy', 'false');
      this.breadcrumbs();
      this.render();
      if (focusList) (this.rows()[0] || $('directory-list')).focus();
      return data;
    } catch (error) {
      if (token !== this.token || error.name === 'AbortError') return null;
      this.request = null;
      $('directory-list').setAttribute('aria-busy', 'false');
      $('directory-error-text').textContent = error.message;
      $('directory-error').hidden = false;
      $('directory-message').classList.add('error');
      $('directory-message').textContent = 'Unavailable';
      this.placeholder('Choose another location.');
      return null;
    }
  }

  breadcrumbs() {
    const fragment = document.createDocumentFragment();
    const crumbs = pathCrumbs(this.data.path);
    crumbs.forEach((crumb, index) => {
      if (index) fragment.append(icon('chevron'));
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = crumb.label;
      button.title = displayPath(crumb.path);
      button.dataset.path = crumb.path;
      if (index === crumbs.length - 1) button.setAttribute('aria-current', 'location');
      button.addEventListener('click', () => this.load(crumb.path, true));
      fragment.append(button);
    });
    $('directory-breadcrumbs').replaceChildren(fragment);
    $('directory-breadcrumbs').scrollLeft = $('directory-breadcrumbs').scrollWidth;
  }

  placeholder(message) {
    const text = document.createElement('p');
    text.className = 'directory-empty';
    text.textContent = message;
    $('directory-list').replaceChildren(text);
  }

  render() {
    const directories = this.data?.directories || [];
    const query = $('directory-filter').value.trim().toLocaleLowerCase();
    this.visible = directories.filter(directory => directory.name.toLocaleLowerCase().includes(query));
    $('directory-message').textContent = query ? `${this.visible.length} / ${directories.length}` : `${directories.length} folder${directories.length === 1 ? '' : 's'}`;
    if (!this.visible.length) {
      this.placeholder(query ? 'No matching folders.' : 'No subfolders in this location.');
    } else {
      const fragment = document.createDocumentFragment();
      this.visible.forEach((directory, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'directory-row';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(this.selected?.path === directory.path));
        row.tabIndex = this.selected?.path === directory.path || (!this.selected && index === 0) ? 0 : -1;
        row.dataset.path = directory.path;
        row.title = displayPath(directory.path);
        const name = document.createElement('span');
        name.className = 'directory-name';
        name.textContent = directory.name;
        row.append(icon('folder'), name, icon('chevron'));
        row.addEventListener('click', () => this.select(index));
        row.addEventListener('dblclick', () => this.load(directory.path, true));
        fragment.append(row);
      });
      $('directory-list').replaceChildren(fragment);
    }
    this.selection();
  }

  rows() { return [...$('directory-list').querySelectorAll('.directory-row')]; }

  select(index, focus = false) {
    this.selected = this.visible[index] || null;
    this.rows().forEach((row, position) => {
      row.setAttribute('aria-selected', String(position === index));
      row.tabIndex = position === index ? 0 : -1;
    });
    if (focus) this.rows()[index]?.focus();
    this.selection();
  }

  selection() {
    const path = displayPath(this.selected?.path || this.data?.path || '');
    $('directory-selected').textContent = this.selected?.name || path.split('\\').filter(Boolean).at(-1) || 'No folder selected';
    $('directory-selected').title = path;
    $('directory-create').disabled = !this.ready;
  }

  listKey(event) {
    const index = this.rows().indexOf(event.target.closest('.directory-row'));
    if (event.key === 'Enter' && index >= 0) { event.preventDefault(); this.load(this.visible[index].path, true); }
    else if (event.key === 'Backspace') { event.preventDefault(); this.up(); }
    else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) && this.visible.length) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.visible.length - 1 : Math.max(0, Math.min(this.visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      this.select(next, true);
    }
  }

  up() { if (this.data?.parent) this.load(this.data.parent, true); }

  async commit() {
    if (!this.ready) return;
    const path = this.selected?.path || this.requestedPath();
    const data = await this.load(path);
    if (data && $('directory-dialog').open && this.create(data.path)) $('directory-dialog').close();
  }
}
