import { ac } from './audio';
import { Engine, type Cable } from './engine';
import { C, Gfx, textWidth } from './gfx';
import { CAT, TYPEC, compatible, type Cat, type Drag, type Knob, type Mod, type Port } from './mod';
import { KINDS, Keys } from './modules';
import { PATCHES, type PatchData } from './patches';
import { cablePoints, drawButton, drawCable, drawModule, plug } from './render';
import { Recorder } from './rec';
import { decodePatch, encodePatch, hashCode } from './share';

// The patch field zooms; the UI overlay (toolbar, menu, hints) keeps a fixed pixel scale.
const canvas = document.getElementById('c') as HTMLCanvasElement;
const uiCanvas = document.getElementById('ui') as HTMLCanvasElement;
const g = new Gfx(canvas.getContext('2d')!);
const ui = new Gfx(uiCanvas.getContext('2d')!);
const eng = new Engine();
const SAVE_KEY = 'pixel-modular.patch.v1';

const uiScale = innerWidth >= 1500 ? 3 : 2;
let scale = uiScale;
let W = 0, H = 0, UW = 0, UH = 0;
let camX = 0, camY = 0;
let clientX = -1000, clientY = -1000;
let mx = 0, my = 0, ux = 0, uy = 0;
let spawnCount = 0;
let everPlayed = false;
let toast = { text: '', until: 0 };

// Editing state: selected modules, a selected cable, cable visibility, copy buffer
// and the "name this patch" prompt.
const selected = new Set<Mod>();
let selCable: Cable | null = null;
let wires = 0; // 0 shown, 1 dimmed, 2 hidden
let clipboard: PatchData | null = null;
let namePrompt: { text: string; done: (name: string) => void } | null = null;

function showToast(text: string) {
  toast = { text, until: performance.now() + 2500 };
}

function sizeCanvas(c: HTMLCanvasElement, s: number) {
  const w = Math.ceil(innerWidth / s), h = Math.ceil(innerHeight / s);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  c.style.width = w * s + 'px';
  c.style.height = h * s + 'px';
  return [w, h];
}

function resize() {
  [W, H] = sizeCanvas(canvas, scale);
  [UW, UH] = sizeCanvas(uiCanvas, uiScale);
}

function updatePointer() {
  mx = Math.floor(clientX / scale);
  my = Math.floor(clientY / scale);
  ux = Math.floor(clientX / uiScale);
  uy = Math.floor(clientY / uiScale);
}

// ---------------------------------------------------------------- toolbar

interface MenuItem {
  label: string; col: string; text: string;
  act?: () => void;
  spawn?: string;
  header?: boolean; // a non-clickable section title
  del?: () => void; // right-click action
}
interface Btn {
  label: string; x: number; y: number; w: number;
  col: string; text: string; hi: string;
  act?: () => void;
  menu?: MenuItem[];
}
let bar: Btn[] = [];
let barH = 13;
let openMenu: string | null = null;
// Bar height in field pixels, for keeping modules out from under it.
const barWorld = () => Math.ceil((barH * uiScale) / scale);

function togglePlay() {
  if (eng.running) eng.stop();
  else { eng.start(); everPlayed = true; }
}

// ---------------------------------------------------------------- recording

const recorder = new Recorder(eng.output);

