// Shared overlay instances: one menu, one dialog queue and the Dock.
import {$} from './dom.js';
import {Dialogs, Menu} from './overlays.js';
import {BrowserNotices, Dock} from './dock.js';

// Focus falls back to the visible page heading when its opener is gone.
export function pageHeading() { return document.querySelector('.page:not([hidden]) h1 [tabindex], .page:not([hidden]) h1') || null; }

export const menu = new Menu();
export const dialogs = new Dialogs({fallbackFocus:pageHeading});
export const dock = new Dock($('dock'), $('live'), {home:pageHeading});
export const browserNotices = new BrowserNotices();

export function notify(title, text = '', action = null, key = null) { return dock.show({title, text, kind:'success', action, key}); }
export function attention(title, text = '', action = null, key = null) { return dock.show({title, text, kind:'attention', action, key}); }
export function problem(title, text = '', action = null, key = null) { return dock.show({title, text, kind:'error', action, key}); }
