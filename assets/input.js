const ESC = '\x1b';
const FUNCTION = {F1:'P',F2:'Q',F3:'R',F4:'S',F5:'15',F6:'17',F7:'18',F8:'19',F9:'20',F10:'21',F11:'23',F12:'24'};
const TILDE = {Insert:'2',Delete:'3',PageUp:'5',PageDown:'6'};
const KEYPAD = {Numpad0:'p',Numpad1:'q',Numpad2:'r',Numpad3:'s',Numpad4:'t',Numpad5:'u',Numpad6:'v',Numpad7:'w',Numpad8:'x',Numpad9:'y',NumpadDecimal:'n',NumpadAdd:'k',NumpadSubtract:'m',NumpadMultiply:'j',NumpadDivide:'o',NumpadEnter:'M',NumpadEqual:'X'};
const SCANS = {Escape:1,Digit1:2,Digit2:3,Digit3:4,Digit4:5,Digit5:6,Digit6:7,Digit7:8,Digit8:9,Digit9:10,Digit0:11,Minus:12,Equal:13,Backspace:14,Tab:15,KeyQ:16,KeyW:17,KeyE:18,KeyR:19,KeyT:20,KeyY:21,KeyU:22,KeyI:23,KeyO:24,KeyP:25,BracketLeft:26,BracketRight:27,Enter:28,NumpadEnter:28,ControlLeft:29,ControlRight:29,KeyA:30,KeyS:31,KeyD:32,KeyF:33,KeyG:34,KeyH:35,KeyJ:36,KeyK:37,KeyL:38,Semicolon:39,Quote:40,Backquote:41,ShiftLeft:42,Backslash:43,KeyZ:44,KeyX:45,KeyC:46,KeyV:47,KeyB:48,KeyN:49,KeyM:50,Comma:51,Period:52,Slash:53,NumpadDivide:53,ShiftRight:54,NumpadMultiply:55,AltLeft:56,AltRight:56,Space:57,CapsLock:58,F1:59,F2:60,F3:61,F4:62,F5:63,F6:64,F7:65,F8:66,F9:67,F10:68,NumLock:69,ScrollLock:70,Numpad7:71,Home:71,Numpad8:72,ArrowUp:72,Numpad9:73,PageUp:73,NumpadSubtract:74,Numpad4:75,ArrowLeft:75,Numpad5:76,Numpad6:77,ArrowRight:77,NumpadAdd:78,Numpad1:79,End:79,Numpad2:80,ArrowDown:80,Numpad3:81,PageDown:81,Numpad0:82,Insert:82,Delete:83,NumpadDecimal:83,F11:87,F12:88};

function modifiers(event) { return 1 + (event.shiftKey ? 1 : 0) + (event.altKey ? 2 : 0) + (event.ctrlKey ? 4 : 0) + (event.metaKey ? 8 : 0); }
function controlState(event, pressed) {
  let alt = (pressed.has('AltRight') ? 1 : 0) | (pressed.has('AltLeft') ? 2 : 0);
  let ctrl = (pressed.has('ControlRight') ? 4 : 0) | (pressed.has('ControlLeft') ? 8 : 0);
  if (event.altKey && !alt) alt = event.code === 'AltRight' || event.getModifierState('AltGraph') ? 1 : 2;
  if (event.ctrlKey && !ctrl) ctrl = event.code === 'ControlRight' ? 4 : 8;
  if (!event.altKey) alt = 0;
  if (!event.ctrlKey) ctrl = 0;
  return alt | ctrl | (event.shiftKey ? 16 : 0) | (event.getModifierState('NumLock') ? 32 : 0) | (event.getModifierState('CapsLock') ? 128 : 0) | (/^(ControlRight|AltRight|MetaRight|Arrow.*|Page.*|Home|End|Insert|Delete|NumpadEnter|NumpadDivide)$/.test(event.code) ? 256 : 0);
}

function classicKey(event, modes) {
  const key = event.key;
  const mod = modifiers(event);
  const altGraph = event.getModifierState('AltGraph');
  const bare = mod === 1;
  if (modes.appKeypad && KEYPAD[event.code]) return `${ESC}O${KEYPAD[event.code]}`;
  if (key === 'Enter') return bare ? '\r' : `${ESC}[27;${mod};13~`;
  if (key === 'Backspace') return event.altKey && !event.ctrlKey ? `${ESC}\x7f` : '\x7f';
  if (key === 'Tab') return event.shiftKey && !event.altKey && !event.ctrlKey ? `${ESC}[Z` : bare ? '\t' : `${ESC}[27;${mod};9~`;
  if (key === 'Escape') return ESC;
  const arrows = {ArrowUp:'A',ArrowDown:'B',ArrowRight:'C',ArrowLeft:'D',Home:'H',End:'F'};
  if (arrows[key]) return bare ? `${ESC}${modes.appCursor ? 'O' : '['}${arrows[key]}` : `${ESC}[1;${mod}${arrows[key]}`;
  if (FUNCTION[key]) return /^[F][1-4]$/.test(key) ? (bare ? `${ESC}O${FUNCTION[key]}` : `${ESC}[1;${mod}${FUNCTION[key]}`) : `${ESC}[${FUNCTION[key]}${bare ? '' : `;${mod}`}~`;
  if (TILDE[key]) return `${ESC}[${TILDE[key]}${bare ? '' : `;${mod}`}~`;
  if (key === ' ' && event.ctrlKey) return '\0';
  if (key.length !== 1 || event.metaKey) return null;
  if (event.ctrlKey && !altGraph) {
    const upper = key.toUpperCase();
    const code = upper.charCodeAt(0);
    if (code >= 64 && code <= 95) return (event.altKey ? ESC : '') + String.fromCharCode(code & 31);
    if (key === '?') return (event.altKey ? ESC : '') + '\x7f';
  }
  return (event.altKey && !altGraph ? ESC : '') + key;
}

