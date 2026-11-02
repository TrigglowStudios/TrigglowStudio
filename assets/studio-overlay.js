// The layer over Trigglow Studio's preview: a transparent window of ours (main.ts placeStudioOverlay) exactly over the
// engine's native preview. It draws what OBS draws on its preview (the selected item's border with its eight handles,
// a thin outline under the mouse) and does the dragging: move, resize from the handles, snap to the canvas edges and
// centre lines (and the other sources' edges), drawing the guide it snaps to. Alt + a handle crops; Ctrl+click adds to
// the selection and the selected items move together; a rotated item scales from its corners (keeping its shape).
// Everything is in canvas pixels; the engine says where the canvas sits in the preview (op `region`).
const shell = window.trigglowShell;
const cv = document.getElementById('c');
const ctx = cv.getContext('2d');

const HANDLE_PX = 9; // how close to a handle (CSS px) grabs it
const HANDLE_SIZE = 8;
const SNAP_PX = 10;
const ACCENT = '#a18aff';
let view = null;
let region = null; // where the canvas sits inside the preview, device px
let hover = null; // id of the item under the mouse
let drag = null;
/** Transforms waiting to go to the engine, by item: at most one in flight each, the latest position wins. */
const pending = new Map();
/** The snap guides to draw while dragging: vertical lines at these x, horizontal at these y (canvas px). */
let guides = { x: [], y: [] };

const dpr = () => window.devicePixelRatio || 1;
/** Canvas px per CSS px of this window. */
const perPx = () => (view && region ? (view.canvas.width / region.width) * dpr() : 1);
/** Canvas px → this window's CSS px. */
const toScreen = (x, y) => ({ x: (x / perPx()) + region.x / dpr(), y: (y / perPx()) + region.y / dpr() });
const toCanvas = (e) => (region && view ? { x: (e.clientX - region.x / dpr()) * perPx(), y: (e.clientY - region.y / dpr()) * perPx() } : null);
const inBox = (b, p) => p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
const selectedAll = () => (view ? view.items.filter((i) => i.selected) : []);
/** The one selected item (handles only show for a single selection). */
const selected = () => {
  const all = selectedAll();
  return all.length === 1 ? all[0] : null;
};
const canResize = (it) => it && it.visible && !it.locked;
/** Locked items are out of the mouse's way on the preview, like in OBS: a click goes to what's under them. */
const pickable = (i) => i.visible && !i.locked && i.box.width > 0;

/** A rotated item only has corner handles: it scales, keeping its shape. */
function handlesOf(b, rotated = false) {
  const xs = { w: b.x, c: b.x + b.width / 2, e: b.x + b.width };
  const ys = { n: b.y, c: b.y + b.height / 2, s: b.y + b.height };
  const all = [['nw', xs.w, ys.n], ['n', xs.c, ys.n], ['ne', xs.e, ys.n], ['e', xs.e, ys.c], ['se', xs.e, ys.s], ['s', xs.c, ys.s], ['sw', xs.w, ys.s], ['w', xs.w, ys.c]];
  return rotated ? all.filter(([n]) => n.length === 2) : all;
}

/* ---------------------------------- drawing ---------------------------------- */