function toggleRec() {
  void ac.resume();
  if (!recorder.recording) {
    void recorder.start().then(() => showToast('RECORDING - CLICK AGAIN TO SAVE'));
    return;
  }
  download(recorder.stop()!, `pixel-modular-${stamp()}.wav`);
  showToast('RECORDING SAVED');
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function recLabel() {
  const s = Math.floor(recorder.seconds);
  return recorder.recording ? `  ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : '  REC';
}

function layoutBar() {
  const cats = Object.keys(CAT) as Cat[];
  const items: Omit<Btn, 'x' | 'y' | 'w'>[] = [
    eng.running
      ? { label: '  STOP', col: C.red, text: C.ink, hi: C.white, act: togglePlay }
      : { label: '  PLAY', col: C.green, text: C.ink, hi: C.white, act: togglePlay },
    { label: recLabel(), col: recorder.recording ? C.red : C.silver, text: C.ink, hi: C.white, act: toggleRec },
    { label: 'PATCHES', col: C.silver, text: C.ink, hi: C.white, menu: patchesMenu() },
    ...cats.map((cat) => ({
      label: CAT[cat].name, col: CAT[cat].bar, text: C.white, hi: CAT[cat].cap,
      menu: KINDS.filter((k) => k.cat === cat).map((k) => ({ label: k.label, col: CAT[cat].bar, text: C.white, spawn: k.type })),
    })),
    { label: 'UNDO', col: C.silver, text: C.ink, hi: C.white, act: undo },
    { label: 'REDO', col: C.silver, text: C.ink, hi: C.white, act: redo },
    { label: 'WIRES', col: [C.silver, C.slate, C.dark][wires], text: wires === 2 ? C.silver : C.ink, hi: C.white, act: cycleWires },
    { label: 'SHARE', col: C.silver, text: C.ink, hi: C.white, act: () => void share() },
    { label: 'CLEAR', col: C.silver, text: C.ink, hi: C.white, act: () => eng.clear() },
  ];
  bar = [];
  let x = 2, y = 2;
  for (const it of items) {
    const w = textWidth(it.label) + (it.menu ? 14 : 8);
    if (x + w > UW - 2 && x > 2) { x = 2; y += 11; }
    bar.push({ ...it, x, y, w });
    x += w + 2;
    // Small gaps separate transport, patches, modules and the rest.
    if (it.act === toggleRec || it.label === 'PATCHES' || it.label === CAT.util.name) x += 6;
  }
  barH = y + 12;
}

const MENU_ROW = 10;
const openBtn = () => bar.find((b) => b.label === openMenu && b.menu);

function menuRect(b: Btn) {
  const w = Math.max(b.w, ...b.menu!.map((m) => textWidth(m.label) + 12));
  return { x: b.x, y: b.y + 10, w, h: b.menu!.length * MENU_ROW + 2 };
}

function menuItemAt(x: number, y: number) {
  const b = openBtn();
  if (!b) return null;
  const r = menuRect(b);
  if (x < r.x || x >= r.x + r.w || y < r.y + 1 || y >= r.y + r.h - 1) return null;
  return b.menu![Math.floor((y - r.y - 1) / MENU_ROW)] ?? null;
}

function drawBar() {
  ui.rect(0, 0, UW, barH, C.black);
  ui.rect(0, barH - 1, UW, 1, C.dark);
  for (const b of bar) {
    const hover = ux >= b.x && ux < b.x + b.w && uy >= b.y && uy < b.y + 9;
    const active = hover || openMenu === b.label;
    drawButton(ui, b.x, b.y, b.w, '', active ? b.hi : b.col);
    ui.text(b.label, b.x + 4, b.y + 2, active ? C.ink : b.text);
    if (b.menu) {
      const ax = b.x + b.w - 8, ac = active ? C.ink : b.text;
      for (let i = 0; i < 3; i++) ui.rect(ax + i, b.y + 3 + i, 5 - i * 2, 1, ac);
    }
    if (b.act === toggleRec) {
      const on = !recorder.recording || Math.floor(performance.now() / 400) % 2 === 0;
      ui.disc(b.x + 6, b.y + 4, 2, on ? C.red : C.ink);
      if (recorder.recording && on) ui.disc(b.x + 6, b.y + 4, 2, C.white);
    }
    if (b.act === togglePlay) {
      if (eng.running) ui.rect(b.x + 4, b.y + 2, 5, 5, C.ink);
      else for (let i = 0; i < 3; i++) ui.rect(b.x + 4 + i, b.y + 2 + i, 1, 5 - i * 2, C.ink);
    }
  }
  const b = openBtn();
  if (b) {
    const r = menuRect(b), hi = menuItemAt(ux, uy);
    ui.rect(r.x + 2, r.y + 2, r.w, r.h, C.black);
    ui.rect(r.x, r.y, r.w, r.h, C.black);
    ui.rect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, C.dark);
    b.menu!.forEach((m, i) => {
      const y = r.y + 1 + i * MENU_ROW;
      if (m.header) {
        ui.rect(r.x + 1, y, r.w - 2, MENU_ROW, C.ink);
        ui.text(m.label, r.x + 4, y + 3, C.slate);
        return;
      }
      if (m === hi) ui.rect(r.x + 1, y, r.w - 2, MENU_ROW, m.col);
      else ui.rect(r.x + 1, y, 2, MENU_ROW, m.col);
      ui.text(m.label, r.x + 6, y + 3, m === hi ? m.text : C.white);
    });
  }
}

// ---------------------------------------------------------------- hit testing

type Hit =
  | { k: 'bar'; b: Btn }
  | { k: 'menu'; item: MenuItem }
  | { k: 'close'; m: Mod }
  | { k: 'port'; m: Mod; p: Port }
  | { k: 'knob'; m: Mod; kn: Knob }
  | { k: 'cable'; c: Cable }
  | { k: 'body'; m: Mod; lx: number; ly: number }
  | { k: 'none' };

function modAt(wx: number, wy: number) {
  for (let i = eng.mods.length - 1; i >= 0; i--) {
    const m = eng.mods[i];
    if (wx >= m.x && wx < m.x + m.w && wy >= m.y && wy < m.y + m.h) return m;
  }
  return undefined;
}

function hitTest(): Hit {
  const item = menuItemAt(ux, uy);
  if (item) return { k: 'menu', item };
  if (uy < barH) {
    const b = bar.find((b) => ux >= b.x && ux < b.x + b.w && uy >= b.y && uy < b.y + 9);
    return b ? { k: 'bar', b } : { k: 'none' };
  }
  const wx = mx + camX, wy = my + camY;
  const m = modAt(wx, wy);
  if (m) {
    const lx = wx - m.x, ly = wy - m.y;
    if (lx >= m.w - 9 && lx < m.w - 2 && ly >= 1 && ly < 9) return { k: 'close', m };
    const p = m.ports.find((p) => Math.abs(lx - (p.x + 4)) <= 5 && Math.abs(ly - (p.y + 4)) <= 5);
    if (p) return { k: 'port', m, p };
    const kn = m.knobs.find((k) => lx >= k.x - 1 && lx < k.x + 12 && ly >= k.y - 1 && ly < k.y + 12);
    if (kn) return { k: 'knob', m, kn };
  }
  // Cables lie on top of modules, but dimmed cables only catch clicks on empty ground.
  if (wires === 0 || (wires === 1 && !m)) {
    const c = cableAt(wx, wy, m ? 1 : 2);
    if (c) return { k: 'cable', c };
  }
  return m ? { k: 'body', m, lx: wx - m.x, ly: wy - m.y } : { k: 'none' };
}

function cableEnds(c: Cable) {
  const pa = c.a.ports.find((p) => p.id === c.ap)!, pb = c.b.ports.find((p) => p.id === c.bp)!;
  return [...jackPos(c.a, pa), ...jackPos(c.b, pb)] as const;
}

function cableAt(wx: number, wy: number, r: number) {
  for (let i = eng.cables.length - 1; i >= 0; i--) {
    const c = eng.cables[i];
    for (const [x, y] of cablePoints(...cableEnds(c))) {
      if (Math.abs(wx - x - 0.5) <= r && Math.abs(wy - y - 0.5) <= r) return c;
    }
  }
  return null;
}

const jackPos = (m: Mod, p: Port) => [m.x + p.x + 4, m.y + p.y + 4] as const;

function canPlug(a: Port, b: Port) {
  if (a.dir === b.dir) return false;
  return a.dir === 'out' ? compatible(a.type, b.type) : compatible(b.type, a.type);
}

// Nearest port that the dragged cable end could plug into.
function dropTarget(from: { m: Mod; p: Port }, wx: number, wy: number) {
  let best: { m: Mod; p: Port } | null = null, bd = 9;
  for (const m of eng.mods) {
    for (const p of m.ports) {
      if (!canPlug(from.p, p)) continue;
      const [x, y] = jackPos(m, p);
      const d = Math.max(Math.abs(x - wx), Math.abs(y - wy));
      if (d < bd) { bd = d; best = { m, p }; }
    }
  }
  return best;
}

// ---------------------------------------------------------------- interaction

type Mode =
  | { k: 'none' }
  | { k: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | {
    k: 'move'; m: Mod; dx: number; dy: number; sx: number; sy: number; spawned: boolean; moved: boolean;
    group: { m: Mod; ox: number; oy: number }[]; // other selected modules, relative to m
  }
  | { k: 'box'; x0: number; y0: number }
  | { k: 'cable'; m: Mod; p: Port }
  | { k: 'knob'; m: Mod; kn: Knob; sy: number; sv: number }
  | { k: 'drag'; m: Mod; d: Drag };

let mode: Mode = { k: 'none' };
let lastKnob = { kn: null as Knob | null, t: 0 };

function toFront(m: Mod) {
  eng.mods = eng.mods.filter((x) => x !== m);
  eng.mods.push(m);
}

function placeInView(m: Mod) {
  const j = (spawnCount++ % 6) * 10;
  const top = barWorld();
  m.x = camX + Math.floor((W - m.w) / 2) + j - 25;
  m.y = camY + top + Math.floor((H - top - m.h) / 2) + j - 25;
}

// New modules hang off the cursor; a plain click drops them in the middle of the view.
function spawn(type: string) {
  const m = KINDS.find((k) => k.type === type)!.make(eng);
  m.x = mx + camX - 12;
  m.y = my + camY - 4;
  eng.add(m);
  selected.clear();
  selected.add(m);
  mode = { k: 'move', m, dx: 12, dy: 4, sx: mx, sy: my, spawned: true, moved: false, group: [] };
}

function setPointer(e: MouseEvent) {
  clientX = e.clientX;
  clientY = e.clientY;
  updatePointer();
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  setPointer(e);
  canvas.setPointerCapture(e.pointerId);
  void ac.resume();
  if (e.button === 1) { mode = { k: 'pan', sx: mx, sy: my, cx: camX, cy: camY }; return; }
  if (namePrompt) { namePrompt = null; return; }
  const h = hitTest();

  if (h.k === 'menu' && (h.item.header || (e.button === 2 && h.item.del))) {
    if (e.button === 2) h.item.del!();
    return;
  }
  if (openMenu || (h.k === 'bar' && h.b.menu)) {
    const was = openMenu;
    openMenu = null;
    if (h.k === 'menu') {
      if (h.item.spawn) spawn(h.item.spawn);
      else h.item.act?.();
    } else if (h.k === 'bar' && h.b.menu && h.b.label !== was) {
      openMenu = h.b.label;
    }
    return;
  }

  if (e.button === 2) {
    if (h.k === 'port') for (const c of eng.cablesAt(h.m, h.p.id)) eng.disconnect(c);
    if (h.k === 'cable') { eng.disconnect(h.c); selCable = null; }
    return;
  }
  if (h.k !== 'cable') selCable = null;

  switch (h.k) {
    case 'bar': {
      h.b.act?.();
      return;
    }
    case 'close':
      eng.remove(h.m);
      selected.delete(h.m);
      return;
    case 'cable':
      selCable = h.c;
      selected.clear();
      return;
    case 'port': {
      toFront(h.m);
      const plugged = eng.cablesAt(h.m, h.p.id);
      if (h.p.dir === 'in' && plugged.length) {
        // Pick up the most recent cable by its plug and carry it from the other end.
        const c = plugged[plugged.length - 1];
        eng.disconnect(c);
        mode = { k: 'cable', m: c.a, p: c.a.ports.find((p) => p.id === c.ap)! };
      } else {
        mode = { k: 'cable', m: h.m, p: h.p };
      }
      return;
    }
    case 'knob': {
      toFront(h.m);
      const t = performance.now();
      if (lastKnob.kn === h.kn && t - lastKnob.t < 300) h.m.setKnob(h.kn, h.kn.def);
      lastKnob = { kn: h.kn, t };
      mode = { k: 'knob', m: h.m, kn: h.kn, sy: my, sv: h.m.p[h.kn.id] };
      return;
    }
    case 'body': {
      if (e.shiftKey) {
        if (!selected.delete(h.m)) selected.add(h.m);
        return;
      }
      if (!selected.has(h.m)) { selected.clear(); selected.add(h.m); }
      toFront(h.m);
      const d = h.m.press(h.lx, h.ly);
      if (d) { mode = { k: 'drag', m: h.m, d }; return; }
      const group = [...selected].filter((s) => s !== h.m).map((s) => ({ m: s, ox: s.x - h.m.x, oy: s.y - h.m.y }));
      mode = { k: 'move', m: h.m, dx: h.lx, dy: h.ly, sx: mx, sy: my, spawned: false, moved: false, group };
      return;
    }
    case 'none':
      if (e.shiftKey) { mode = { k: 'box', x0: mx + camX, y0: my + camY }; return; }
      selected.clear();
      mode = { k: 'pan', sx: mx, sy: my, cx: camX, cy: camY };
  }
});

canvas.addEventListener('pointermove', (e) => {
  setPointer(e);
  const wx = mx + camX, wy = my + camY;
  switch (mode.k) {
    case 'pan':
      camX = mode.cx - (mx - mode.sx);
      camY = mode.cy - (my - mode.sy);
      break;
    case 'move':
      mode.m.x = wx - mode.dx;
      mode.m.y = wy - mode.dy;
      for (const o of mode.group) { o.m.x = mode.m.x + o.ox; o.m.y = mode.m.y + o.oy; }
      mode.moved ||= Math.abs(mx - mode.sx) + Math.abs(my - mode.sy) > 3;
      eng.dirty = true;
      break;
    case 'knob': {
      const k = mode.kn;
      const fine = e.shiftKey ? 0.2 : 1;
      mode.m.setKnob(k, mode.sv + ((mode.sy - my) * (k.max - k.min) * fine) / 60);
      break;
    }
    case 'drag':
      mode.d.move(wx - mode.m.x, wy - mode.m.y);
      break;
  }
});

function endPointer() {
  if (mode.k === 'cable') {
    const t = dropTarget(mode, mx + camX, my + camY);
    if (t) {
      if (mode.p.dir === 'out') eng.connect(mode.m, mode.p.id, t.m, t.p.id);
      else eng.connect(t.m, t.p.id, mode.m, mode.p.id);
    }
  }
  if (mode.k === 'move' && mode.spawned && (!mode.moved || uy < barH)) placeInView(mode.m);
  if (mode.k === 'drag') mode.d.up?.();
  if (mode.k === 'box') {
    const [x0, x1] = [Math.min(mode.x0, mx + camX), Math.max(mode.x0, mx + camX)];
    const [y0, y1] = [Math.min(mode.y0, my + camY), Math.max(mode.y0, my + camY)];
    for (const m of eng.mods) if (m.x < x1 && m.x + m.w > x0 && m.y < y1 && m.y + m.h > y0) selected.add(m);
  }
  mode = { k: 'none' };
  checkpoint();
}

canvas.addEventListener('pointerup', (e) => { setPointer(e); endPointer(); });
canvas.addEventListener('pointercancel', endPointer);

let wheelAcc = 0, wheelTimer = 0;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  setPointer(e);
  const h = hitTest();
  if (h.k === 'bar' || h.k === 'menu') return;
  if (h.k === 'knob') {
    const k = h.kn;
    const step = k.step ?? (k.max - k.min) / 50;
    h.m.setKnob(k, h.m.p[k.id] - Math.sign(e.deltaY) * step);
    clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(checkpoint, 500);
    return;
  }
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) < 60) return;
  const next = Math.min(6, Math.max(1, scale - Math.sign(wheelAcc)));
  wheelAcc = 0;
  if (next === scale) return;
  // Keep the field point under the cursor fixed.
  const wx = mx + camX, wy = my + camY;
  scale = next;
  resize();
  updatePointer();
  camX = wx - mx;
  camY = wy - my;
}, { passive: false });

const keysMods = () => eng.mods.filter((m): m is Keys => m instanceof Keys);

addEventListener('keydown', (e) => {
  if (namePrompt) { promptKey(e); return; }
  const key = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    const act: Record<string, () => void> = {
      z: () => (e.shiftKey ? redo() : undo()),
      y: redo,
      c: () => { clipboard = copyData(); },
      v: () => { if (clipboard) pasteData(clipboard, true); },
      d: () => { const d = copyData(); if (d) pasteData(d, false); },
      a: () => { for (const m of eng.mods) selected.add(m); },
      s: askName,
    };
    if (act[key]) {
      e.preventDefault();
      act[key]();
      checkpoint();
    }
    return;
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
    let used = false;
    for (const k of keysMods()) used = k.key(e.code, true) || used;
    if (used) {
      void ac.resume();
      e.preventDefault();
      checkpoint();
      return;
    }
  }
  if (e.code === 'Space') {
    e.preventDefault();
    void ac.resume();
    togglePlay();
  }
  if (e.code === 'Escape') { openMenu = null; selected.clear(); selCable = null; }
  if (e.code === 'Delete' || e.code === 'Backspace') {
    const h = hitTest();
    if (selCable) eng.disconnect(selCable);
    else if (selected.size) for (const m of selected) eng.remove(m);
    else if (h.k === 'close' || h.k === 'port' || h.k === 'knob' || h.k === 'body') eng.remove(h.m);
    selCable = null;
    selected.clear();
    checkpoint();
  }
});

function promptKey(e: KeyboardEvent) {
  const p = namePrompt!;
  e.preventDefault();
  if (e.key === 'Escape') namePrompt = null;
  else if (e.key === 'Enter') {
    namePrompt = null;
    if (p.text.trim()) p.done(p.text.trim());
  } else if (e.key === 'Backspace') p.text = p.text.slice(0, -1);
  else if (e.key.length === 1 && /[a-z0-9 #!?.,:+\-_]/i.test(e.key) && p.text.length < 18) p.text += e.key.toUpperCase();
}

// ---------------------------------------------------------------- copy & paste

// The selected modules (or the one under the mouse) plus the cables between them.
function copyData(): PatchData | null {
  const h = hitTest();
  const mods = selected.size ? [...selected] : h.k === 'body' || h.k === 'knob' || h.k === 'port' ? [h.m] : [];
  if (!mods.length) return null;
  const ids = new Set(mods.map((m) => m.id));
  const all = serialize();
  return {
    mods: all.mods.filter((m) => ids.has(m.id)),
    cables: all.cables.filter((c) => ids.has(c.a) && ids.has(c.b)),
  };
}

// Paste at the mouse, or next to the originals (for duplicate).
function pasteData(data: PatchData, atMouse: boolean) {
  const x0 = Math.min(...data.mods.map((m) => m.x)), y0 = Math.min(...data.mods.map((m) => m.y));
  const dx = atMouse ? mx + camX - x0 : 16, dy = atMouse ? my + camY - y0 : 16;
  const added = addPatch(JSON.parse(JSON.stringify(data)), dx, dy);
  selected.clear();
  for (const m of added) selected.add(m);
}

addEventListener('keyup', (e) => {
  for (const k of keysMods()) k.key(e.code, false);
});

// Don't leave notes hanging when the window loses focus mid-press.
addEventListener('blur', () => {
  for (const k of keysMods()) k.allOff();
});

addEventListener('resize', resize);

// ---------------------------------------------------------------- patches

function serialize(): PatchData {
  return {
    mods: eng.mods.map((m) => ({ id: m.id, type: m.type, x: m.x, y: m.y, p: m.p, s: m.save() })),
    cables: eng.cables.map((c) => ({ a: c.a.id, ap: c.ap, b: c.b.id, bp: c.bp })),
  };
}

function loadPatch(data: PatchData) {
  eng.clear();
  selected.clear();
  selCable = null;
  addPatch(data, 0, 0);
}

// Adds a patch's modules and cables to the field, shifted by dx/dy.
function addPatch(data: PatchData, dx: number, dy: number) {
  const byId = new Map<number, Mod>();
  for (const d of data.mods) {
    const kind = KINDS.find((k) => k.type === d.type);
    if (!kind) continue;
    const m = kind.make(eng);
    m.x = d.x + dx;
    m.y = d.y + dy;
    for (const [k, v] of Object.entries(d.p ?? {})) if (k in m.p && typeof v === 'number') m.set(k, v);
    if (d.s !== undefined) m.load(d.s);
    eng.add(m);
    byId.set(d.id, m);
  }
  for (const c of data.cables) {
    const a = byId.get(c.a), b = byId.get(c.b);
    if (a && b) eng.connect(a, c.ap, b, c.bp);
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------- library & files

const LIB_KEY = 'pixel-modular.library.v1';
interface LibEntry { name: string; data: PatchData }

function readLibrary(): LibEntry[] {
  try { return JSON.parse(localStorage.getItem(LIB_KEY) ?? '[]'); } catch { return []; }
}

let library = readLibrary();

function writeLibrary(next: LibEntry[]) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(next));
    library = next;
    return true;
  } catch {
    showToast('COULD NOT SAVE - STORAGE FULL OR BLOCKED');
    return false;
  }
}

function askName() {
  namePrompt = {
    text: '',
    done: (name) => {
      if (writeLibrary([{ name, data: serialize() }, ...library.filter((e) => e.name !== name)])) {
        showToast(`SAVED AS ${name} - RIGHT CLICK IT IN PATCHES TO DELETE`);
      }
    },
  };
}

function patchesMenu(): MenuItem[] {
  const item = (label: string, act: () => void, col: string = C.yellow): MenuItem => ({ label, col, text: C.ink, act });
  const header = (label: string): MenuItem => ({ label, col: C.ink, text: C.slate, header: true });
  const load = (data: PatchData) => () => { loadPatch(data); fitView(); };
  return [
    header('EXAMPLES'),
    ...PATCHES.map((p) => item(p.name, () => load(p.build())())),
    ...(library.length ? [header('MY PATCHES')] : []),
    ...library.map((e) => ({
      ...item(e.name, load(e.data), C.lime),
      del: () => {
        writeLibrary(library.filter((x) => x !== e));
        showToast(`DELETED ${e.name}`);
      },
    })),
    header('FILE'),
    item('SAVE AS... (CTRL+S)', askName, C.silver),
    item('EXPORT .JSON', () => download(new Blob([JSON.stringify(serialize())], { type: 'application/json' }), `patch-${stamp()}.json`), C.silver),
    item('IMPORT .JSON', () => fileInput.click(), C.silver),
  ];
}

const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text()) as PatchData;
    if (!Array.isArray(data.mods) || !Array.isArray(data.cables)) throw new Error('not a patch');
    loadPatch(data);
    fitView();
    checkpoint();
    showToast(`LOADED ${file.name.toUpperCase()}`);
  } catch {
    showToast('THAT FILE IS NOT A PATCH');
  }
});

function cycleWires() {
  wires = (wires + 1) % 3;
  showToast(['WIRES SHOWN', 'WIRES DIMMED', 'WIRES HIDDEN'][wires]);
}

// Zoom out (down to 2x) until the whole patch fits below the toolbar, then centre it.
function fitView() {
  if (!eng.mods.length) { camX = 0; camY = -barWorld(); return; }
  const x0 = Math.min(...eng.mods.map((m) => m.x)), x1 = Math.max(...eng.mods.map((m) => m.x + m.w));
  const y0 = Math.min(...eng.mods.map((m) => m.y)), y1 = Math.max(...eng.mods.map((m) => m.y + m.h));
  for (scale = uiScale; scale > 2; scale--) {
    resize();
    if (x1 - x0 + 12 <= W && y1 - y0 + 20 <= H - barWorld()) break;
  }
  resize();
  const top = barWorld();
  camX = Math.min(Math.floor((x0 + x1 - W) / 2), x0 - 6);
  camY = Math.min(Math.floor((y0 + y1 - H - top) / 2), y0 - top - 6);
}

// ---------------------------------------------------------------- undo

// Snapshots of the patch with modules in id order, so merely raising a module isn't a step.
let undoStack: string[] = [];
let redoStack: string[] = [];
let current = '';

function snap() {
  const d = serialize();
  d.mods.sort((a, b) => a.id - b.id);
  return JSON.stringify(d);
}

function checkpoint() {
  const s = snap();
  if (s === current) return;
  if (current) undoStack.push(current);
  if (undoStack.length > 100) undoStack.shift();
  current = s;
  redoStack = [];
}

function restoreSnap(s: string) {
  loadPatch(JSON.parse(s));
  current = snap();
}

function undo() {
  checkpoint();
  const prev = undoStack.pop();
  if (!prev) { showToast('NOTHING TO UNDO'); return; }
  redoStack.push(current);
  restoreSnap(prev);
}

function redo() {
  const next = redoStack.pop();
  if (!next) { showToast('NOTHING TO REDO'); return; }
  undoStack.push(current);
  restoreSnap(next);
}

async function share() {
  const url = `${location.origin}${location.pathname}#p=${await encodePatch(serialize())}`;
  history.replaceState(null, '', url);
  try {
    await navigator.clipboard.writeText(url);
    showToast('LINK COPIED TO CLIPBOARD');
  } catch {
    showToast('LINK IS IN THE ADDRESS BAR');
  }
}

async function loadFromHash() {
  const code = hashCode();
  if (!code) return false;
  try {
    loadPatch(await decodePatch(code));
    fitView();
    showToast('PATCH LOADED FROM LINK');
    return true;
  } catch {
    showToast('THAT PATCH LINK IS BROKEN');
    return false;
  }
}

async function restore() {
  await restoreInitial();
  checkpoint();
}

async function restoreInitial() {
  if (await loadFromHash()) return;
  // ?patch=N opens one of the built-in patches.
  const n = Number(new URLSearchParams(location.search).get('patch'));
  if (n >= 1 && n <= PATCHES.length) loadPatch(PATCHES[n - 1].build());
  else {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      loadPatch(raw ? JSON.parse(raw) : PATCHES[0].build());
    } catch {
      loadPatch(PATCHES[0].build());
    }
  }
  fitView();
}

