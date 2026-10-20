import { ac } from './audio';
import { Engine } from './engine';
import { C, Gfx, textWidth } from './gfx';
import { CAT, TYPEC, compatible, type Drag, type Knob, type Mod, type Port } from './mod';
import { KINDS } from './modules';
import { drawButton, drawCable, drawModule } from './render';

const canvas = document.getElementById('c') as HTMLCanvasElement;
const g = new Gfx(canvas.getContext('2d')!);
const eng = new Engine();
const SAVE_KEY = 'pixel-modular.patch.v1';

let scale = innerWidth >= 1500 ? 3 : 2;
let W = 0, H = 0;
let camX = 0, camY = 0;
let mx = -100, my = -100;
let spawnCount = 0;
let everPlayed = false;

function resize() {
  W = Math.ceil(innerWidth / scale);
  H = Math.ceil(innerHeight / scale);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  canvas.style.width = W * scale + 'px';
  canvas.style.height = H * scale + 'px';
}

// ---------------------------------------------------------------- toolbar

interface Btn { label: string; x: number; y: number; w: number; col: string; act?: () => void; spawn?: string }
let bar: Btn[] = [];
let barH = 13;

function togglePlay() {
  if (eng.running) eng.stop();
  else { eng.start(); everPlayed = true; }
}

function layoutBar() {
  const items: Omit<Btn, 'x' | 'y' | 'w'>[] = [
    { label: eng.running ? '  STOP' : '  PLAY', col: eng.running ? C.red : C.green, act: togglePlay },
    ...KINDS.map((k) => ({ label: k.label, col: CAT[k.cat].cap, spawn: k.type })),
    { label: 'CLEAR', col: C.silver, act: () => eng.clear() },
    { label: 'DEMO', col: C.silver, act: () => { loadPatch(demoPatch()); fitView(); } },
  ];
  bar = [];
  let x = 2, y = 2;
  for (const it of items) {
    const w = textWidth(it.label) + 8;
    if (x + w > W - 2 && x > 2) { x = 2; y += 11; }
    bar.push({ ...it, x, y, w });
    x += w + 2;
    if (it.act === togglePlay) x += 4;
  }
  barH = y + 12;
}

function drawBar() {
  g.rect(0, 0, W, barH, C.black);
  g.rect(0, barH - 1, W, 1, C.dark);
  for (const b of bar) {
    const hover = mx >= b.x && mx < b.x + b.w && my >= b.y && my < b.y + 9;
    drawButton(g, b.x, b.y, b.w, b.label, hover ? C.white : b.col);
    if (b.act === togglePlay) {
      if (eng.running) g.rect(b.x + 4, b.y + 2, 5, 5, C.ink);
      else for (let i = 0; i < 3; i++) g.rect(b.x + 4 + i, b.y + 2 + i, 1, 5 - i * 2, C.ink);
    }
  }
}

// ---------------------------------------------------------------- hit testing

type Hit =
  | { k: 'bar'; b: Btn }
  | { k: 'close'; m: Mod }
  | { k: 'port'; m: Mod; p: Port }
  | { k: 'knob'; m: Mod; kn: Knob }
  | { k: 'body'; m: Mod; lx: number; ly: number }
  | { k: 'none' };

function modAt(wx: number, wy: number) {
  for (let i = eng.mods.length - 1; i >= 0; i--) {
    const m = eng.mods[i];
    if (wx >= m.x && wx < m.x + m.w && wy >= m.y && wy < m.y + m.h) return m;
  }
  return undefined;
}

function portHit(m: Mod, lx: number, ly: number, r: number) {
  return m.ports.find((p) => Math.abs(lx - (p.x + 4)) <= r && Math.abs(ly - (p.y + 4)) <= r);
}

function hitTest(sx: number, sy: number): Hit {
  if (sy < barH) {
    const b = bar.find((b) => sx >= b.x && sx < b.x + b.w && sy >= b.y && sy < b.y + 9);
    return b ? { k: 'bar', b } : { k: 'none' };
  }
  const wx = sx + camX, wy = sy + camY;
  const m = modAt(wx, wy);
  if (!m) return { k: 'none' };
  const lx = wx - m.x, ly = wy - m.y;
  if (lx >= m.w - 9 && lx < m.w - 2 && ly >= 1 && ly < 9) return { k: 'close', m };
  const p = portHit(m, lx, ly, 5);
  if (p) return { k: 'port', m, p };
  const kn = m.knobs.find((k) => lx >= k.x - 1 && lx < k.x + 12 && ly >= k.y - 1 && ly < k.y + 12);
  if (kn) return { k: 'knob', m, kn };
  return { k: 'body', m, lx, ly };
}

const jackPos = (m: Mod, p: Port) => [m.x + p.x + 4, m.y + p.y + 4] as const;

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

function canPlug(a: Port, b: Port) {
  if (a.dir === b.dir) return false;
  return a.dir === 'out' ? compatible(a.type, b.type) : compatible(b.type, a.type);
}

