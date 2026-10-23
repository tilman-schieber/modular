import { ac } from './audio';
import { Engine, type Cable } from './engine';
import { C, Gfx, textWidth } from './gfx';
import { CAT, TYPEC, compatible, type Cat, type Drag, type Knob, type Mod, type Port } from './mod';
import { LABEL_H } from './render';
import { KINDS, Submodule, buildLevel, freshKeys, levelData, subHooks, type Kind } from './modules';
import { PATCHES, migrate, type PatchData } from './patches';
import { cablePoints, drawButton, drawCable, drawFlow, drawModule, plug } from './render';
import { BAR_HELP, CABLE_HELP, HELP, MODULE_HOW, jackHelp, knobHelp } from './help';
import { midi } from './midi';
import { download, stamp } from './rec';
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

// Help mode's pointer: a pixel arrow with a yellow question mark, its hotspot on the
// arrow's tip (system "help" cursors often point from their middle).
const HELP_CURSOR = (() => {
  const arrow = [
    'K.......', 'KK......', 'KWK.....', 'KWWK....', 'KWWWK...', 'KWWWWK..', 'KWWWWWK.',
    'KWWWWWWK', 'KWWWKKKK', 'KWKWK...', 'KK.KWK..', '....KWK.', '.....KK.',
  ];
  const mark = ['##.', '..#', '.#.', '...', '.#.'], mx0 = 9, my0 = 6;
  const W = 13, H = 13, px: string[][] = Array.from({ length: H }, (_, y) => [...(arrow[y] ?? '').padEnd(W, '.')]);
  const isMark = (x: number, y: number) => mark[y - my0]?.[x - mx0] === '#';
  // The mark gets a black outline so it reads on any background.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (isMark(x, y)) px[y][x] = 'Y';
    else if (px[y][x] === '.' && [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => isMark(x + dx, y + dy)))) px[y][x] = 'K';
  }
  const col: Record<string, string> = { K: C.black, W: C.white, Y: C.yellow };
  const rects = px.flatMap((r, y) => r.map((c, x) => col[c]
    ? `<rect x="${x * 2}" y="${y * 2}" width="2" height="2" fill="${col[c]}"/>` : ''));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" shape-rendering="crispEdges">${rects.join('')}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 0 0, help`;
})();
let clipboard: PatchData | null = null;
// The SUBMODULE being edited (null: the top level). Only its modules and cables are
// drawn and can be touched; everything keeps playing, inside or not.
let view: Submodule | null = null;
const shown = () => eng.mods.filter((m) => m.parent === view);
const shownCables = () => eng.cables.filter((c) => c.a.parent === view);
// Each level remembers where its camera was.
const cams = new Map<string, { x: number; y: number; s: number }>();
const camKey = (v: Submodule | null) => v?.subKey ?? '';
// A one-line text prompt: saving a patch, or a module's label (where empty is allowed).
let namePrompt: { text: string; title: string; ok: string; empty?: boolean; done: (name: string) => void } | null = null;
// LABEL tool: clicking a module names it (or edits or removes its name).
let labelMode = false;
// The knob waiting for a MIDI control to be moved (Alt+click a knob to map it).
let learn: { m: Mod; kn: Knob } | null = null;
// Help mode (the HELP button or ?): hovering anything explains it.
let helpMode = false;

function toggleHelp() {
  helpMode = !helpMode;
  if (helpMode) showToast('HELP MODE - HOVER ANYTHING - ?, ESC OR RIGHT-CLICK TO LEAVE');
}

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
  shift?: () => void; // shift+click action
  spawn?: string;
  header?: boolean; // a non-clickable section title
  del?: () => void; // right-click action
}
interface Btn {
  label: string; x: number; y: number; w: number;
  col: string; text: string; hi: string;
  act?: () => void;
  menu?: MenuItem[];
  br?: boolean; // starts a new row
}
let bar: Btn[] = [];
let barH = 13;
let openMenu: string | null = null;
// The module picker that opens when a fresh cable is dropped on empty ground.
let popup: { x: number; y: number; from: { m: Mod; p: Port }; wx: number; wy: number; items: MenuItem[] } | null = null;
// Bar height in field pixels, for keeping modules out from under it.
const barWorld = () => Math.ceil((barH * uiScale) / scale);

function togglePlay() {
  if (eng.running) eng.stop();
  else { eng.start(); everPlayed = true; }
}

function layoutBar() {
  const cats = Object.keys(CAT) as Cat[];
  const items: Omit<Btn, 'x' | 'y' | 'w'>[] = [
    eng.running
      ? { label: '  STOP', col: C.red, text: C.ink, hi: C.white, act: togglePlay }
      : { label: '  PLAY', col: C.green, text: C.ink, hi: C.white, act: togglePlay },
    { label: 'PATCHES', col: C.silver, text: C.ink, hi: C.white, menu: patchesMenu() },
    ...cats.map((cat) => ({
      label: CAT[cat].name, col: CAT[cat].bar, text: C.white, hi: CAT[cat].cap,
      menu: cat === 'sub' ? subMenu() : KINDS.filter((k) => k.cat === cat).map((k) => ({ label: k.label, col: CAT[cat].bar, text: C.white, spawn: k.type })),
    })),
    // Lit while the LABEL tool is on, so it is clear why clicks name modules.
    { label: 'EDIT', col: labelMode ? C.yellow : C.silver, text: C.ink, hi: C.white, menu: editMenu() },
    { label: '?', col: helpMode ? C.yellow : C.silver, text: C.ink, hi: C.white, act: toggleHelp },
    ...crumbs(),
  ];
  bar = [];
  let x = 2, y = 2;
  for (const it of items) {
    const w = textWidth(it.label) + (it.menu ? 14 : 8);
    if ((x + w > UW - 2 || it.br) && x > 2) { x = 2; y += 11; }
    bar.push({ ...it, x, y, w });
    x += w + 2;
    // Small gaps separate transport, patches, modules and the rest.
    if (it.act === togglePlay || it.label === 'PATCHES' || it.label === CAT[cats[cats.length - 1]].name) x += 6;
  }
  barH = y + 12;
}