function win32Key(event, down, pressed) {
  const virtualKey = event.keyCode || (event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) : 0);
  const scan = SCANS[event.code] || 0;
  let point = event.key === 'Enter' ? 13 : event.key === 'Tab' ? 9 : event.key === 'Backspace' ? 8 : 0;
  if (event.key.length === 1 && !event.metaKey) {
    point = event.key.codePointAt(0);
    if (event.ctrlKey && !event.getModifierState('AltGraph')) {
      if (event.altKey) point = 0;
      else {
        const upper = event.key.toUpperCase().charCodeAt(0);
        point = upper >= 64 && upper <= 95 ? upper & 31 : event.key === '?' ? 127 : 0;
      }
    }
  }
  return `${ESC}[${virtualKey};${scan};${point};${down ? 1 : 0};${controlState(event, pressed)};1_`;
}

export class TerminalInput {
  constructor({keyboard, scroll, renderer, snapshot, canInput, send, notify}) {
    this.keyboard = keyboard;
    this.scroll = scroll;
    this.renderer = renderer;
    this.snapshot = snapshot;
    this.canInput = canInput;
    this.send = send;
    this.notify = notify;
    this.composing = false;
    this.pendingCompositionText = null;
    this.discardedCompositionText = null;
    this.cancelledComposition = false;
    this.pressed = new Set();
    this.mouseButton = null;
    this.lastMotion = '';
    keyboard.addEventListener('keydown', event => this.keydown(event));
    keyboard.addEventListener('keyup', event => this.keyup(event));
    keyboard.addEventListener('beforeinput', event => this.beforeinput(event));
    keyboard.addEventListener('compositionstart', () => { this.composing = true; this.cancelledComposition = false; this.discardedCompositionText = null; });
    keyboard.addEventListener('compositionend', event => {
      if (!this.composing) {
        this.discardedCompositionText = event.data || this.discardedCompositionText;
        keyboard.value = '';
        return;
      }
      this.composing = false;
      this.pendingCompositionText = event.data || null;
      this.sendText(event.data);
      keyboard.value = '';
    });
    keyboard.addEventListener('paste', event => this.paste(event));
    keyboard.addEventListener('blur', () => { this.focusReport(false); this.reset(); });
    keyboard.addEventListener('focus', () => this.focusReport(true));
    scroll.addEventListener('keydown', event => { if (this.canInput()) this.keydown(event); });
    scroll.addEventListener('pointerdown', event => this.pointerdown(event));
    scroll.addEventListener('pointerup', event => this.pointerup(event));
    scroll.addEventListener('pointermove', event => this.pointermove(event));
    scroll.addEventListener('wheel', event => this.wheel(event), {passive:false});
    scroll.addEventListener('contextmenu', event => { if (this.mouseEnabled() && !event.shiftKey) event.preventDefault(); });
    scroll.addEventListener('click', event => { if (this.mouseEnabled() && !event.shiftKey && event.target.closest('a')) event.preventDefault(); });
  }

