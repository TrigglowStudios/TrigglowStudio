// Shared by the Studio page (studio.js) and its pop-up windows (studio-popup.js): icons, a tiny element helper and the
// form field for one libobs property (every kind OBS's properties window has, see src/studio-props.ts).

const STUDIO_ICONS = {
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3z"/>',
  volume: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  scene: '<rect x="3" y="5" width="18" height="14" rx="2"/>',
  game: '<path d="M6 12h4M8 10v4M15 13h.01M18 11h.01"/><rect x="2" y="6" width="20" height="12" rx="4"/>',
  monitor: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  window: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  camera: '<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v1a7 7 0 0 0 14 0v-1M12 18v4"/>',
  speaker: '<rect x="5" y="2" width="14" height="20" rx="2"/><circle cx="12" cy="14" r="4"/><path d="M12 6h.01"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/>',
  film: '<rect x="2" y="2" width="20" height="20" rx="2.2"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>',
  text: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  palette: '<circle cx="13.5" cy="6.5" r="1.5"/><circle cx="17.5" cy="10.5" r="1.5"/><circle cx="8.5" cy="7.5" r="1.5"/><circle cx="6.5" cy="12.5" r="1.5"/><path d="M12 2a10 10 0 0 0 0 20c1 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7H16a6 6 0 0 0 6-6c0-4.4-4.5-8.4-10-8.4z"/>',
  bolt: '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6.4A8 8 0 1 1 21 12z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  flag: '<path d="M4 22V4M4 4h13l-2 4 2 4H4"/>',
  gift: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v9H5v-9M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
  star: '<path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2z"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  credits: '<path d="M4 4h16v16H4zM8 8h8M8 12h8M8 16h5"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  headphones: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1v-6h3zM3 19a2 2 0 0 0 2 2h1v-6H3z"/>',
  app: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M10 13l4 2.5-4 2.5z"/>',
  images: '<rect x="7" y="3" width="14" height="14" rx="2"/><path d="M3 7v12a2 2 0 0 0 2 2h12M11 13l3-3 4 4"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
};

