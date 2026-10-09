import {displayPath, folderName, icon} from './common.js';

const $ = id => document.getElementById(id);
// The drive list is a picker view, not a folder: it has no path and cannot host a terminal.
const THIS_PC = '';
const PLACE_ICONS = {'Start folder':'pin', Home:'home', Desktop:'desktop', Documents:'document', Downloads:'download'};

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

// A File Explorer-style folder chooser: places, history, an editable address
// bar and a folder list. Only folders are listed; nothing is opened or read.
export class DirectoryPicker {
  constructor({startDirectory, create}) {
    this.startDirectory = startDirectory;
    this.create = create;
    this.token = 0;
    this.request = null;
    this.data = null;
    this.selected = null;
    this.visible = [];
    this.places = {folders:[], drives:[]};
    this.history = [];
    this.position = -1;
    $('directory-back').addEventListener('click', () => this.travel(-1));
    $('directory-forward').addEventListener('click', () => this.travel(1));
    $('directory-up').addEventListener('click', () => this.up());
    $('directory-create').addEventListener('click', () => this.commit());
    $('directory-address').addEventListener('click', event => { if (!event.target.closest('button')) this.editAddress(true); });
    $('directory-path').addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); this.editAddress(false); this.navigate($('directory-path').value.trim()); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.editAddress(false); }
    });
    $('directory-path').addEventListener('blur', () => this.editAddress(false));
    $('directory-filter').addEventListener('input', () => { this.selected = null; this.render(); });
    $('directory-filter').addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === 'ArrowDown') { event.preventDefault(); this.rows()[0]?.focus(); }
    });
    $('directory-list').addEventListener('keydown', event => this.listKey(event));
    $('directory-dialog').addEventListener('keydown', event => {
      if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); this.up(); }
      else if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); this.travel(event.key === 'ArrowLeft' ? -1 : 1); }
      else if ((event.ctrlKey && event.key.toLowerCase() === 'l') || event.key === 'F4') { event.preventDefault(); this.editAddress(true); }
    });
    $('directory-dialog').addEventListener('close', () => this.invalidate());
  }

  async open() {
    this.history = [];
    this.position = -1;
    $('directory-dialog').showModal();
    this.loadPlaces();
    await this.navigate(this.startDirectory());
    (this.rows()[0] || $('directory-list')).focus();
  }

  async loadPlaces() {
    try {
      const response = await fetch('/api/places', {cache:'no-store'});
      if (response.ok) this.places = await response.json();
    } catch { /* Places are a convenience; the address bar still works. */ }
    this.renderPlaces();
  }

  renderPlaces() {
    const section = (heading, entries, iconFor) => {
      const title = document.createElement('h3');
      title.textContent = heading;
      return [title, ...entries.map(entry => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'place';
        button.dataset.path = entry.path;
        button.title = displayPath(entry.path) || heading;
        const label = document.createElement('span');
        label.textContent = entry.name;
        button.append(icon(iconFor(entry)), label);
        button.addEventListener('click', () => this.navigate(entry.path));
        return button;
      })];
    };
    $('directory-places').replaceChildren(
      ...section('Quick access', this.places.folders || [], entry => PLACE_ICONS[entry.name] || 'folder'),
      ...section('This PC', [{name:'This PC', path:THIS_PC}, ...(this.places.drives || [])], entry => entry.path ? 'drive' : 'pc'),
    );
    this.markPlace();
  }

  markPlace() {
    const current = this.data ? this.data.path : null;
    for (const place of $('directory-places').querySelectorAll('.place')) {
      const match = current !== null && displayPath(place.dataset.path).toLowerCase() === displayPath(current).toLowerCase();
      place.classList.toggle('current', match);
      if (match) place.setAttribute('aria-current', 'location'); else place.removeAttribute('aria-current');
    }
  }

  invalidate() {
    this.token++;
    this.request?.abort();
    this.request = null;
    $('directory-create').disabled = true;
    $('directory-list').setAttribute('aria-busy', 'false');
  }

  editAddress(editing) {
    const input = $('directory-path');
    if (editing === !input.hidden) return;
    input.hidden = !editing;
    $('directory-breadcrumbs').hidden = editing;
    if (editing) { input.value = this.data?.path ? displayPath(this.data.path) : ''; input.focus(); input.select(); }
  }

  // Loads a location and records it in the back/forward history.
  async navigate(path) {
    const data = await this.load(path);
    if (!data) return null;
    if (this.history[this.position] !== data.path) {
      this.history = this.history.slice(0, this.position + 1);
      this.history.push(data.path);
      this.position = this.history.length - 1;
    }
    this.navigation();
    return data;
  }

  async travel(step) {
    const target = this.position + step;
    if (target < 0 || target >= this.history.length) return;
    if (await this.load(this.history[target])) this.position = target;
    this.navigation();
  }

  navigation() {
    $('directory-back').disabled = this.position <= 0;
    $('directory-forward').disabled = this.position >= this.history.length - 1;
    $('directory-up').disabled = !this.data || this.data.path === THIS_PC;
  }

  async load(path) {
    this.invalidate();
    const token = this.token;
    this.selected = null;
    $('directory-filter').value = '';
    $('directory-error').hidden = true;
    $('directory-message').textContent = 'Loading…';
    if (path === THIS_PC) return this.show(token, {path:THIS_PC, parent:null, directories:(this.places.drives || []).map(drive => ({...drive, drive:true}))});
    const request = new AbortController();
    this.request = request;
    $('directory-list').setAttribute('aria-busy', 'true');
    try {
      if (!path) throw new Error('Enter a folder location.');
      const response = await fetch(`/api/directories?path=${encodeURIComponent(path)}`, {cache:'no-store', signal:request.signal});
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Folder unavailable (${response.status})`);
      return this.show(token, data);
    } catch (error) {
      if (token !== this.token || error.name === 'AbortError') return null;
      this.request = null;
      $('directory-list').setAttribute('aria-busy', 'false');
      $('directory-error-text').textContent = error.message;
      $('directory-error').hidden = false;
      $('directory-message').textContent = '';
      $('directory-create').disabled = !this.data?.path;
      return null;
    }
  }

  show(token, data) {
    if (token !== this.token || !$('directory-dialog').open) return null;
    this.request = null;
    this.data = data;
    $('directory-list').setAttribute('aria-busy', 'false');
    $('directory-filter').placeholder = `Search ${data.path ? folderName(data.path) : 'This PC'}`;
    this.breadcrumbs();
    this.render();
    this.markPlace();
    this.navigation();
    return data;
  }

  breadcrumbs() {
    const crumbs = [{label:'This PC', path:THIS_PC}, ...(this.data.path ? pathCrumbs(this.data.path) : [])];
    const fragment = document.createDocumentFragment();
    crumbs.forEach((crumb, index) => {
      if (index) fragment.append(icon('chevron'));
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = crumb.label;
      button.title = displayPath(crumb.path) || 'This PC';
      if (index === crumbs.length - 1) button.setAttribute('aria-current', 'location');
      button.addEventListener('click', () => this.navigate(crumb.path));
      fragment.append(button);
    });
    $('directory-breadcrumbs').replaceChildren(fragment);
    $('directory-breadcrumbs').scrollLeft = $('directory-breadcrumbs').scrollWidth;
  }

  render() {
    const directories = this.data?.directories || [];
    const query = $('directory-filter').value.trim().toLocaleLowerCase();
    this.visible = directories.filter(directory => directory.name.toLocaleLowerCase().includes(query));
    const noun = this.data?.path === THIS_PC ? 'drive' : 'folder';
    $('directory-message').textContent = query ? `${this.visible.length} of ${directories.length}` : `${directories.length} ${noun}${directories.length === 1 ? '' : 's'}`;
    if (!this.visible.length) {
      const text = document.createElement('p');
      text.className = 'directory-empty';
      text.textContent = query ? 'No matching folders.' : this.data?.path === THIS_PC ? 'No drives found.' : 'This folder has no subfolders.';
      $('directory-list').replaceChildren(text);
    } else {
      $('directory-list').replaceChildren(...this.visible.map((directory, index) => {
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
        row.append(icon(directory.drive ? 'drive' : 'folder'), name);
        row.addEventListener('click', () => this.select(index));
        row.addEventListener('dblclick', () => this.enter(directory.path));
        return row;
      }));
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

  async enter(path) {
    await this.navigate(path);
    (this.rows()[0] || $('directory-list')).focus();
  }

  // The chosen folder is the selected row, or the current folder.
  target() { return this.selected?.path || this.data?.path || ''; }

  selection() {
    const path = this.target();
    $('directory-selected').textContent = path ? folderName(path) : 'Choose a folder';
    $('directory-selected').title = displayPath(path);
    $('directory-create').disabled = !path;
  }

  listKey(event) {
    const index = this.rows().indexOf(event.target.closest('.directory-row'));
    if (event.key === 'Enter' && index >= 0) { event.preventDefault(); this.enter(this.visible[index].path); }
    else if (event.key === 'Backspace') { event.preventDefault(); this.up(); }
    else if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) && this.visible.length) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? this.visible.length - 1 : Math.max(0, Math.min(this.visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      this.select(next, true);
    }
  }

  async up() {
    if (!this.data || this.data.path === THIS_PC) return;
    const from = this.data.path;
    if (await this.navigate(this.data.parent ?? THIS_PC)) {
      const index = this.visible.findIndex(directory => displayPath(directory.path).toLowerCase() === displayPath(from).toLowerCase());
      if (index >= 0) this.select(index, true);
    }
  }

  // Revalidates the folder on the server before creating the terminal.
  async commit() {
    const path = this.target();
    if (!path) return;
    $('directory-create').disabled = true;
    const response = await fetch(`/api/directories?path=${encodeURIComponent(path)}`, {cache:'no-store'}).catch(() => null);
    const data = await response?.json().catch(() => null);
    if (!response?.ok || !data?.path) {
      $('directory-error-text').textContent = data?.error || 'The folder is no longer available.';
      $('directory-error').hidden = false;
      this.selection();
      return;
    }
    if ($('directory-dialog').open && this.create(data.path)) $('directory-dialog').close();
    else this.selection();
  }
}