// Inside a SUBMODULE, a second row: BACK, then the way down from the top (click one to go there).
function crumbs(): Omit<Btn, 'x' | 'y' | 'w'>[] {
  if (!view) return [];
  const chain: (Submodule | null)[] = [null];
  for (let v: Submodule | null = view; v; v = v.parent instanceof Submodule ? v.parent : null) chain.splice(1, 0, v);
  return [
    { label: 'BACK', col: C.sky, text: C.ink, hi: C.white, act: () => enter(view!.parent instanceof Submodule ? view!.parent : null), br: true },
    ...chain.map((v) => ({
      label: v ? v.label || 'SUBMODULE' : 'PATCH', col: v === view ? C.yellow : C.slate, text: v === view ? C.ink : C.white, hi: C.white,
      act: () => enter(v),
    })),
  ];
}

// A new SUBMODULE anywhere; inside one, also the IN, OUT and KNOB that make its panel.
// NEW, saving what is being edited as a submodule of your own, and inside a SUBMODULE
// the IN, OUT and KNOB that make its panel. Under a line: your saved submodules (click
// adds one, right-click deletes it).
function subMenu(): MenuItem[] {
  const item = (type: string, label: string): MenuItem => ({ label, col: CAT.sub.bar, text: C.white, spawn: type });
  return [
    item('sub', 'NEW SUBMODULE'),
    { label: view ? 'SAVE THIS SUBMODULE...' : 'SAVE PATCH AS SUBMODULE...', col: CAT.sub.bar, text: C.white, act: askSubName },
    ...(view ? [
      { label: 'FOR THIS SUBMODULE', col: C.ink, text: C.slate, header: true },
      item('subin', 'IN - A JACK INTO IT'),
      item('subout', 'OUT - A JACK OUT OF IT'),
      item('subknob', 'KNOB - A KNOB ON IT'),
    ] : []),
    ...(subLib.length ? [{ label: '', col: C.ink, text: C.slate, header: true }] : []),
    ...subLib.map((e): MenuItem => ({
      label: e.name, col: C.sky, text: C.ink,
      act: () => addAsSub(e.data, e.name),
      del: () => {
        writeSubs(subLib.filter((x) => x !== e));
        showToast(`DELETED SUBMODULE ${e.name}`);
      },
    })),
  ];
}

// Go into a SUBMODULE (or up to the top level, null), keeping each level's camera.
function enter(v: Submodule | null) {
  if (v === view) return;
  cams.set(camKey(view), { x: camX, y: camY, s: scale });
  view = v;
  selected.clear();
  selCable = null;
  openMenu = null;
  const cam = cams.get(camKey(v));
  if (cam) { scale = cam.s; resize(); camX = cam.x; camY = cam.y; }
  else fitView();
}
subHooks.open = (m) => enter(m);

const MENU_ROW = 10;
const openBtn = () => bar.find((b) => b.label === openMenu && b.menu);

// The open dropdown: a toolbar menu, or the module picker.
function activeMenu() {
  if (popup) {
    const items = popup.items, w = Math.max(...items.map((m) => textWidth(m.label) + 12)), h = items.length * MENU_ROW + 2;
    return { x: Math.max(0, Math.min(popup.x, UW - w - 2)), y: Math.max(barH, Math.min(popup.y, UH - h - 2)), w, h, items };
  }
  const b = openBtn();
  if (!b) return null;
  const w = Math.max(b.w, ...b.menu!.map((m) => textWidth(m.label) + 12));
  return { x: b.x, y: b.y + 10, w, h: b.menu!.length * MENU_ROW + 2, items: b.menu! };
}