// ---------------------------------------------------------------- interaction

type Mode =
  | { k: 'none' }
  | { k: 'pan'; sx: number; sy: number; cx: number; cy: number }
  | { k: 'move'; m: Mod; dx: number; dy: number; spawned: boolean; moved: boolean }
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
  m.x = camX + Math.floor((W - m.w) / 2) + j - 25;
  m.y = camY + barH + Math.floor((H - barH - m.h) / 2) + j - 25;
}

function setPointer(e: MouseEvent) {
  mx = Math.floor(e.clientX / scale);
  my = Math.floor(e.clientY / scale);
}

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  setPointer(e);
  canvas.setPointerCapture(e.pointerId);
  void ac.resume();
  if (e.button === 1) { mode = { k: 'pan', sx: mx, sy: my, cx: camX, cy: camY }; return; }
  const h = hitTest(mx, my);

  if (e.button === 2) {
    if (h.k === 'port') for (const c of eng.cablesAt(h.m, h.p.id)) eng.disconnect(c);
    return;
  }

  switch (h.k) {
    case 'bar': {
      if (h.b.act) { h.b.act(); return; }
      const kind = KINDS.find((k) => k.type === h.b.spawn)!;
      const m = kind.make(eng);
      m.x = mx + camX - 12;
      m.y = Math.max(my, barH + 2) + camY - 4;
      eng.add(m);
      mode = { k: 'move', m, dx: 12, dy: 4, spawned: true, moved: false };
      return;
    }
    case 'close':
      eng.remove(h.m);
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
      toFront(h.m);
      const d = h.m.press(h.lx, h.ly);
      if (d) mode = { k: 'drag', m: h.m, d };
      else mode = { k: 'move', m: h.m, dx: h.lx, dy: h.ly, spawned: false, moved: false };
      return;
    }
    case 'none':
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
      mode.moved = true;
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
  if (mode.k === 'move' && mode.spawned && (!mode.moved || my < barH)) placeInView(mode.m);
  if (mode.k === 'drag') mode.d.up?.();
  mode = { k: 'none' };
}

canvas.addEventListener('pointerup', (e) => { setPointer(e); endPointer(); });
canvas.addEventListener('pointercancel', endPointer);

let wheelAcc = 0;
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const h = hitTest(mx, my);
  if (h.k === 'knob') {
    const k = h.kn;
    const step = k.step ?? (k.max - k.min) / 50;
    h.m.setKnob(k, h.m.p[k.id] - Math.sign(e.deltaY) * step);
    return;
  }
  wheelAcc += e.deltaY;
  if (Math.abs(wheelAcc) < 60) return;
  const next = Math.min(5, Math.max(1, scale - Math.sign(wheelAcc)));
  wheelAcc = 0;
  if (next === scale) return;
  // Keep the world point under the cursor fixed.
  const wx = mx + camX, wy = my + camY;
  scale = next;
  resize();
  setPointer(e);
  camX = wx - mx;
  camY = wy - my;
}, { passive: false });

addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    void ac.resume();
    togglePlay();
  }
  if (e.code === 'Delete' || e.code === 'Backspace') {
    const h = hitTest(mx, my);
    if (h.k !== 'none' && h.k !== 'bar') eng.remove(h.m);
  }
});

addEventListener('resize', resize);

// ---------------------------------------------------------------- patches

interface PatchData {
  mods: { id: number; type: string; x: number; y: number; p: Record<string, number>; s?: unknown }[];
  cables: { a: number; ap: string; b: number; bp: string }[];
}

function serialize(): PatchData {
  return {
    mods: eng.mods.map((m) => ({ id: m.id, type: m.type, x: m.x, y: m.y, p: m.p, s: m.save() })),
    cables: eng.cables.map((c) => ({ a: c.a.id, ap: c.ap, b: c.b.id, bp: c.bp })),
  };
}

function loadPatch(data: PatchData) {
  eng.clear();
  const byId = new Map<number, Mod>();
  for (const d of data.mods) {
    const kind = KINDS.find((k) => k.type === d.type);
    if (!kind) continue;
    const m = kind.make(eng);
    m.x = d.x;
    m.y = d.y;
    for (const [k, v] of Object.entries(d.p ?? {})) if (k in m.p && typeof v === 'number') m.set(k, v);
    if (d.s !== undefined) m.load(d.s);
    eng.add(m);
    byId.set(d.id, m);
  }
  for (const c of data.cables) {
    const a = byId.get(c.a), b = byId.get(c.b);
    if (a && b) eng.connect(a, c.ap, b, c.bp);
  }
}

