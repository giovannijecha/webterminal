// Shared overlay instances: one menu, one dialog queue and the toasts.
import {$} from './dom.js';
import {Dialogs, Menu} from './overlays.js';
import {Toasts} from './toasts.js';

// Focus falls back to the visible page heading when its opener is gone.
export function pageHeading() { return document.querySelector('.page:not([hidden]) h1 [tabindex], .page:not([hidden]) h1') || null; }

export const menu = new Menu();
export const dialogs = new Dialogs({fallbackFocus:pageHeading});
export const toasts = new Toasts($('toasts'), $('live'), {home:pageHeading});

export function notify(title, text = '', action = null, key = null) { return toasts.show({title, text, kind:'success', action, key}); }
export function problem(title, text = '', action = null, key = null) { return toasts.show({title, text, kind:'error', action, key}); }