/** What the Add source window offers, grouped like Streamlabs' (essentials, media, then Trigglow's own overlays). */
const STUDIO_SOURCES = [
  { title: 'studio.pick.essentials', items: [['type:game_capture', 'game'], ['type:monitor_capture', 'monitor'], ['type:window_capture', 'window'], ['type:dshow_input', 'camera'], ['type:wasapi_input_capture', 'mic'], ['type:wasapi_output_capture', 'speaker'], ['type:wasapi_process_output_capture', 'app'], ['scene:', 'scene']] },
  { title: 'studio.pick.media', items: [['type:image_source', 'image'], ['type:slideshow', 'images'], ['type:ffmpeg_source', 'film'], ['type:text_gdiplus_v3', 'text'], ['type:browser_source', 'globe'], ['type:color_source_v3', 'palette']] },
  { title: 'studio.trigglowGroup', items: [['trigglowscene:', 'scene'], ['trigglow:alerts', 'bell'], ['trigglow:chat', 'chat'], ['trigglow:activity', 'list'], ['trigglow:goals', 'target'], ['trigglow:quests', 'flag'], ['trigglow:giveaway', 'gift'], ['trigglow:loyalty', 'star'], ['trigglow:music', 'music'], ['trigglow:credits', 'credits'], ['trigglow:emotes', 'smile']] },
];
const TRIGGLOW_NAMES = { alerts: 'Trigglow Alerts', chat: 'Trigglow Chat', activity: 'Trigglow Activity', goals: 'Trigglow Goals', quests: 'Trigglow Quests', giveaway: 'Trigglow Giveaways', loyalty: 'Trigglow Loyalty', music: 'Trigglow Music', credits: 'Trigglow Credits', emotes: 'Trigglow Emotes' };
/** "type:game_capture" → its name and description; "trigglow:chat" → "Trigglow Chat"; "scene:" → a nested scene. */
function sourceInfo(id) {
  const [kind, key] = id.split(':');
  if (kind === 'trigglow') return { name: TRIGGLOW_NAMES[key], desc: tr(`studio.desc.${key}`) };
  if (kind === 'scene') return { name: tr('studio.src.scene'), desc: tr('studio.desc.scene') };
  if (kind === 'trigglowscene') return { name: tr('studio.src.trigglowScene'), desc: tr('studio.desc.trigglowScene') };
  return { name: tr(`studio.src.${key}`), desc: tr(`studio.desc.${key}`) };
}
const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${STUDIO_ICONS[name]}</svg>`;

/** Element helper: el('li', { className }, child, 'text', …); null/false children are skipped. */
function el(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return n;
}

function iconBtn(icon, label, onclick, extra = '') {
  const b = el('button', { type: 'button', className: `icon-btn ${extra}`.trim(), title: label, ariaLabel: label, onclick });
  b.innerHTML = svg(icon);
  return b;
}

/** libobs colours are 0xAABBGGRR; a colour input wants #rrggbb, plus an alpha 0..255. */
function colorToHex(abgr) {
  const n = Number.isFinite(abgr) ? abgr >>> 0 : 0xffffffff;
  const hex = '#' + [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff].map((x) => x.toString(16).padStart(2, '0')).join('');
  return { hex, alpha: (n >>> 24) & 0xff };
}
function hexToColor(hex, alpha = 255) {
  const rgb = parseInt(String(hex).replace('#', ''), 16) || 0;
  return (((alpha & 0xff) << 24) | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >>> 16) & 0xff)) >>> 0;
}

/** libobs font flags (bold 1, italic 2, underline 4, strikeout 8). */
const FONT_FLAGS = [
  [1, 'studio.font.bold'],
  [2, 'studio.font.italic'],
  [4, 'studio.font.underline'],
  [8, 'studio.font.strike'],
];

/**
 * The field for one libobs property (as studio-props.ts flattens it). `change(value)` saves it; `ctx.press()` presses
 * a button property; `ctx.pick({ pathType, filter, defaultPath, multi })` opens a file/folder dialog → paths.
 */
/** One <datalist> of the system's font families per page, filled once from the app (op 'fonts'). */
let fontListId = null;
function fontList() {
  if (fontListId) return fontListId;
  fontListId = 'studioFonts';
  const list = el('datalist', { id: fontListId });
  document.body.append(list);
  window.trigglowShell.studio({ op: 'fonts' }).then((r) => list.replaceChildren(...((r && r.fonts) || []).map((name) => el('option', { value: name }))));
  return fontListId;
}

function propField(p, change, ctx = {}) {
  const id = `p_${p.name}`;
  const label = (input, extra = '') => el('label', { className: `field ${extra}`.trim(), htmlFor: id, title: p.hint || '' }, el('span', { textContent: p.label }), input);
  switch (p.kind) {
    case 'bool': {
      const input = el('input', { type: 'checkbox', id, checked: p.value === true, disabled: !p.enabled });
      input.onchange = () => change(input.checked);
      return el('label', { className: 'field check', title: p.hint || '' }, input, el('span', { textContent: p.label }));
    }
    case 'list': {
      const input = el('select', { id, disabled: !p.enabled }, ...(p.items || []).map((o) => el('option', { value: String(o.value), textContent: o.name || String(o.value), selected: String(o.value) === String(p.value) })));
      input.onchange = () => {
        const item = (p.items || []).find((o) => String(o.value) === input.value);
        change(item ? item.value : input.value);
      };
      return label(input);
    }
    case 'int':
    case 'float': {
      const input = el('input', { type: 'number', id, value: String(p.value ?? ''), disabled: !p.enabled });
      if (Number.isFinite(p.min)) input.min = String(p.min);
      if (Number.isFinite(p.max)) input.max = String(p.max);
      if (Number.isFinite(p.step)) input.step = String(p.step);
      input.onchange = () => change(Number(input.value));
      return label(input);
    }
    case 'slider': {
      const range = el('input', { type: 'range', id, value: String(p.value ?? 0), disabled: !p.enabled, min: String(p.min ?? 0), max: String(p.max ?? 100), step: String(p.step ?? 1) });
      const num = el('input', { type: 'number', value: String(p.value ?? 0), disabled: !p.enabled, min: range.min, max: range.max, step: range.step, ariaLabel: p.label });
      range.oninput = () => (num.value = range.value);
      range.onchange = () => change(Number(range.value));
      num.onchange = () => {
        range.value = num.value;
        change(Number(num.value));
      };
      return label(el('div', { className: 'slider-row' }, range, num));
    }
    case 'textarea': {
      const input = el('textarea', { id, value: String(p.value ?? ''), disabled: !p.enabled, spellcheck: false, rows: 4 });
      input.onchange = () => change(input.value);
      return label(input, 'wide');
    }
    case 'info':
      return el('p', { className: 'field info wide', textContent: p.label + (p.value ? ` ${p.value}` : '') });
    case 'button':
      return el('div', { className: 'field btn-field' }, el('button', { type: 'button', className: 'btn', textContent: p.label, disabled: !p.enabled, onclick: () => ctx.press && ctx.press(p.name) }));
    case 'path': {
      const input = el('input', { type: 'text', id, value: String(p.value ?? ''), disabled: !p.enabled, spellcheck: false });
      input.onchange = () => change(input.value);
      const browse = el('button', { type: 'button', className: 'btn', textContent: tr('studio.browse'), disabled: !p.enabled });
      browse.onclick = async () => {
        const paths = ctx.pick ? await ctx.pick({ pathType: p.pathType, filter: p.filter, defaultPath: input.value || p.defaultPath }) : [];
        if (paths && paths[0]) {
          input.value = paths[0];
          change(paths[0]);
        }
      };
      return label(el('div', { className: 'path-row' }, input, browse), 'wide');
    }
    case 'color':
    case 'color-alpha': {
      const c = colorToHex(p.value);
      const input = el('input', { type: 'color', id, value: c.hex, disabled: !p.enabled });
      const parts = [input];
      let alpha = null;
      if (p.kind === 'color-alpha') {
        alpha = el('input', { type: 'range', min: '0', max: '255', value: String(c.alpha), disabled: !p.enabled, ariaLabel: tr('studio.color.opacity'), title: tr('studio.color.opacity') });
        parts.push(alpha);
      }
      const save = () => change(hexToColor(input.value, alpha ? Number(alpha.value) : 255));
      input.onchange = save;
      if (alpha) alpha.onchange = save;
      return label(el('div', { className: 'color-row' }, ...parts));
    }
    case 'font': {
      const f = p.value && typeof p.value === 'object' ? p.value : { face: 'Arial', style: '', size: 36, flags: 0 };
      // The PC's installed font families to pick from (typing any name still works).
      const face = el('input', { type: 'text', id, value: f.face || '', disabled: !p.enabled, spellcheck: false, ariaLabel: p.label, autocomplete: 'off' });
      face.setAttribute('list', fontList());
      const size = el('input', { type: 'number', min: '4', max: '1000', value: String(f.size || 36), disabled: !p.enabled, ariaLabel: tr('studio.font.size'), title: tr('studio.font.size') });
      const checks = FONT_FLAGS.map(([bit, key]) => {
        const box = el('input', { type: 'checkbox', checked: Boolean((f.flags || 0) & bit), disabled: !p.enabled });
        box.dataset.bit = String(bit);
        return { box, node: el('label', { className: 'font-flag' }, box, el('span', { textContent: tr(key) })) };
      });
      const save = () => change({ face: face.value.trim() || 'Arial', style: f.style || '', size: Number(size.value) || 36, flags: checks.reduce((n, c) => (c.box.checked ? n | Number(c.box.dataset.bit) : n), 0) });
      face.onchange = save;
      size.onchange = save;
      for (const c of checks) c.box.onchange = save;
      return label(el('div', { className: 'font-row' }, el('div', { className: 'font-main' }, face, size), el('div', { className: 'font-flags' }, ...checks.map((c) => c.node))), 'wide');
    }
    case 'files': {
      // An editable list (a slideshow's images, a VLC playlist): add files, remove, reorder.
      let list = Array.isArray(p.value) ? p.value.map((x) => ({ value: String(x.value || ''), hidden: x.hidden === true })).filter((x) => x.value) : [];
      const ul = el('ul', { className: 'file-list' });
      const save = () => change(list);
      const draw = () => {
        ul.replaceChildren(
          ...(list.length
            ? list.map((x, i) =>
                el(
                  'li',
                  {},
                  el('span', { className: 'file-name', textContent: x.value.split(/[\\/]/).pop(), title: x.value }),
                  iconBtn('up', tr('studio.up'), () => {
                    if (i === 0) return;
                    [list[i - 1], list[i]] = [list[i], list[i - 1]];
                    draw();
                    save();
                  }, 'quiet'),
                  iconBtn('down', tr('studio.down'), () => {
                    if (i === list.length - 1) return;
                    [list[i + 1], list[i]] = [list[i], list[i + 1]];
                    draw();
                    save();
                  }, 'quiet'),
                  iconBtn('trash', tr('studio.remove'), () => {
                    list.splice(i, 1);
                    draw();
                    save();
                  }, 'quiet'),
                ),
              )
            : [el('li', { className: 'empty', textContent: tr('studio.files.empty') })]),
        );
      };
      draw();
      const add = el('button', { type: 'button', className: 'btn', textContent: tr('studio.addFiles'), disabled: !p.enabled });
      add.onclick = async () => {
        const paths = ctx.pick ? await ctx.pick({ pathType: 0, filter: p.filter, defaultPath: p.defaultPath, multi: true }) : [];
        if (!paths || !paths.length) return;
        list = [...list, ...paths.map((value) => ({ value, hidden: false }))];
        draw();
        save();
      };
      return el('div', { className: 'field wide' }, el('span', { textContent: p.label }), ul, el('div', {}, add));
    }
    default: {
      const input = el('input', { type: p.kind === 'password' ? 'password' : 'text', id, value: String(p.value ?? ''), disabled: !p.enabled, spellcheck: false });
      input.onchange = () => change(input.value);
      return label(input);
    }
  }
}