addEventListener('hashchange', () => void loadFromHash().then(checkpoint));

setInterval(() => {
  if (!eng.dirty) return;
  eng.dirty = false;
  // Once the patch is edited, a share link in the address bar is out of date.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(serialize())); } catch { /* storage unavailable */ }
}, 1000);

// ---------------------------------------------------------------- render loop

function drawField() {
  g.rect(0, 0, W, H, C.ink);
  const ox = ((-camX % 8) + 8) % 8, oy = ((-camY % 8) + 8) % 8;
  for (let y = oy; y < H; y += 8) for (let x = ox; x < W; x += 8) g.px(x, y, C.dark);
}

function drawTooltip(x: number, y: number, s: string) {
  const w = textWidth(s) + 4;
  x = Math.round(x - w / 2);
  g.rect(x - 1, y - 1, w + 2, 9, C.black);
  g.rect(x, y, w, 7, C.white);
  g.text(s, x + 2, y + 1, C.ink);
}

const PORT_KIND = { audio: 'AUDIO', note: 'NOTES', trig: 'TRIGGER', cv: 'CV' };

const TIPS = [
  'DRAG JACK TO JACK TO PATCH - RIGHT CLICK A JACK OR CABLE TO UNPLUG - WHEEL TO ZOOM',
  'CLICK A CABLE AND PRESS DEL TO REMOVE IT - WIRES BUTTON DIMS OR HIDES CABLES',
  'SHIFT+CLICK OR SHIFT+DRAG TO SELECT SEVERAL MODULES - DRAG ONE TO MOVE THEM ALL',
  'CTRL+D DUPLICATE - CTRL+C / CTRL+V COPY AND PASTE - CTRL+Z UNDO - CTRL+S SAVE',
];