  focus() { this.keyboard.focus({preventScroll:true}); }
  reset() {
    this.cancelledComposition ||= this.composing;
    this.discardedCompositionText = this.pendingCompositionText || this.discardedCompositionText;
    this.pressed.clear();
    this.composing = false;
    this.pendingCompositionText = null;
    this.mouseButton = null;
    this.lastMotion = '';
    this.keyboard.value = '';
  }
  modes() { return this.snapshot()?.terminal?.modes || {}; }
  sendText(value) { if (value && this.canInput()) this.send(value); }
  keydown(event) {
    if (!this.canInput()) { this.pressed.delete(event.code); return; }
    if (this.composing || event.isComposing || event.key === 'Process' || event.key === 'Dead') { this.pressed.delete(event.code); return; }
    this.pendingCompositionText = null;
    if (event.ctrlKey && event.key.toLowerCase() === 'v') { this.pressed.delete(event.code); return; }
    if (event.ctrlKey && event.shiftKey && ['c','f'].includes(event.key.toLowerCase())) { this.pressed.delete(event.code); return; }
    if (event.shiftKey && event.key === 'Insert') { this.pressed.delete(event.code); return; }
    if (event.ctrlKey && event.key.toLowerCase() === 'c' && !document.getSelection()?.isCollapsed) { this.pressed.delete(event.code); return; }
    if (event.key.length > 1 && [...event.key].length === 1) { this.pressed.delete(event.code); return; }
    const modes = this.modes();
    if (modes.win32) {
      this.pressed.add(event.code);
      this.sendText(win32Key(event, true, this.pressed));
      event.preventDefault();
      return;
    }
    const data = classicKey(event, modes);
    if (data === null) return;
    this.sendText(data);
    event.preventDefault();
  }
  keyup(event) {
    if (this.canInput() && this.modes().win32 && this.pressed.has(event.code)) {
      this.sendText(win32Key(event, false, this.pressed));
      event.preventDefault();
    }
    this.pressed.delete(event.code);
  }
  beforeinput(event) {
    if (this.composing || event.isComposing) return;
    if (this.cancelledComposition && event.inputType === 'insertFromComposition') {
      event.preventDefault();
      this.keyboard.value = '';
      return;
    }
    if (this.discardedCompositionText && event.data === this.discardedCompositionText && ['insertText','insertFromComposition'].includes(event.inputType)) {
      this.discardedCompositionText = null;
      event.preventDefault();
      this.keyboard.value = '';
      return;
    }
    this.discardedCompositionText = null;
    if (this.pendingCompositionText && event.data === this.pendingCompositionText && ['insertText','insertFromComposition'].includes(event.inputType)) {
      this.pendingCompositionText = null;
      event.preventDefault();
      this.keyboard.value = '';
      return;
    }
    this.pendingCompositionText = null;
    if (event.inputType === 'insertFromComposition' && event.data) { this.sendText(event.data); event.preventDefault(); this.keyboard.value = ''; return; }
    if (event.inputType === 'insertText' && event.data) { this.sendText(event.data); event.preventDefault(); this.keyboard.value = ''; }
  }
  paste(event) {
    event.preventDefault();
    this.pasteText(event.clipboardData?.getData('text/plain') || '');
  }
  pasteText(text) {
    if (!this.canInput() || !text) return;
    const normalized = text.replace(/\r\n|\r/g, '\n');
    this.sendText(this.modes().bracketedPaste ? `${ESC}[200~${normalized}${ESC}[201~` : normalized.replace(/\n/g, '\r'));
  }
  focusReport(focused) {
    if (this.canInput() && this.modes().focus) this.sendText(`${ESC}[${focused ? 'I' : 'O'}`);
  }
  mouseEnabled() { return this.canInput() && Number(this.modes().mouse) > 0; }
  mouseSequence(event, button, release = false, motion = false) {
    const cell = this.renderer.cellAt(event);
    if (!cell) return null;
    const mod = (event.shiftKey ? 4 : 0) + (event.altKey ? 8 : 0) + (event.ctrlKey ? 16 : 0);
    const code = button + mod + (motion ? 32 : 0);
    if (this.modes().mouseSgr) return `${ESC}[<${code};${cell.x};${cell.y}${release ? 'm' : 'M'}`;
    // ConPTY's UTF-8 input pipe cannot carry classic X10 coordinate bytes
    // 128 and above as raw single bytes. SGR keeps larger coordinates intact.
    if (cell.x >= 96 || cell.y >= 96) return null;
    return `${ESC}[M${String.fromCharCode(32 + (release ? 3 + mod : code), 32 + cell.x, 32 + cell.y)}`;
  }
  pointerdown(event) {
    if (this.mouseEnabled() && !event.shiftKey) {
      const button = event.button === 1 ? 1 : event.button === 2 ? 2 : 0;
      const sequence = this.mouseSequence(event, button);
      if (sequence) { event.preventDefault(); this.mouseButton = button; this.sendText(sequence); this.focus(); this.scroll.setPointerCapture(event.pointerId); return; }
    }
    if (event.button === 0) this.renderer.setFrozen(true);
    if (event.target.closest('a')) return;
  }
  pointerup(event) {
    if (this.mouseButton !== null && this.mouseEnabled() && !event.shiftKey) {
      const sequence = this.mouseSequence(event, this.mouseButton, true);
      if (sequence) this.sendText(sequence);
      this.mouseButton = null;
      if (this.scroll.hasPointerCapture(event.pointerId)) this.scroll.releasePointerCapture(event.pointerId);
      return;
    }
    requestAnimationFrame(() => { if (document.getSelection()?.isCollapsed) { this.renderer.setFrozen(false); this.focus(); } });
  }
  pointermove(event) {
    const mode = Number(this.modes().mouse) || 0;
    if (!this.mouseEnabled() || event.shiftKey || mode === 1000 || (mode === 1002 && this.mouseButton === null)) return;
    const sequence = this.mouseSequence(event, this.mouseButton ?? 3, false, true);
    if (sequence && sequence !== this.lastMotion) { this.lastMotion = sequence; this.sendText(sequence); }
  }
  wheel(event) {
    if (!this.mouseEnabled() || event.shiftKey) return;
    const sequence = this.mouseSequence(event, event.deltaY < 0 ? 64 : 65);
    if (sequence) { event.preventDefault(); this.sendText(sequence); }
  }
}