function draw() {
  const w = cv.clientWidth;
  const h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr()) || cv.height !== Math.round(h * dpr())) {
    cv.width = Math.round(w * dpr());
    cv.height = Math.round(h * dpr());
  }
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!view || !region) return;
  const rect = (b) => {
    const a = toScreen(b.x, b.y);
    const z = toScreen(b.x + b.width, b.y + b.height);
    return { x: Math.round(a.x) + 0.5, y: Math.round(a.y) + 0.5, w: Math.round(z.x - a.x), h: Math.round(z.y - a.y) };
  };
  // What's under the mouse: a thin outline, so even an empty or transparent source can be found.
  const hov = view.items.find((i) => i.id === hover && !i.selected && i.visible);
  if (hov) {
    const r = rect(hov.box);
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(239,233,225,0.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
    ctx.setLineDash([]);
  }
  // Snap guides: the line the dragged item is held to, across the whole canvas.
  if (drag && (guides.x.length || guides.y.length)) {
    const tl = toScreen(0, 0);
    const br = toScreen(view.canvas.width, view.canvas.height);
    ctx.strokeStyle = '#ff5c8a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const gx of guides.x) {
      const sx = Math.round(toScreen(gx, 0).x) + 0.5;
      ctx.moveTo(sx, tl.y);
      ctx.lineTo(sx, br.y);
    }
    for (const gy of guides.y) {
      const sy = Math.round(toScreen(0, gy).y) + 0.5;
      ctx.moveTo(tl.x, sy);
      ctx.lineTo(br.x, sy);
    }
    ctx.stroke();
  }
  const all = selectedAll().filter((i) => i.visible);
  for (const it of all) {
    const r = rect(it.box);
    ctx.strokeStyle = it.locked ? 'rgba(239,233,225,0.6)' : drag && drag.mode === 'crop' ? '#5cd6ff' : ACCENT;
    ctx.lineWidth = 2;
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
  const sel = selected();
  if (!sel || !sel.visible || !canResize(sel)) return;
  for (const [, hx, hy] of handlesOf(sel.box, sel.rotated)) {
    const p = toScreen(hx, hy);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 1.5;
    ctx.fillRect(Math.round(p.x - HANDLE_SIZE / 2), Math.round(p.y - HANDLE_SIZE / 2), HANDLE_SIZE, HANDLE_SIZE);
    ctx.strokeRect(Math.round(p.x - HANDLE_SIZE / 2) + 0.5, Math.round(p.y - HANDLE_SIZE / 2) + 0.5, HANDLE_SIZE - 1, HANDLE_SIZE - 1);
  }
}

/* --------------------------------- the engine --------------------------------- */

function setView(v) {
  if (!v) return;
  view = v;
  if (drag) {
    // keep the item being dragged as it is on screen: the engine's answer may lag a step behind the mouse
    const it = view.items.find((i) => i.id === drag.id);
    if (it && drag.live) it.box = drag.live;
  }
  draw();
}

async function refresh() {
  const [r, v] = await Promise.all([shell.studio({ op: 'region' }), shell.studio({ op: 'view' })]);
  region = r && r.region && r.region.width > 0 ? r.region : null;
  if (v && v.view) setView(v.view);
  else draw();
}

function sendTransform(id, value, op = 'transform') {
  // At most one in flight per item: the latest position wins, the engine never queues up a backlog of drags.
  const waiting = pending.get(id);
  if (waiting) {
    waiting.value = value;
    waiting.op = op;
    return;
  }
  const entry = { value, op };
  pending.set(id, entry);
  const flush = async () => {
    const sent = { ...entry };
    const r = await shell.studio({ op: sent.op, id, value: sent.value });
    if (entry.value !== sent.value) return flush();
    pending.delete(id);
    if (r && r.view) setView(r.view);
  };
  void flush();
}

/** What's under the mouse: a handle of the selected item first, then the topmost visible, unlocked item. */
function hit(p) {
  const sel = selected();
  if (canResize(sel)) {
    const d = HANDLE_PX * perPx();
    for (const [name, hx, hy] of handlesOf(sel.box, sel.rotated)) if (Math.abs(p.x - hx) <= d && Math.abs(p.y - hy) <= d) return { item: sel, mode: 'resize', handle: name };
  }
  const item = view.items.find((i) => pickable(i) && inBox(i.box, p));
  return item ? { item, mode: 'move' } : null;
}

const CURSORS = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

/**
 * Snaps a box's edges and centre to the canvas's edges and centre lines and to the other visible items' edges (not
 * the ones being dragged); `guides` gets the lines it snapped to.
 */
function snap(box, skip) {
  const c = view.canvas;
  const d = SNAP_PX * perPx();
  const others = view.items.filter((i) => i.visible && !skip.includes(i.id) && i.box.width > 0);
  const targetsX = [0, c.width, c.width / 2, ...others.flatMap((i) => [i.box.x, i.box.x + i.box.width])];
  const targetsY = [0, c.height, c.height / 2, ...others.flatMap((i) => [i.box.y, i.box.y + i.box.height])];
  const pick = (pos, size, targets) => {
    let best = null;
    for (const edge of [pos, pos + size, pos + size / 2])
      for (const at of targets) if (Math.abs(edge - at) <= d && (!best || Math.abs(edge - at) < Math.abs(best.edge - best.at))) best = { edge, at };
    return best ? { pos: pos + (best.at - best.edge), line: best.at } : { pos, line: null };
  };
  const sx = pick(box.x, box.width, targetsX);
  const sy = pick(box.y, box.height, targetsY);
  guides = { x: sx.line === null ? [] : [sx.line], y: sy.line === null ? [] : [sy.line] };
  return { ...box, x: sx.pos, y: sy.pos };
}