function drawPrompt(text: string, blink: boolean) {
  const w = 120, h = 34, x = Math.floor((UW - w) / 2), y = Math.floor((UH - h) / 2);
  ui.rect(x + 2, y + 2, w, h, C.black);
  ui.rect(x, y, w, h, C.black);
  ui.rect(x + 1, y + 1, w - 2, h - 2, C.dark);
  ui.text('SAVE PATCH AS:', x + 5, y + 5, C.white);
  ui.rect(x + 4, y + 12, w - 8, 9, C.black);
  ui.text(text + (blink ? '_' : ''), x + 6, y + 14, C.yellow);
  ui.text('ENTER SAVE - ESC CANCEL', x + 5, y + 25, C.slate);
}

function frame() {
  eng.flush();
  layoutBar();
  const h = mode.k === 'none' ? hitTest() : { k: 'none' as const };
  // Like a menu bar: with one menu open, hovering another group opens that one.
  if (openMenu && h.k === 'bar' && h.b.menu) openMenu = h.b.label;
  const t = performance.now();
  const blink = Math.floor(t / 250) % 2 === 0;

  drawField();

  for (const m of eng.mods) {
    g.ox = m.x - camX;
    g.oy = m.y - camY;
    drawModule(g, m, h.k === 'close' && h.m === m);
    if (selected.has(m)) g.frame(-2, -2, m.w + 4, m.h + 4, C.yellow);
  }
  g.ox = -camX;
  g.oy = -camY;

  for (const c of eng.cables) {
    const [x0, y0, x1, y1] = cableEnds(c);
    const col = TYPEC[c.type];
    const lit = t - c.lit < 70 || (h.k === 'cable' && h.c === c);
    if (c === selCable) drawCable(g, x0, y0, x1, y1, blink ? C.white : col, false);
    else if (wires === 2) { plug(g, x0, y0, col); plug(g, x1, y1, col); }
    else {
      g.ctx.globalAlpha = wires === 1 ? 0.25 : 1;
      drawCable(g, x0, y0, x1, y1, col, lit);
      g.ctx.globalAlpha = 1;
    }
  }

  if (mode.k === 'box') {
    const x = Math.min(mode.x0, mx + camX), y = Math.min(mode.y0, my + camY);
    const w = Math.abs(mx + camX - mode.x0) + 1, hh = Math.abs(my + camY - mode.y0) + 1;
    if (w > 1 && hh > 1) g.frame(x, y, w, hh, C.yellow);
  }

  if (mode.k === 'cable') {
    const from = mode;
    // Blink every jack that would accept this cable.
    if (blink) {
      for (const m of eng.mods) for (const p of m.ports) {
        if (canPlug(from.p, p)) g.frame(m.x + p.x - 1, m.y + p.y - 1, 11, 11, C.white);
      }
    }
    const [x0, y0] = jackPos(from.m, from.p);
    const tgt = dropTarget(from, mx + camX, my + camY);
    const [x1, y1] = tgt ? jackPos(tgt.m, tgt.p) : [mx + camX, my + camY];
    drawCable(g, x0, y0, x1, y1, TYPEC[from.p.type], false);
  }

  // Tooltips: knob values and port kinds.
  const tip = mode.k === 'knob' ? { m: mode.m, kn: mode.kn } : h.k === 'knob' ? h : null;
  if (tip) drawTooltip(tip.m.x + tip.kn.x + 5, tip.m.y + tip.kn.y - 10, tip.m.knobText(tip.kn));
  else if (h.k === 'port') {
    drawTooltip(h.m.x + h.p.x + 4, h.m.y + h.p.y - 10, `${PORT_KIND[h.p.type]} ${h.p.dir === 'in' ? 'IN' : 'OUT'}`);
  }
  g.ox = 0;
  g.oy = 0;

  ui.ctx.clearRect(0, 0, UW, UH);
  drawBar();
  if (t < toast.until) {
    const w = textWidth(toast.text) + 10, x = Math.floor((UW - w) / 2);
    ui.rect(x - 1, barH + 5, w + 2, 11, C.black);
    ui.rect(x, barH + 6, w, 9, C.yellow);
    ui.text(toast.text, x + 5, barH + 8, C.ink);
  }
  if (!everPlayed && blink && !openMenu) ui.textC('PRESS SPACE TO PLAY', Math.floor(UW / 2), UH - 16, C.yellow);
  ui.text(TIPS[Math.floor(t / 7000) % TIPS.length], 3, UH - 7, C.slate);
  if (namePrompt) drawPrompt(namePrompt.text, blink);

  canvas.style.cursor =
    mode.k === 'move' || mode.k === 'pan' ? 'grabbing'
    : mode.k === 'knob' || h.k === 'knob' ? 'ns-resize'
    : mode.k === 'cable' || h.k === 'port' ? 'crosshair'
    : h.k === 'bar' || h.k === 'close' || h.k === 'menu' || h.k === 'cable' ? 'pointer'
    : h.k === 'body' ? 'grab'
    : 'default';

  requestAnimationFrame(frame);
}

resize();
layoutBar();
requestAnimationFrame(frame);
void restore();