function menuItemAt(x: number, y: number) {
  const r = activeMenu();
  if (!r) return null;
  if (x < r.x || x >= r.x + r.w || y < r.y + 1 || y >= r.y + r.h - 1) return null;
  return r.items[Math.floor((y - r.y - 1) / MENU_ROW)] ?? null;
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
    if (b.act === togglePlay) {
      if (eng.running) ui.rect(b.x + 4, b.y + 2, 5, 5, C.ink);
      else for (let i = 0; i < 3; i++) ui.rect(b.x + 4 + i, b.y + 2 + i, 1, 5 - i * 2, C.ink);
    }
  }
  const r = activeMenu();
  if (r) {
    const hi = menuItemAt(ux, uy);
    ui.rect(r.x + 2, r.y + 2, r.w, r.h, C.black);
    ui.rect(r.x, r.y, r.w, r.h, C.black);
    ui.rect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, C.dark);
    r.items.forEach((m, i) => {
      const y = r.y + 1 + i * MENU_ROW;
      if (m.header) {
        ui.rect(r.x + 1, y, r.w - 2, MENU_ROW, C.ink);
        // A header without a title is a dividing line.
        if (m.label) ui.text(m.label, r.x + 4, y + 3, C.slate);
        else ui.rect(r.x + 4, y + Math.floor(MENU_ROW / 2), r.w - 8, 1, C.slate);
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
  | { k: 'adv'; m: Mod }
  | { k: 'port'; m: Mod; p: Port }
  | { k: 'knob'; m: Mod; kn: Knob }
  | { k: 'cable'; c: Cable }
  | { k: 'body'; m: Mod; lx: number; ly: number }
  | { k: 'none' };

// A module covers its panel and, when labelled, the label bar above it.
function modAt(wx: number, wy: number) {
  const mods = shown();
  for (let i = mods.length - 1; i >= 0; i--) {
    const m = mods[i];
    if (wx >= m.x && wx < m.x + m.w && wy >= m.y - (m.label ? LABEL_H : 0) && wy < m.y + m.h) return m;
  }
  return undefined;
}

// A jack catches the pointer over itself and its label, a little wider than drawn;
// where two zones meet, the nearer jack wins.
function portAt(m: Mod, lx: number, ly: number) {
  let best: Port | null = null, bd = Infinity;
  for (const p of m.ports) {
    const dx = Math.abs(lx - (p.x + 4)), dy = Math.abs(ly - (p.y + 4));
    if (dx > 7 || ly < p.y - 3 || ly > p.y + (p.label ? 16 : 11)) continue;
    const d = Math.max(dx, dy);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
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
    if (m.advName && lx >= m.w - 18 && lx < m.w - 9 && ly >= 1 && ly < 9) return { k: 'adv', m };
    const p = portAt(m, lx, ly);
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

// One analyser per audio or CV output with a cable on it, so cables can show their signal.
interface Meter { node: AudioNode; an: AnalyserNode; buf: Float32Array<ArrayBuffer>; lvl: number; frame: number }
const meters = new Map<string, Meter>();
let meterFrame = 0;

// Audio: its peak level. CV: how far from 0 it is (1 = full glow).
function signalLevel(c: Cable) {
  const key = c.a.id + ':' + c.ap;
  let m = meters.get(key);
  if (!m) {
    const node = c.a.output(c.ap);
    if (!node) return 0;
    const an = ac.createAnalyser();
    an.fftSize = 256;
    node.connect(an);
    m = { node, an, buf: new Float32Array(256), lvl: 0, frame: -1 };
    meters.set(key, m);
  }
  if (m.frame !== meterFrame) {
    m.frame = meterFrame;
    m.an.getFloatTimeDomainData(m.buf);
    let peak = 0, sum = 0;
    for (const v of m.buf) { peak = Math.max(peak, Math.abs(v)); sum += v; }
    m.lvl = c.type === 'audio' ? Math.sqrt(peak) : Math.min(1, Math.abs(sum / m.buf.length));
  }
  return m.lvl;
}

// Drop the analysers of outputs that no longer have a cable.
function pruneMeters() {
  const used = new Set(eng.cables.map((c) => c.a.id + ':' + c.ap));
  for (const [key, m] of meters) {
    if (used.has(key)) continue;
    try { m.node.disconnect(m.an); } catch { /* already gone */ }
    meters.delete(key);
  }
}

function cableAt(wx: number, wy: number, r: number) {
  const cables = shownCables();
  for (let i = cables.length - 1; i >= 0; i--) {
    const c = cables[i];
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
  for (const m of shown()) {
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
  | { k: 'cable'; m: Mod; p: Port; picked: boolean } // picked: lifted off a jack rather than started fresh
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
  m.parent = view;
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
  // In help mode a right-click just leaves it.
  if (helpMode && e.button === 2) { helpMode = false; return; }
  const h = hitTest();
  if (labelMode && h.k !== 'bar' && h.k !== 'menu') {
    if (e.button === 2) { labelMode = false; return; }
    if ('m' in h && h.m) { editLabel(h.m); return; }
  }

  if (h.k === 'menu' && (h.item.header || (e.button === 2 && h.item.del))) {
    if (e.button === 2) h.item.del!();
    return;
  }
  if (openMenu || popup || (h.k === 'bar' && h.b.menu)) {
    const was = openMenu;
    openMenu = null;
    popup = null;
    if (h.k === 'menu') {
      if (h.item.spawn) spawn(h.item.spawn);
      else if (e.shiftKey && h.item.shift) h.item.shift();
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
    case 'adv':
      h.m.set('adv', h.m.isAdv ? 0 : 1);
      return;
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
        mode = { k: 'cable', m: c.a, p: c.a.ports.find((p) => p.id === c.ap)!, picked: true };
      } else {
        mode = { k: 'cable', m: h.m, p: h.p, picked: false };
      }
      return;
    }
    case 'knob': {
      if (e.altKey) { midiLearn(h.m, h.kn); return; }
      toFront(h.m);
      const t = performance.now();
      if (lastKnob.kn === h.kn && t - lastKnob.t < 300) h.m.setKnob(h.kn, h.kn.def);
      lastKnob = { kn: h.kn, t };
      mode = { k: 'knob', m: h.m, kn: h.kn, sy: my, sv: h.m.p[h.kn.id] };
      return;
    }
    case 'body': {
      // The label bar (above the panel) only moves and selects the module.
      const panel = h.ly >= 0;
      if (e.shiftKey) {
        if (panel && h.m.pressShift(h.lx, h.ly)) return;
        if (!selected.delete(h.m)) selected.add(h.m);
        return;
      }
      if (panel && e.altKey && h.m.pressAlt(h.lx, h.ly)) return;
      if (!selected.has(h.m)) { selected.clear(); selected.add(h.m); }
      toFront(h.m);
      const d = panel ? h.m.press(h.lx, h.ly) : null;
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
    const wx = mx + camX, wy = my + camY;
    const t = dropTarget(mode, wx, wy);
    if (t) {
      if (mode.p.dir === 'out') eng.connect(mode.m, mode.p.id, t.m, t.p.id);
      else eng.connect(t.m, t.p.id, mode.m, mode.p.id);
    } else if (!mode.picked && !modAt(wx, wy) && uy >= barH) {
      openPicker({ m: mode.m, p: mode.p }, wx, wy);
    }
  }
  if (mode.k === 'move' && mode.spawned && (!mode.moved || uy < barH)) placeInView(mode.m);
  if (mode.k === 'drag') mode.d.up?.();
  if (mode.k === 'box') {
    const [x0, x1] = [Math.min(mode.x0, mx + camX), Math.max(mode.x0, mx + camX)];
    const [y0, y1] = [Math.min(mode.y0, my + camY), Math.max(mode.y0, my + camY)];
    for (const m of shown()) if (m.x < x1 && m.x + m.w > x0 && m.y < y1 && m.y + m.h > y0) selected.add(m);
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
      a: () => { for (const m of shown()) selected.add(m); },
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
    for (const m of eng.mods) used = m.key(e.code, true) || used;
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
  if (e.key === '?' || e.code === 'F1') { e.preventDefault(); toggleHelp(); return; }
  // F3 shows, dims or hides the cables.
  if (e.code === 'F3') { e.preventDefault(); cycleWires(); return; }
  // F2, the usual rename key: label the module under the pointer, or toggle the LABEL tool.
  if (e.code === 'F2') {
    e.preventDefault();
    const h = hitTest();
    if ('m' in h && h.m) editLabel(h.m);
    else toggleLabel();
    return;
  }
  if (e.code === 'Escape') {
    // With nothing else to cancel, Esc leaves the SUBMODULE.
    const busy = openMenu || popup || learn || helpMode || labelMode || selected.size || selCable;
    openMenu = null; popup = null; learn = null; helpMode = false; labelMode = false; selected.clear(); selCable = null;
    if (!busy && view) enter(view.parent instanceof Submodule ? view.parent : null);
  }
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
    if (p.text.trim() || p.empty) p.done(p.text.trim());
  } else if (e.key === 'Backspace') p.text = p.text.slice(0, -1);
  else if (e.key.length === 1 && /[a-z0-9 #!?.,:+\-_]/i.test(e.key) && p.text.length < 18) p.text += e.key.toUpperCase();
}

// ---------------------------------------------------------------- MIDI learn

// Alt+click a knob, then move a knob or fader on a MIDI controller. Alt+click a mapped
// knob to unmap it. One controller may drive several knobs.
function midiLearn(m: Mod, kn: Knob) {
  if (m.cc[kn.id] !== undefined) {
    delete m.cc[kn.id];
    learn = null;
    showToast('MIDI MAPPING REMOVED');
    checkpoint();
    return;
  }
  learn = { m, kn };
  void midi.enable().then((ok) => {
    if (!ok) { learn = null; showToast('NO MIDI - CHECK BROWSER PERMISSION'); return; }
    showToast('MOVE A MIDI CONTROL - ESC CANCELS');
  });
}

let ccTimer = 0;
midi.on((d) => {
  if ((d[0] & 0xf0) !== 0xb0) return;
  const cc = d[1], v = d[2] / 127;
  if (learn && eng.mods.includes(learn.m)) {
    learn.m.cc[learn.kn.id] = cc;
    showToast(`${learn.m.title} ${learn.kn.label || 'KNOB'} ON CC ${cc}`);
    learn = null;
  }
  for (const m of eng.mods) {
    for (const k of m.knobs) if (m.cc[k.id] === cc) m.setKnob(k, k.min + v * (k.max - k.min));
  }
  // A twist of a controller is one undo step.
  clearTimeout(ccTimer);
  ccTimer = window.setTimeout(checkpoint, 500);
});

// ---------------------------------------------------------------- module picker

// Each kind's jacks, read once from a throwaway instance.
const kindPorts = new Map<string, Port[]>();
function portsOf(kind: Kind) {
  let ps = kindPorts.get(kind.type);
  if (!ps) {
    const m = kind.make(eng);
    ps = m.ports;
    m.destroy();
    kindPorts.set(kind.type, ps);
  }
  return ps;
}

// Every module with a jack the cable fits, preferring jacks of the same signal type
// (so an audio cable offers effects and mixers, not every CV input).
function openPicker(from: { m: Mod; p: Port }, wx: number, wy: number) {
  // IN, OUT and KNOB only make sense inside a SUBMODULE.
  const fits = KINDS.filter((k) => view || !k.type.startsWith('sub') || k.type === 'sub').flatMap((kind) => {
    const ok = portsOf(kind).filter((p) => canPlug(from.p, p));
    const p = ok.find((p) => p.type === from.p.type) ?? ok[0];
    return p ? [{ kind, p }] : [];
  });
  const exact = fits.filter((f) => f.p.type === from.p.type);
  const list = exact.length ? exact : fits;
  if (!list.length) return;
  const header: MenuItem = { label: from.p.dir === 'out' ? 'SEND TO...' : 'TAKE FROM...', col: C.ink, text: C.slate, header: true };
  popup = {
    x: ux, y: uy, from, wx, wy,
    items: [header, ...list.map(({ kind, p }) => ({
      label: kind.label, col: CAT[kind.cat].bar, text: C.white,
      act: () => spawnConnected(kind, p, from, wx, wy),
    }))],
  };
}

// Place the new module so the chosen jack sits where the cable was dropped.
function spawnConnected(kind: Kind, port: Port, from: { m: Mod; p: Port }, wx: number, wy: number) {
  const m = kind.make(eng);
  m.parent = view;
  m.x = Math.round(wx - port.x - 4);
  m.y = Math.round(wy - port.y - 4);
  eng.add(m);
  if (from.p.dir === 'out') eng.connect(from.m, from.p.id, m, port.id);
  else eng.connect(m, port.id, from.m, from.p.id);
  selected.clear();
  selected.add(m);
}

// ---------------------------------------------------------------- copy & paste

// The selected modules (or the one under the mouse) plus the cables between them.
function copyData(): PatchData | null {
  const h = hitTest();
  const mods = selected.size ? [...selected] : h.k === 'body' || h.k === 'knob' || h.k === 'port' ? [h.m] : [];
  if (!mods.length) return null;
  const ids = new Set(mods.map((m) => m.id));
  const all = levelData(eng, view);
  return {
    mods: all.mods.filter((m) => ids.has(m.id)),
    cables: all.cables.filter((c) => ids.has(c.a) && ids.has(c.b)),
  };
}

// Paste at the mouse, or next to the originals (for duplicate).
function pasteData(data: PatchData, atMouse: boolean) {
  const x0 = Math.min(...data.mods.map((m) => m.x)), y0 = Math.min(...data.mods.map((m) => m.y));
  const dx = atMouse ? mx + camX - x0 : 16, dy = atMouse ? my + camY - y0 : 16;
  const copy = JSON.parse(JSON.stringify(data)) as PatchData;
  freshKeys(copy);
  const added = addPatch(copy, dx, dy, view);
  selected.clear();
  for (const m of added) selected.add(m);
}

addEventListener('keyup', (e) => {
  for (const m of eng.mods) m.key(e.code, false);
});

// Don't leave notes hanging when the window loses focus mid-press.
addEventListener('blur', () => {
  for (const m of eng.mods) m.allOff();
});

addEventListener('resize', resize);

// ---------------------------------------------------------------- patches

// The whole patch: the top level, with every SUBMODULE's insides in its state.
function serialize(): PatchData { return levelData(eng, null); }

// Load a patch in place of the current one, at its top level.
function loadPatch(data: PatchData) {
  eng.clear();
  selected.clear();
  selCable = null;
  view = null;
  cams.clear();
  addPatch(data, 0, 0, null);
}

// Adds a patch's modules and cables to a level (the top, or a SUBMODULE), shifted by dx/dy.
function addPatch(old: PatchData, dx: number, dy: number, parent: Submodule | null) {
  const { data, dropped } = migrate(old);
  if (dropped) showToast('KEYS AND MELODY SHARED A VOICE - UNPLUGGED ONE, PATCH IT TO ITS OWN');
  return buildLevel(eng, data, parent, dx, dy);
}

// A whole patch as one SUBMODULE in the level being edited, named after it.
function addAsSub(data: PatchData, name: string) {
  const sub = new Submodule(eng);
  sub.parent = view;
  sub.label = name.slice(0, 18);
  placeInView(sub);
  eng.add(sub);
  const copy = JSON.parse(JSON.stringify(data)) as PatchData;
  freshKeys(copy);
  addPatch(copy, 0, 0, sub);
  selected.clear();
  selected.add(sub);
  checkpoint();
  showToast(`${sub.label} IS A SUBMODULE NOW - OPEN IT, ADD IN, OUT AND KNOB`);
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

// Your own submodules, for the SUBMODULE menu: saved like patches, in their own list.
const SUB_KEY = 'pixel-modular.submodules.v1';
let subLib: LibEntry[] = (() => {
  try { return JSON.parse(localStorage.getItem(SUB_KEY) ?? '[]') as LibEntry[]; } catch { return []; }
})();

function writeSubs(next: LibEntry[]) {
  try {
    localStorage.setItem(SUB_KEY, JSON.stringify(next));
    subLib = next;
    return true;
  } catch {
    showToast('COULD NOT SAVE - STORAGE FULL OR BLOCKED');
    return false;
  }
}

// Save what is being edited (the whole patch, or the SUBMODULE you are in) to the menu.
function askSubName() {
  namePrompt = {
    text: view?.label ?? '', title: 'SAVE AS SUBMODULE:', ok: 'ENTER SAVE - ESC CANCEL',
    done: (name) => {
      const data = levelData(eng, view);
      if (!data.mods.length) { showToast('NOTHING TO SAVE HERE YET'); return; }
      if (writeSubs([...subLib.filter((e) => e.name !== name), { name, data }])) {
        showToast(`${name} IS IN THE SUBMODULE MENU - RIGHT-CLICK IT THERE TO DELETE`);
      }
    },
  };
}

function askName() {
  namePrompt = {
    text: '', title: 'SAVE PATCH AS:', ok: 'ENTER SAVE - ESC CANCEL',
    done: (name) => {
      if (writeLibrary([{ name, data: serialize() }, ...library.filter((e) => e.name !== name)])) {
        showToast(`SAVED AS ${name} - RIGHT CLICK IT IN PATCHES TO DELETE`);
      }
    },
  };
}

// Editing tools that don't need a button of their own.
function editMenu(): MenuItem[] {
  const item = (label: string, act: () => void): MenuItem => ({ label, col: C.silver, text: C.ink, act });
  return [
    item('UNDO (CTRL+Z)', undo),
    item('REDO (CTRL+SHIFT+Z)', redo),
    item(labelMode ? 'LABEL: ON - CLICK MODULES' : 'LABEL MODULES (F2)', toggleLabel),
    item(`WIRES: ${['SHOWN', 'DIMMED', 'HIDDEN'][wires]} (F3)`, cycleWires),
  ];
}

function patchesMenu(): MenuItem[] {
  const item = (label: string, act: () => void, col: string = C.yellow): MenuItem => ({ label, col, text: C.ink, act });
  const header = (label: string): MenuItem => ({ label, col: C.ink, text: C.slate, header: true });
  const load = (data: PatchData) => () => { loadPatch(data); fitView(); };
  return [
    header('EXAMPLES'),
    ...PATCHES.map((p) => ({ ...item(p.name, () => load(p.build())()), shift: () => addAsSub(p.build(), p.name) })),
    ...(library.length ? [header('MY PATCHES')] : []),
    ...library.map((e) => ({
      ...item(e.name, load(e.data), C.lime),
      shift: () => addAsSub(e.data, e.name),
      del: () => {
        writeLibrary(library.filter((x) => x !== e));
        showToast(`DELETED ${e.name}`);
      },
    })),
    header('FILE'),
    item('SAVE AS... (CTRL+S)', askName, C.silver),
    item('SHARE LINK', () => void share(), C.silver),
    item('EXPORT .JSON', () => download(new Blob([JSON.stringify(serialize())], { type: 'application/json' }), `patch-${stamp()}.json`), C.silver),
    item('IMPORT .JSON', () => { importAsSub = false; fileInput.click(); }, C.silver),
    item('IMPORT AS SUBMODULE', () => { importAsSub = true; fileInput.click(); }, C.silver),
  ];
}

const fileInput = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
// IMPORT AS SUBMODULE: the file becomes one box instead of replacing the patch.
let importAsSub = false;
fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text()) as PatchData;
    if (!Array.isArray(data.mods) || !Array.isArray(data.cables)) throw new Error('not a patch');
    if (importAsSub) { addAsSub(data, file.name.replace(/\.json$/i, '').toUpperCase()); return; }
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
  const mods = shown();
  if (!mods.length) { camX = 0; camY = -barWorld(); return; }
  const x0 = Math.min(...mods.map((m) => m.x)), x1 = Math.max(...mods.map((m) => m.x + m.w));
  const y0 = Math.min(...mods.map((m) => m.y - (m.label ? LABEL_H : 0))), y1 = Math.max(...mods.map((m) => m.y + m.h));
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
let currentKey = '';

function snap() {
  const d = serialize();
  d.mods.sort((a, b) => a.id - b.id);
  return JSON.stringify(d);
}

// What counts as a change: state that modules change by themselves while playing
// (TURING's register) doesn't.
function changeKey(s: string) {
  const d = JSON.parse(s) as PatchData;
  return JSON.stringify(d.mods.map((m) => (m.type === 'turing' ? { ...m, s: null } : m)).concat(d.cables as never[]));
}

function checkpoint() {
  const s = snap(), key = changeKey(s);
  if (key === currentKey) { current = s; return; }
  if (current) undoStack.push(current);
  if (undoStack.length > 100) undoStack.shift();
  current = s;
  currentKey = key;
  redoStack = [];
}

function restoreSnap(s: string) {
  const key = view?.subKey, cam = { x: camX, y: camY };
  loadPatch(JSON.parse(s));
  const back = key ? eng.mods.find((m): m is Submodule => m instanceof Submodule && m.subKey === key) : undefined;
  if (back) { view = back; camX = cam.x; camY = cam.y; }
  current = snap();
  currentKey = changeKey(current);
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

const PORT_KIND = { audio: 'AUDIO', trig: 'GATE', cv: 'CV' };

const TIPS = [
  'DRAG JACK TO JACK TO PATCH - RIGHT CLICK A JACK OR CABLE TO UNPLUG - WHEEL TO ZOOM',
  'DROP A CABLE ON EMPTY GROUND TO ADD A MODULE THAT TAKES IT',
  'CLICK A CABLE AND PRESS DEL TO REMOVE IT - WIRES BUTTON DIMS OR HIDES CABLES',
  'SHIFT+CLICK OR SHIFT+DRAG TO SELECT SEVERAL MODULES - DRAG ONE TO MOVE THEM ALL',
  'CTRL+D DUPLICATE - CTRL+C / CTRL+V COPY AND PASTE - CTRL+Z UNDO - CTRL+S SAVE',
  'ALT+CLICK A KNOB, THEN MOVE A MIDI CONTROL TO MAP IT - ALT+CLICK AGAIN TO UNMAP',
  'THE + IN A MODULE TITLE OPENS ITS ADVANCED LAYOUT - MIXER GOES BIG',
  'PRESS ? (OR THE ? BUTTON) AND HOVER ANYTHING TO SEE WHAT IT DOES',
  'SUBMODULE: A PATCH IN A BOX - DOUBLE-CLICK TO OPEN, ESC TO COME BACK OUT',
];

// ---------------------------------------------------------------- help panel

const HELP_W = 184;

function wrap(text: string, width: number) {
  const max = Math.floor((width + 1) / 4), lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > max) { lines.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) lines.push(line);
  return lines;
}

interface HelpCard { title: string; col: string; text: string; part?: { title: string; text: string }; foot?: string }

// What help explains for the thing under the pointer (in help mode), or null.
function helpFor(h: Hit): HelpCard | null {
  const mod = (m: Mod) => ({ title: m.title, col: CAT[m.cat].bar, text: HELP[m.type]?.text ?? '' });
  switch (h.k) {
    case 'bar': {
      const label = h.b.label.trim();
      return { title: label, col: h.b.col, text: BAR_HELP[label] ?? '' };
    }
    case 'port': return { ...mod(h.m), part: jackHelp(h.m.type, h.p) };
    case 'knob': return { ...mod(h.m), part: knobHelp(h.m.type, h.kn) };
    case 'body': case 'close': case 'adv': return { ...mod(h.m), foot: MODULE_HOW };
    case 'cable': return { title: 'CABLE', col: TYPEC[h.c.type], text: CABLE_HELP[h.c.type] };
    default: return null;
  }
}

// A card at (x, y), kept on screen; `left` is where to go instead if it won't fit right.
function drawHelp(card: HelpCard, x: number, y: number, left = x) {
  const pad = 4, w = HELP_W, body = wrap(card.text, w - pad * 2);
  const part = card.part ? wrap(card.part.text, w - pad * 2) : [];
  const foot = card.foot ? wrap(card.foot, w - pad * 2) : [];
  const h = 14 + body.length * 7 + (card.part ? 12 + part.length * 7 : 0) + (foot.length ? 4 + foot.length * 7 : 0) + 3;
  if (x + w > UW - 2) x = Math.max(2, left - w);
  y = Math.max(barH + 2, Math.min(y, UH - h - 10));
  ui.rect(x + 2, y + 2, w, h, C.black);
  ui.rect(x, y, w, h, C.black);
  ui.rect(x + 1, y + 1, w - 2, h - 2, C.dark);
  ui.rect(x + 1, y + 1, w - 2, 9, card.col);
  ui.text(card.title, x + pad, y + 3, C.white);
  let ty = y + 14;
  for (const l of body) { ui.text(l, x + pad, ty, C.white); ty += 7; }
  if (card.part) {
    ty += 3;
    ui.rect(x + pad, ty - 2, w - pad * 2, 1, C.slate);
    ui.text(card.part.title, x + pad, ty + 1, C.yellow);
    ty += 9;
    for (const l of part) { ui.text(l, x + pad, ty, C.silver); ty += 7; }
  }
  if (foot.length) {
    ty += 4;
    for (const l of foot) { ui.text(l, x + pad, ty, C.slate); ty += 7; }
  }
}

function drawPrompt(p: NonNullable<typeof namePrompt>, blink: boolean) {
  const w = Math.max(120, textWidth(p.ok) + 10), h = 34, x = Math.floor((UW - w) / 2), y = Math.floor((UH - h) / 2);
  ui.rect(x + 2, y + 2, w, h, C.black);
  ui.rect(x, y, w, h, C.black);
  ui.rect(x + 1, y + 1, w - 2, h - 2, C.dark);
  ui.text(p.title, x + 5, y + 5, C.white);
  ui.rect(x + 4, y + 12, w - 8, 9, C.black);
  ui.text(p.text + (blink ? '_' : ''), x + 6, y + 14, C.yellow);
  ui.text(p.ok, x + 5, y + 25, C.slate);
}

// ---------------------------------------------------------------- labels

function toggleLabel() {
  labelMode = !labelMode;
  helpMode = false;
  if (labelMode) showToast('LABEL - CLICK A MODULE TO NAME IT - ESC OR RIGHT-CLICK TO LEAVE');
}

// Name a module, or edit its name; an empty name removes the label.
function editLabel(m: Mod) {
  namePrompt = {
    text: m.label, title: `LABEL FOR ${m.title}:`, ok: 'ENTER SETS - EMPTY REMOVES - ESC CANCELS', empty: true,
    done: (text) => { m.label = text; m.parent?.childrenChanged(); eng.dirty = true; checkpoint(); },
  };
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

  for (const m of shown()) {
    g.ox = m.x - camX;
    g.oy = m.y - camY;
    drawModule(g, m, h.k === 'close' && h.m === m, h.k === 'adv' && h.m === m);
    if (selected.has(m)) g.frame(-2, -2, m.w + 4, m.h + 4, C.yellow);
  }
  g.ox = -camX;
  g.oy = -camY;

  meterFrame++;
  for (const c of shownCables()) {
    const [x0, y0, x1, y1] = cableEnds(c);
    const col = TYPEC[c.type];
    const lit = t - c.lit < 70 || (h.k === 'cable' && h.c === c);
    if (c === selCable) drawCable(g, x0, y0, x1, y1, blink ? C.white : col, false);
    else if (wires === 2) { plug(g, x0, y0, col); plug(g, x1, y1, col); }
    else {
      g.ctx.globalAlpha = wires === 1 ? 0.25 : 1;
      drawCable(g, x0, y0, x1, y1, col, lit);
      g.ctx.globalAlpha = 1;
      // Audio and CV cables show their signal (trig cables flash on each event instead).
      if (wires === 0 && c.type !== 'trig' && eng.running) {
        drawFlow(g, x0, y0, x1, y1, signalLevel(c), t / (c.type === 'audio' ? 40 : 120));
      }
    }
  }
  if (meterFrame % 60 === 0) pruneMeters();

  if (mode.k === 'box') {
    const x = Math.min(mode.x0, mx + camX), y = Math.min(mode.y0, my + camY);
    const w = Math.abs(mx + camX - mode.x0) + 1, hh = Math.abs(my + camY - mode.y0) + 1;
    if (w > 1 && hh > 1) g.frame(x, y, w, hh, C.yellow);
  }

  if (popup) {
    const [x0, y0] = jackPos(popup.from.m, popup.from.p);
    drawCable(g, x0, y0, popup.wx, popup.wy, TYPEC[popup.from.p.type], false);
  }

  if (mode.k === 'cable') {
    const from = mode;
    // Blink every jack that would accept this cable.
    if (blink) {
      for (const m of shown()) for (const p of m.ports) {
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
  if (learn && blink) g.frame(learn.m.x + learn.kn.x - 2, learn.m.y + learn.kn.y - 2, 15, 15, C.sky);
  if (tip) {
    const cc = tip.m.cc[tip.kn.id];
    drawTooltip(tip.m.x + tip.kn.x + 5, tip.m.y + tip.kn.y - 10, tip.m.knobText(tip.kn) + (cc === undefined ? '' : ` CC${cc}`));
  }
  else if (h.k === 'adv') drawTooltip(h.m.x + h.m.w - 13, h.m.y - 10, h.m.isAdv ? 'SIMPLE' : h.m.advName);
  else if (h.k === 'body' && h.m.bypassed) drawTooltip(h.m.x + Math.floor(h.m.w / 2), h.m.y - 10, 'BYPASSED - SHIFT+CLICK');
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
  // The hint goes once anything has played: PLAY, or a note on KEYS, PADS or MIDI.
  everPlayed ||= eng.sounded;
  if (!everPlayed && blink && !openMenu && !popup) ui.textC('PRESS SPACE TO PLAY', Math.floor(UW / 2), UH - 16, C.yellow);
  ui.text(helpMode ? 'HELP MODE - HOVER ANYTHING - ?, ESC OR RIGHT-CLICK TO LEAVE' : TIPS[Math.floor(t / 7000) % TIPS.length], 3, UH - 7, helpMode ? C.yellow : C.slate);
  // Hovering a module in a menu describes it, next to the menu.
  const am = activeMenu(), item = menuItemAt(ux, uy);
  if (am && item) {
    const kind = item.spawn ? KINDS.find((k) => k.type === item.spawn) : null;
    if (kind && HELP[kind.type]) {
      const iy = am.y + 1 + am.items.indexOf(item) * MENU_ROW;
      drawHelp({ title: kind.label, col: CAT[kind.cat].bar, text: HELP[kind.type].text }, am.x + am.w + 4, iy, am.x - 4);
    }
  } else if (helpMode && mode.k === 'none') {
    const card = helpFor(h);
    if (card) drawHelp(card, ux + 10, uy + 10, ux - 6);
  }
  if (namePrompt) drawPrompt(namePrompt, blink);

  canvas.style.cursor =
    helpMode && mode.k === 'none' ? HELP_CURSOR
    : labelMode && mode.k === 'none' && 'm' in h ? 'text'
    : mode.k === 'move' || mode.k === 'pan' ? 'grabbing'
    : mode.k === 'knob' || h.k === 'knob' ? 'ns-resize'
    : mode.k === 'cable' || h.k === 'port' ? 'crosshair'
    : h.k === 'bar' || h.k === 'close' || h.k === 'adv' || h.k === 'menu' || h.k === 'cable' ? 'pointer'
    : h.k === 'body' ? 'grab'
    : 'default';

  requestAnimationFrame(frame);
}

resize();
layoutBar();
requestAnimationFrame(frame);
void restore();