/** The box around several boxes. */
function union(boxes) {
  const x1 = Math.min(...boxes.map((b) => b.x));
  const y1 = Math.min(...boxes.map((b) => b.y));
  const x2 = Math.max(...boxes.map((b) => b.x + b.width));
  const y2 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/* ----------------------------------- mouse ----------------------------------- */

window.addEventListener('mousedown', (e) => {
  if (!view || !region) return;
  const p = toCanvas(e);
  if (!p) return;
  const h = hit(p);
  if (e.button === 2) return; // the menu comes with contextmenu
  if (e.button !== 0) return;
  // Ctrl+click: in or out of the selection, no drag.
  if ((e.ctrlKey || e.metaKey) && h) {
    h.item.selected = !h.item.selected;
    draw();
    void shell.studio({ op: 'select', id: h.item.id, value: 'add' });
    return;
  }
  // Clicking an item that isn't selected selects only it; clicking a selected one keeps the group to move together.
  if (!h || !h.item.selected) {
    for (const i of view.items) i.selected = Boolean(h) && i.id === h.item.id;
    void shell.studio({ op: 'select', id: h ? h.item.id : null });
  }
  // The drag starts right away, from what's on screen; the engine hears about the selection in the background.
  if (!h || h.item.locked) {
    drag = null;
    draw();
    return;
  }
  const group = h.mode === 'move' ? selectedAll().filter((i) => i.visible && !i.locked && i.trigglow !== 'alerts').map((i) => ({ id: i.id, box: { ...i.box } })) : [];
  drag = { id: h.item.id, mode: h.mode, handle: h.handle, start: p, box: { ...h.item.box }, alerts: h.item.trigglow === 'alerts', rotated: h.item.rotated, live: null, group };
  // Alt + a handle crops (OBS): the crop is in the source's pixels, so it needs the item's transform first.
  if (h.mode === 'resize' && e.altKey && !h.item.rotated && !drag.alerts) {
    drag.mode = 'crop';
    const d = drag;
    shell.studio({ op: 'item-transform', id: h.item.id }).then((r) => {
      const tf = r && r.transform;
      // Fit-to-screen (bounds) items crop from their own dialog: here only plain scaled ones.
      if (drag === d) d.tf = tf && !tf.boundsType && tf.sourceWidth > 0 ? tf : null;
    });
  }
  draw();
});

window.addEventListener('mousemove', (e) => {
  if (!view) return;
  const p = toCanvas(e);
  if (!p) return;
  if (!drag) {
    const h = hit(p);
    const id = h && h.mode === 'move' ? h.item.id : null;
    if (id !== hover) {
      hover = id;
      draw();
    }
    document.body.style.cursor = !h ? '' : h.mode === 'resize' ? CURSORS[h.handle] : h.item.locked || h.item.trigglow === 'alerts' ? 'default' : 'move';
    return;
  }
  const dx = p.x - drag.start.x;
  const dy = p.y - drag.start.y;
  const b = drag.box;
  let next;
  if (drag.mode === 'crop') return void cropDrag(dx, dy);
  if (drag.mode === 'move' && drag.group.length > 1) return void moveGroup(dx, dy, e.altKey);
  if (drag.mode === 'move') {
    if (drag.alerts) return; // always centred
    const moved = { ...b, x: b.x + dx, y: b.y + dy };
    if (e.altKey) guides = { x: [], y: [] };
    next = e.altKey ? moved : snap(moved, [drag.id]);
  } else {
    // Resize from a handle: the opposite side stays put; corners keep the aspect ratio unless Shift is held.
    const hd = drag.handle;
    let x1 = b.x;
    let y1 = b.y;
    let x2 = b.x + b.width;
    let y2 = b.y + b.height;
    if (hd.includes('w')) x1 = Math.min(x2 - 16, b.x + dx);
    if (hd.includes('e')) x2 = Math.max(x1 + 16, b.x + b.width + dx);
    if (hd.includes('n')) y1 = Math.min(y2 - 16, b.y + dy);
    if (hd.includes('s')) y2 = Math.max(y1 + 16, b.y + b.height + dy);
    let width = x2 - x1;
    let height = y2 - y1;
    if (hd.length === 2 && (!e.shiftKey || drag.rotated)) {
      const k = Math.max(width / Math.max(1, b.width), height / Math.max(1, b.height));
      width = b.width * k;
      height = b.height * k;
      if (hd.includes('w')) x1 = b.x + b.width - width;
      if (hd.includes('n')) y1 = b.y + b.height - height;
    }
    next = drag.alerts ? { x: b.x, y: b.y, width, height } : { x: x1, y: y1, width, height };
  }
  next = { x: Math.round(next.x), y: Math.round(next.y), width: Math.round(next.width ?? b.width), height: Math.round(next.height ?? b.height) };
  // Draw it where the mouse is now; the engine catches up.
  drag.live = drag.alerts ? { ...next, x: (view.canvas.width - next.width) / 2, y: (view.canvas.height - next.height) / 2 } : next;
  const it = view.items.find((i) => i.id === drag.id);
  if (it) it.box = drag.live;
  draw();
  sendTransform(drag.id, drag.mode === 'move' ? { x: next.x, y: next.y } : next);
});

/** Several selected items move together; the group snaps as one box. */
function moveGroup(dx, dy, free) {
  const ids = drag.group.map((g) => g.id);
  const start = union(drag.group.map((g) => g.box));
  const moved = { ...start, x: start.x + dx, y: start.y + dy };
  if (free) guides = { x: [], y: [] };
  const to = free ? moved : snap(moved, ids);
  const ox = Math.round(to.x - start.x);
  const oy = Math.round(to.y - start.y);
  for (const g of drag.group) {
    const it = view.items.find((i) => i.id === g.id);
    const box = { ...g.box, x: g.box.x + ox, y: g.box.y + oy };
    if (it) it.box = box;
    sendTransform(g.id, { x: box.x, y: box.y });
  }
  draw();
}

/** Alt + handle: crops that side (in the source's pixels) and keeps the rest of the picture where it was. */
function cropDrag(dx, dy) {
  const tf = drag.tf;
  if (!tf) return;
  const c = tf.crop;
  const sw = tf.sourceWidth;
  const sh = tf.sourceHeight;
  const kx = tf.width / Math.max(1, sw - c.left - c.right); // canvas px per source px
  const ky = tf.height / Math.max(1, sh - c.top - c.bottom);
  const hd = drag.handle;
  const crop = { ...c };
  let x = tf.x;
  let y = tf.y;
  const clamp = (v, max) => Math.max(0, Math.min(max, Math.round(v)));
  if (hd.includes('w')) {
    crop.left = clamp(c.left + dx / kx, sw - c.right - 1);
    x = tf.x + (crop.left - c.left) * kx;
  }
  if (hd.includes('e')) crop.right = clamp(c.right - dx / kx, sw - c.left - 1);
  if (hd.includes('n')) {
    crop.top = clamp(c.top + dy / ky, sh - c.bottom - 1);
    y = tf.y + (crop.top - c.top) * ky;
  }
  if (hd.includes('s')) crop.bottom = clamp(c.bottom - dy / ky, sh - c.top - 1);
  const box = { x: Math.round(x), y: Math.round(y), width: Math.round((sw - crop.left - crop.right) * kx), height: Math.round((sh - crop.top - crop.bottom) * ky) };
  drag.live = box;
  const it = view.items.find((i) => i.id === drag.id);
  if (it) it.box = box;
  draw();
  sendTransform(drag.id, { crop, x: box.x, y: box.y }, 'set-transform');
}

window.addEventListener('mouseup', () => {
  drag = null;
  guides = { x: [], y: [] };
  draw();
});
window.addEventListener('mouseleave', () => {
  if (hover !== null) {
    hover = null;
    draw();
  }
});

// Right-click and double-click go to the Studio page, which has the menus and pop-ups.
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const p = toCanvas(e);
  const h = p && view ? view.items.find((i) => pickable(i) && inBox(i.box, p)) : null;
  if (h && !h.selected) {
    for (const i of view.items) i.selected = i.id === h.id;
    draw();
  }
  shell.studioOverlayEvent({ type: 'contextmenu', id: h ? h.id : null });
});
window.addEventListener('dblclick', (e) => {
  const p = toCanvas(e);
  const h = p && view ? view.items.find((i) => pickable(i) && inBox(i.box, p)) : null;
  if (h) shell.studioOverlayEvent({ type: 'dblclick', id: h.id });
});

/* ----------------------------------- start ----------------------------------- */

shell.onStudio((kind, p) => {
  if (kind === 'view') setView(p);
});
new ResizeObserver(() => void refresh()).observe(document.body);
window.addEventListener('focus', () => void refresh());
void refresh();