function demoPatch(): PatchData {
  const mods: PatchData['mods'] = [];
  const cables: PatchData['cables'] = [];
  const add = (type: string, x: number, y: number, p: Record<string, number> = {}, s?: unknown) => {
    mods.push({ id: mods.length + 1, type, x, y, p, s });
    return mods.length;
  };
  const wire = (a: number, ap: string, b: number, bp: string) => cables.push({ a, ap, b, bp });
  const steps = (on: number[]) => Array.from({ length: 16 }, (_, i) => (on.includes(i) ? '1' : '0')).join('');

  const clock = add('clock', 10, 30);
  const beats = add('beats', 82, 30, {}, [
    steps([0, 4, 8, 12]), steps([4, 12]), steps([2, 6, 10, 14]), steps([12, 15]),
  ]);
  const kick = add('kick', 256, 22);
  const snare = add('snare', 312, 22);
  const hat = add('hihat', 256, 80);
  const clap = add('clap', 312, 80);
  const mixer = add('mixer', 378, 40);
  const speaker = add('speaker', 458, 60);
  const melody = add('melody', 82, 104, { oct: 2, scale: 1 },
    [0, -1, 0, 2, -1, 0, 3, -1, 0, -1, 4, 3, 2, -1, 0, 7]);
  const synth = add('synth', 256, 146);
  const delay = add('delay', 334, 160);
  const reverb = add('reverb', 398, 160);

  wire(clock, 'o16', beats, 'clk');
  wire(clock, 'o16', melody, 'clk');
  [kick, snare, hat, clap].forEach((d, i) => {
    wire(beats, 'o' + i, d, 'in');
    wire(d, 'out', mixer, 'i' + i);
  });
  wire(mixer, 'out', speaker, 'in');
  wire(melody, 'note', synth, 'in');
  wire(synth, 'out', delay, 'in');
  wire(delay, 'out', reverb, 'in');
  wire(reverb, 'out', speaker, 'in');
  return { mods, cables };
}

function fitView() {
  if (!eng.mods.length) { camX = 0; camY = -barH; return; }
  const x0 = Math.min(...eng.mods.map((m) => m.x)), x1 = Math.max(...eng.mods.map((m) => m.x + m.w));
  const y0 = Math.min(...eng.mods.map((m) => m.y)), y1 = Math.max(...eng.mods.map((m) => m.y + m.h));
  camX = Math.floor((x0 + x1 - W) / 2);
  camY = Math.floor((y0 + y1 - H - barH) / 2);
}

function restore() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) { loadPatch(JSON.parse(raw)); return; }
  } catch { /* fall through to the demo */ }
  loadPatch(demoPatch());
}

setInterval(() => {
  if (!eng.dirty) return;
  eng.dirty = false;
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

function frame() {
  eng.flush();
  layoutBar();
  const h = mode.k === 'none' ? hitTest(mx, my) : { k: 'none' as const };
  const t = performance.now();
  const blink = Math.floor(t / 250) % 2 === 0;

  drawField();

  for (const m of eng.mods) {
    g.ox = m.x - camX;
    g.oy = m.y - camY;
    drawModule(g, m, h.k === 'close' && h.m === m);
  }
  g.ox = -camX;
  g.oy = -camY;

  for (const c of eng.cables) {
    const pa = c.a.ports.find((p) => p.id === c.ap)!, pb = c.b.ports.find((p) => p.id === c.bp)!;
    const [x0, y0] = jackPos(c.a, pa), [x1, y1] = jackPos(c.b, pb);
    drawCable(g, x0, y0, x1, y1, TYPEC[c.type], t - c.lit < 70);
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

  // Tooltips: knob values and port names.
  const tip = mode.k === 'knob' ? { m: mode.m, kn: mode.kn } : h.k === 'knob' ? h : null;
  if (tip) drawTooltip(tip.m.x + tip.kn.x + 5, tip.m.y + tip.kn.y - 10, tip.m.knobText(tip.kn));
  else if (h.k === 'port') {
    const kind = h.p.type === 'audio' ? 'AUDIO' : h.p.type === 'note' ? 'NOTES' : 'TRIGGER';
    drawTooltip(h.m.x + h.p.x + 4, h.m.y + h.p.y - 10, `${kind} ${h.p.dir === 'in' ? 'IN' : 'OUT'}`);
  }

  g.ox = 0;
  g.oy = 0;
  drawBar();

  if (!everPlayed && blink) g.textC('PRESS SPACE TO PLAY', Math.floor(W / 2), barH + 6, C.yellow);
  g.text('DRAG JACK TO JACK TO PATCH - RIGHT CLICK JACK TO UNPLUG - WHEEL TO ZOOM - DRAG BACKGROUND TO PAN',
    3, H - 7, C.slate);

  canvas.style.cursor =
    mode.k === 'move' || mode.k === 'pan' ? 'grabbing'
    : mode.k === 'knob' ? 'ns-resize'
    : mode.k === 'cable' || h.k === 'port' ? 'crosshair'
    : h.k === 'knob' ? 'ns-resize'
    : h.k === 'bar' || h.k === 'close' ? 'pointer'
    : h.k === 'body' ? 'grab'
    : 'default';

  requestAnimationFrame(frame);
}

resize();
layoutBar();
restore();
fitView();
requestAnimationFrame(frame);
