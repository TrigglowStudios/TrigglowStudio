// KeyboardEvent → Electron accelerator ("CommandOrControl+Alt+C"), shared by the settings panels.
(() => {
  function keyName(code) {
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit\d$/.test(code)) return code.slice(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    return { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Enter: 'Enter', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Minus: 'Minus', Equal: 'Equal' }[code] ?? null;
  }
  /** A key to hold (push to talk): any key, with or without modifiers, CapsLock and ` too; null for a lone modifier. */
  function toHoldKey(e) {
    const key = keyName(e.code) ?? { CapsLock: 'CapsLock', Backquote: 'Backquote' }[e.code] ?? null;
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    return [...mods, key].join('+');
  }
  /** null until a real combination (a strong modifier + a key) is pressed. */
  function toAccelerator(e) {
    const key = keyName(e.code);
    if (!key) return null;
    const mods = [];
    if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (!mods.length || (mods.length === 1 && mods[0] === 'Shift' && !/^F\d/.test(key))) return null;
    return [...mods, key].join('+');
  }
  const pretty = (acc) => acc.replace('CommandOrControl', navigator.platform.includes('Mac') ? '⌘' : 'Ctrl').replaceAll('+', ' + ');
  window.HK = { toAccelerator, toHoldKey, pretty };
})();
