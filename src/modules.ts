import { ac, cutHz, decay, noiseBuffer, noiseSrc } from './audio';
import type { Engine } from './engine';
import { C, type Gfx } from './gfx';
import { CvTap, Mod, type Cat, type Drag, type Ev, type KnobDef, type SigType } from './mod';
import { drawButton } from './render';

const now = () => performance.now();
// A CV of 1 moves a filter cutoff by three octaves.
const CV_CENTS = 3600;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ms = (v: number) => Math.round(v * 1000) + 'MS';
const pct = (v: number) => Math.round(v * 100) + '%';
const hz = (v: number) => {
  const f = cutHz(v);
  return f >= 1000 ? (f / 1000).toFixed(1) + 'K' : Math.round(f) + 'HZ';
};

function led(g: Gfx, x: number, y: number, on: boolean, col = C.red) {
  g.rect(x - 1, y - 1, 6, 6, C.black);
  g.rect(x, y, 4, 4, on ? col : C.ink);
  if (on) g.px(x, y, C.white);
}

function inBtn(lx: number, ly: number, x: number, y: number, w: number) {
  return lx >= x && lx < x + w && ly >= y && ly < y + 9;
}

// A "< NAME >" preset selector, w pixels wide.
function drawPresetBar(g: Gfx, x: number, y: number, name: string, w = 66) {
  drawButton(g, x, y, 9, '<', C.silver);
  g.rect(x + 11, y, w - 22, 9, C.black);
  g.textC(name, x + Math.floor(w / 2), y + 2, C.yellow);
  drawButton(g, x + w - 9, y, 9, '>', C.silver);
}

function presetStep(lx: number, ly: number, x: number, y: number, w = 66) {
  if (inBtn(lx, ly, x, y, 9)) return -1;
  if (inBtn(lx, ly, x + w - 9, y, 9)) return 1;
  return 0;
}

const noDrag: Drag = { move() {} };

// Standard small box: one input bottom-left, one output bottom-right.
function io(m: Mod, inType: SigType, inLabel = 'IN') {
  m.port('in', inLabel, inType, 'in', 4, 32);
  m.port('out', 'OUT', 'audio', 'out', m.w - 13, 32);
}

// ---------------------------------------------------------------- CLOCK

export class Clock extends Mod {
  private next = 0;
  private n = 0;
  private beat = -1;

  constructor(e: Engine) {
    super(e, 'clock', 'CLOCK', 'seq', 60, 68);
    this.knob({ id: 'bpm', label: 'BPM', x: 4, y: 32, min: 60, max: 200, def: 120, step: 1 });
    this.knob({ id: 'swing', label: 'SWG', x: 20, y: 32, min: 0, max: 0.5, def: 0, fmt: pct });
    this.port('o16', '16TH', 'trig', 'out', 47, 12);
    this.port('o4', 'BEAT', 'trig', 'out', 47, 32);
    this.port('cv', 'BPM', 'cv', 'in', 4, 51);
  }

  private tap = new CvTap();
  audioIn() { return this.tap.in; }

  // A CV of 1 adds 70 BPM.
  private bpm() { return Math.min(300, Math.max(30, this.p.bpm + this.tap.read() * 70)); }

  reset(t0: number) { this.next = t0; this.n = 0; this.beat = -1; }

  schedule(until: number) {
    // Resync if we fell far behind (e.g. a backgrounded tab).
    if (this.next < ac.currentTime - 0.2) this.next = ac.currentTime + 0.02;
    while (this.next < until) {
      const dur = 15 / this.bpm();
      const t = this.next + (this.n % 2 ? this.p.swing * dur : 0);
      const n = this.n;
      this.emit('o16', { t, dur });
      if (n % 4 === 0) this.emit('o4', { t, dur: dur * 4 });
      this.eng.at(t, () => (this.beat = n));
      this.n++;
      this.next += dur;
    }
  }

  drawBody(g: Gfx) {
    g.rect(3, 12, 39, 16, C.black);
    g.text(String(Math.round(this.eng.running ? this.bpm() : this.p.bpm)).padStart(3, ' '), 5, 15, C.lime, 2);
    const q = this.beat < 0 ? -1 : (this.beat >> 2) % 4;
    for (let i = 0; i < 4; i++) g.rect(30 + i * 3, 15, 2, 2, q === i ? C.lime : C.dark);
    led(g, 34, 21, this.beat >= 0 && this.beat % 4 === 0 && this.eng.running, C.lime);
  }
}

// ---------------------------------------------------------------- BEATS

const ROW_NAMES = ['BD', 'SD', 'HH', 'CP'];

// Drum patterns as step lists per row: BD, SD, HH, CP.
export const BEAT_PRESETS: { name: string; rows: number[][] }[] = [
  { name: 'HOUSE', rows: [[0, 4, 8, 12], [], [2, 6, 10, 14], [4, 12]] },
  { name: 'TECHNO', rows: [[0, 4, 8, 12], [], [2, 3, 6, 7, 10, 11, 14, 15], [4, 12]] },
  { name: 'BOOMBAP', rows: [[0, 7, 10], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14], []] },
  { name: 'BREAK', rows: [[0, 2, 10, 11], [4, 7, 9, 12, 15], [0, 2, 4, 6, 8, 10, 12, 14], []] },
  { name: 'ELECTRO', rows: [[0, 6, 10, 13], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14], [4, 12]] },
  { name: 'DISCO', rows: [[0, 4, 8, 12], [4, 12], [2, 6, 10, 14], [12, 15]] },
  { name: 'TRAP', rows: [[0, 7, 10], [8], [0, 2, 4, 6, 8, 10, 11, 12, 13, 14, 15], [8]] },
  { name: 'DEMBOW', rows: [[0, 4, 8, 12], [3, 6, 11, 14], [0, 2, 4, 6, 8, 10, 12, 14], []] },
  { name: 'HALFTIME', rows: [[0, 3, 10], [8], [0, 4, 8, 12, 14], [8]] },
];

// Five step strings: the four drum rows plus an (empty) accent row.
export function beatSteps(name: string) {
  const pre = BEAT_PRESETS.find((b) => b.name === name)!;
  return [0, 1, 2, 3, 4].map((r) => Array.from({ length: 16 }, (_, i) => (pre.rows[r]?.includes(i) ? '1' : '0')).join(''));
}

const ROW_COLS = [C.red, C.orange, C.yellow, C.lime];
const ACC = 4; // index of the accent row

export class Beats extends Mod {
  steps: boolean[][] = [0, 1, 2, 3, 4].map(() => Array(16).fill(false));
  private pos = -1;
  private shown = -1;
  private preset = -1;

  constructor(e: Engine) {
    super(e, 'beats', 'BEATS', 'seq', 160, 80);
    this.port('clk', 'CLK', 'trig', 'in', 4, 12);
    ROW_NAMES.forEach((_, r) => this.port('o' + r, '', 'trig', 'out', 147, 16 + r * 10));
    this.knob({ id: 'len', label: 'LEN', x: 4, y: 31, min: 1, max: 16, def: 16, step: 1 });
  }

  static cellX(c: number) { return 26 + c * 7 + (c >> 2) * 2; }

  private cellAt(lx: number, ly: number) {
    const r = Math.floor((ly - 16) / 10);
    if (r < 0 || r > ACC || ly - 16 - r * 10 > 8) return null;
    for (let c = 0; c < 16; c++) {
      const x = Beats.cellX(c);
      if (lx >= x && lx < x + 7) return { r, c };
    }
    return null;
  }

  reset() { this.pos = -1; this.shown = -1; }

  onEvent(port: string, ev: Ev) {
    if (port !== 'clk' || ev.off) return;
    const s = (this.pos = (this.pos + 1) % this.p.len);
    this.eng.at(ev.t, () => (this.shown = s));
    const out = { ...ev, acc: this.steps[ACC][s] };
    for (let r = 0; r < ACC; r++) if (this.steps[r][s]) this.emit('o' + r, out);
  }

  drawBody(g: Gfx) {
    const len = this.p.len;
    for (let c = 0; c < len; c++) {
      g.rect(Beats.cellX(c), 13, 6, 2, c === this.shown ? C.lime : C.black);
    }
    this.steps.forEach((row, r) => {
      const y = 16 + r * 10, col = r === ACC ? C.white : ROW_COLS[r];
      g.text(r === ACC ? 'AC' : ROW_NAMES[r], 16, y + 2, col);
      row.forEach((on, c) => {
        const x = Beats.cellX(c), cur = c === this.shown;
        if (c >= len) {
          // steps past the pattern length are inactive
          g.rect(x, y, 6, 8, on ? C.slate : C.black);
        } else if (on) {
          g.rect(x, y, 6, 8, cur ? C.white : col);
          g.rect(x, y, 6, 1, C.white);
          g.rect(x, y + 7, 6, 1, C.black);
        } else {
          g.rect(x, y, 6, 8, cur ? C.slate : C.ink);
          g.rect(x, y + 7, 6, 1, C.black);
        }
      });
    });
    drawPresetBar(g, 26, 68, this.preset < 0 ? 'PRESET' : BEAT_PRESETS[this.preset].name);
    drawButton(g, 100, 68, 22, 'RND', C.yellow);
    drawButton(g, 124, 68, 22, 'CLR', C.silver);
  }

  press(lx: number, ly: number): Drag | null {
    const dir = presetStep(lx, ly, 26, 68);
    if (dir) {
      const n = BEAT_PRESETS.length;
      this.preset = (((this.preset < 0 && dir < 0 ? 0 : this.preset) + dir) % n + n) % n;
      this.load(beatSteps(BEAT_PRESETS[this.preset].name));
      this.eng.dirty = true;
      return noDrag;
    }
    if (inBtn(lx, ly, 100, 68, 22)) {
      const density = [0.3, 0.15, 0.6, 0.12, 0.15];
      this.steps = this.steps.map((_, r) => Array.from({ length: 16 }, (_, c) =>
        r === 0 && c % 4 === 0 ? Math.random() < 0.8 : Math.random() < density[r]));
      this.eng.dirty = true;
      return noDrag;
    }
    if (inBtn(lx, ly, 124, 68, 22)) {
      this.steps = this.steps.map(() => Array(16).fill(false));
      this.eng.dirty = true;
      return noDrag;
    }
    const first = this.cellAt(lx, ly);
    if (!first) return null;
    const val = !this.steps[first.r][first.c];
    const apply = (cell: { r: number; c: number } | null) => {
      if (!cell) return;
      this.steps[cell.r][cell.c] = val;
      this.eng.dirty = true;
    };
    apply(first);
    return { move: (x, y) => apply(this.cellAt(x, y)) };
  }

  save() { return this.steps.map((row) => row.map((b) => (b ? 1 : 0)).join('')); }

  load(s: unknown) {
    if (!Array.isArray(s)) return;
    s.forEach((row, r) => {
      if (typeof row === 'string' && this.steps[r]) this.steps[r] = [...row.padEnd(16, '0')].slice(0, 16).map((ch) => ch === '1');
    });
  }
}

// ---------------------------------------------------------------- DRUMS

// Waveshaper that quantizes to a few levels, then a dull lowpass: instant lo-fi.
function crusher(dest: AudioNode) {
  const sh = ac.createWaveShaper(), lp = ac.createBiquadFilter();
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.round(((i / (n - 1)) * 2 - 1) * 7) / 7;
  sh.curve = curve;
  lp.type = 'lowpass';
  lp.frequency.value = 3500;
  sh.connect(lp).connect(dest);
  return sh;
}

// Soft-clipping overdrive.
function overdrive(dest: AudioNode, amount: number) {
  const sh = ac.createWaveShaper(), g = ac.createGain();
  const n = 1024, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * amount);
  sh.curve = curve;
  g.gain.value = 0.7;
  sh.connect(g).connect(dest);
  return sh;
}

// A kit is a named sound recipe plus the knob settings it starts from.
interface Kit { name: string; set: Record<string, number> }

abstract class Drum extends Mod {
  out = ac.createGain();
  private lofi = crusher(this.out);
  private flash = 0;
  private tap = new CvTap();

  constructor(e: Engine, type: string, title: string, knobs: KnobDef[], public kits: Kit[]) {
    super(e, type, title, 'drum', 50, 63);
    this.p.kit = 0;
    this.knobRow(knobs, 24);
    this.port('in', 'IN', 'trig', 'in', 4, 44);
    this.port('cv', knobs[0].label, 'cv', 'in', 20, 44);
    this.port('out', 'OUT', 'audio', 'out', 37, 44);
  }

  // Knob values for this hit; CV moves the first knob (tune or tone) by up to half its range.
  protected q() {
    const k = this.knobs[0];
    const v = this.p[k.id] + (this.tap.read() * (k.max - k.min)) / 2;
    return { ...this.p, [k.id]: Math.min(k.max, Math.max(k.min, v)) };
  }

  audioIn() { return this.tap.in; }

  get kit() { return (this.kits[Math.round(this.p.kit)] ?? this.kits[0]).name; }

  // Where the kit's sound goes: LOFI kits pass through the crusher.
  protected route(): AudioNode { return this.kit === 'LOFI' ? this.lofi : this.out; }

  // Each hit plays into its own gain so accents can make it louder.
  private bus: AudioNode = this.out;
  dest() { return this.bus; }

  abstract hit(t: number): void;

  onEvent(_port: string, ev: Ev) {
    if (ev.off) return;
    this.eng.at(ev.t, () => (this.flash = now()));
    const bus = ac.createGain();
    bus.gain.value = ev.acc ? 1.6 : 1;
    bus.connect(this.route());
    this.bus = bus;
    this.hit(ev.t);
  }

  audioOut() { return this.out; }

  drawBody(g: Gfx) {
    drawPresetBar(g, 3, 12, this.kit, 44);
    led(g, 35, 3, now() - this.flash < 90);
  }

  press(lx: number, ly: number): Drag | null {
    const dir = presetStep(lx, ly, 3, 12, 44);
    if (!dir) return null;
    const n = this.kits.length;
    this.set('kit', (Math.round(this.p.kit) + dir + n) % n);
    for (const [id, v] of Object.entries(this.kits[this.p.kit].set)) this.set(id, v);
    return noDrag;
  }
}

export class Kick extends Drum {
  private drive = overdrive(this.out, 5);

  protected route() { return this.kit === 'HARD' ? this.drive : super.route(); }

  constructor(e: Engine) {
    super(e, 'kick', 'KICK', [
      { id: 'tune', label: 'TUN', min: 30, max: 90, def: 48, fmt: (v) => Math.round(v) + 'HZ' },
      { id: 'punch', label: 'PCH', min: 0, max: 1, def: 0.5, fmt: pct },
      { id: 'dec', label: 'DEC', min: 0.1, max: 1.5, def: 0.5, fmt: ms },
    ], [
      { name: '808', set: { tune: 48, punch: 0.5, dec: 0.5 } },
      { name: '909', set: { tune: 55, punch: 0.7, dec: 0.3 } },
      { name: 'HARD', set: { tune: 50, punch: 0.9, dec: 0.35 } },
      { name: 'SUB', set: { tune: 40, punch: 0.1, dec: 1 } },
      { name: 'LOFI', set: { tune: 52, punch: 0.5, dec: 0.4 } },
    ]);
  }

  hit(t: number) {
    const { tune, punch, dec } = this.q(), kit = this.kit;
    const dest = this.dest();
    const o = ac.createOscillator(), g = ac.createGain();
    if (kit === 'LOFI') o.type = 'triangle';
    const drop = kit === '909' ? 0.035 : kit === 'HARD' ? 0.05 : 0.07;
    o.frequency.setValueAtTime(tune * (1 + punch * 7), t);
    o.frequency.exponentialRampToValueAtTime(tune, t + drop);
    decay(g.gain, t, 1, dec);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + dec + 0.02);
    if (kit === '909' || kit === 'HARD') {
      // beater click
      const n = noiseSrc(t, 0.02), hp = ac.createBiquadFilter(), ng = ac.createGain();
      hp.type = 'highpass';
      hp.frequency.value = 2500;
      decay(ng.gain, t, 0.2 + punch * 0.4, 0.012);
      n.connect(hp).connect(ng).connect(dest);
    }
  }
}

export class Snare extends Drum {
  constructor(e: Engine) {
    super(e, 'snare', 'SNARE', [
      { id: 'tune', label: 'TUN', min: 100, max: 320, def: 180, fmt: (v) => Math.round(v) + 'HZ' },
      { id: 'snap', label: 'SNP', min: 0, max: 1, def: 0.7, fmt: pct },
      { id: 'dec', label: 'DEC', min: 0.05, max: 0.5, def: 0.18, fmt: ms },
    ], [
      { name: '808', set: { tune: 180, snap: 0.7, dec: 0.18 } },
      { name: '909', set: { tune: 200, snap: 0.85, dec: 0.22 } },
      { name: 'RIM', set: { tune: 180, snap: 0.2, dec: 0.06 } },
      { name: 'LOFI', set: { tune: 170, snap: 0.7, dec: 0.2 } },
    ]);
  }

  private tone(t: number, f: number, type: OscillatorType, level: number, len: number) {
    const o = ac.createOscillator(), og = ac.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.03);
    decay(og.gain, t, level, len);
    o.connect(og).connect(this.dest());
    o.start(t);
    o.stop(t + len + 0.03);
  }

  private noise(t: number, cut: number, level: number, len: number) {
    const n = noiseSrc(t, len + 0.05), hp = ac.createBiquadFilter(), ng = ac.createGain();
    hp.type = 'highpass';
    hp.frequency.value = cut;
    decay(ng.gain, t, level, len);
    n.connect(hp).connect(ng).connect(this.dest());
  }

  hit(t: number) {
    const { tune, snap, dec } = this.q();
    switch (this.kit) {
      case '909':
        this.tone(t, tune, 'triangle', 0.6, 0.1);
        this.tone(t, tune * 1.8, 'triangle', 0.3, 0.07);
        this.noise(t, 2000, 0.1 + snap * 0.9, dec);
        break;
      case 'RIM': {
        // a short, hollow square "tock" through a resonant bandpass
        const o = ac.createOscillator(), bp = ac.createBiquadFilter(), g = ac.createGain();
        o.type = 'square';
        o.frequency.value = tune * 9;
        bp.type = 'bandpass';
        bp.frequency.value = tune * 9;
        bp.Q.value = 4;
        decay(g.gain, t, 1, dec);
        o.connect(bp).connect(g).connect(this.dest());
        o.start(t);
        o.stop(t + dec + 0.02);
        this.noise(t, 4000, snap * 0.5, 0.01);
        break;
      }
      default:
        this.tone(t, tune, 'triangle', 0.7, 0.12);
        this.noise(t, 1200, 0.05 + snap * 0.8, dec);
    }
  }
}

// The six square-wave frequencies of the classic 808 cymbal circuit.
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];

export class HiHat extends Drum {
  constructor(e: Engine) {
    super(e, 'hihat', 'HIHAT', [
      { id: 'tone', label: 'TON', min: 0, max: 1, def: 0.5, fmt: pct },
      { id: 'dec', label: 'DEC', min: 0.02, max: 0.8, def: 0.06, fmt: ms },
    ], [
      { name: '808', set: { tone: 0.5, dec: 0.06 } },
      { name: '909', set: { tone: 0.6, dec: 0.05 } },
      { name: 'LOFI', set: { tone: 0.4, dec: 0.06 } },
    ]);
  }

  hit(t: number) {
    const { tone, dec } = this.q();
    const bp = ac.createBiquadFilter(), hp = ac.createBiquadFilter(), g = ac.createGain();
    bp.type = 'bandpass';
    bp.frequency.value = 10000;
    hp.type = 'highpass';
    hp.frequency.value = 5000 + tone * 4000;
    bp.connect(hp).connect(g).connect(this.dest());
    if (this.kit === '909') {
      // brighter and noisier
      bp.Q.value = 0.7;
      decay(g.gain, t, 0.5, dec);
      noiseSrc(t, dec + 0.02).connect(bp);
      return;
    }
    decay(g.gain, t, 0.35, dec);
    for (const f of METAL) {
      const o = ac.createOscillator();
      o.type = 'square';
      o.frequency.value = f * (0.8 + tone * 0.4);
      o.connect(bp);
      o.start(t);
      o.stop(t + dec + 0.02);
    }
  }
}

export class Clap extends Drum {
  constructor(e: Engine) {
    super(e, 'clap', 'CLAP', [
      { id: 'tone', label: 'TON', min: 600, max: 2400, def: 1200, fmt: (v) => Math.round(v) + 'HZ' },
      { id: 'dec', label: 'DEC', min: 0.05, max: 0.6, def: 0.2, fmt: ms },
    ], [
      { name: '808', set: { tone: 1200, dec: 0.2 } },
      { name: '909', set: { tone: 1500, dec: 0.25 } },
      { name: 'SNAP', set: { tone: 2200, dec: 0.08 } },
      { name: 'LOFI', set: { tone: 1100, dec: 0.2 } },
    ]);
  }

  hit(t: number) {
    const { tone, dec } = this.q(), kit = this.kit;
    const n = noiseSrc(t, 0.05 + dec), bp = ac.createBiquadFilter(), g = ac.createGain();
    bp.type = 'bandpass';
    bp.frequency.value = tone;
    n.connect(bp).connect(g).connect(this.dest());
    if (kit === 'SNAP') {
      // finger snap: a tight resonant burst plus a tiny sine blip
      bp.Q.value = 4;
      decay(g.gain, t, 1.2, dec);
      const o = ac.createOscillator(), og = ac.createGain();
      o.frequency.value = 1800;
      decay(og.gain, t, 0.4, 0.015);
      o.connect(og).connect(this.dest());
      o.start(t);
      o.stop(t + 0.03);
      return;
    }
    // several quick bursts make the "many hands" smear
    const bursts = kit === '909' ? 4 : 3, gap = kit === '909' ? 0.008 : 0.01;
    bp.Q.value = kit === '909' ? 1 : 1.5;
    g.gain.setValueAtTime(0, t);
    for (let i = 0; i < bursts; i++) {
      const tt = t + i * gap;
      g.gain.setValueAtTime(1, tt);
      g.gain.exponentialRampToValueAtTime(0.08, tt + gap * 0.9);
    }
    decay(g.gain, t + bursts * gap, 0.9, dec);
  }
}

export class Cowbell extends Drum {
  constructor(e: Engine) {
    super(e, 'cowbell', 'COWBELL', [
      { id: 'tune', label: 'TUN', min: 0.5, max: 2, def: 1, fmt: (v) => 'X' + v.toFixed(2) },
      { id: 'dec', label: 'DEC', min: 0.05, max: 1, def: 0.3, fmt: ms },
    ], [
      { name: '808', set: { tune: 1, dec: 0.3 } },
      { name: 'CLAVE', set: { tune: 1, dec: 0.08 } },
      { name: 'BLOCK', set: { tune: 1, dec: 0.12 } },
    ]);
  }

  hit(t: number) {
    const { tune, dec } = this.q(), kit = this.kit;
    if (kit !== '808') {
      // clave: pure high sine; wood block: lower, hollow triangle
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = kit === 'CLAVE' ? 'sine' : 'triangle';
      o.frequency.value = (kit === 'CLAVE' ? 2500 : 950) * tune;
      decay(g.gain, t, 0.6, dec);
      o.connect(g).connect(this.dest());
      o.start(t);
      o.stop(t + dec + 0.02);
      return;
    }
    const bp = ac.createBiquadFilter(), g = ac.createGain();
    bp.type = 'bandpass';
    bp.frequency.value = 800 * tune;
    bp.Q.value = 1;
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + dec);
    bp.connect(g).connect(this.dest());
    for (const f of [540, 800]) {
      const o = ac.createOscillator();
      o.type = 'square';
      o.frequency.value = f * tune;
      o.connect(bp);
      o.start(t);
      o.stop(t + dec + 0.02);
    }
  }
}

// ---------------------------------------------------------------- MELODY

const SCALE_NAMES = ['MAJ', 'MIN', 'PEN', 'BLU'];
const SCALES = [[0, 2, 4, 5, 7, 9, 11], [0, 2, 3, 5, 7, 8, 10], [0, 3, 5, 7, 10], [0, 3, 5, 6, 7, 10]];

const _ = -1;
// Rows are scale degrees (0 = root, 7 = top row); scale indexes SCALE_NAMES.
// acc and slide list the accented / sliding steps.
export const MELODY_PRESETS: { name: string; scale: number; notes: number[]; acc?: number[]; slide?: number[] }[] = [
  { name: 'BASSLINE', scale: 1, notes: [0, _, 0, 2, _, 0, 3, _, 0, _, 4, 3, 2, _, 0, 7], acc: [0, 8] },
  { name: 'ACID', scale: 1, notes: [0, 0, 7, _, 0, 3, _, 0, 4, _, 0, 7, 0, 2, _, 3], acc: [0, 4, 8, 12], slide: [2, 7, 11, 15] },
  { name: 'ARP', scale: 0, notes: [0, 2, 4, 7, 4, 2, 0, 2, 4, 7, 4, 2, 0, 2, 4, 7], acc: [0, 6, 12] },
  { name: 'BLUES', scale: 3, notes: [0, _, 1, 2, 3, 4, _, 5, 6, _, 5, 4, 3, 2, 1, _], slide: [2, 3, 12, 13] },
  { name: 'PENTA', scale: 2, notes: [5, _, 4, 3, _, 3, 2, _, 0, _, 2, 3, 4, _, 3, _] },
  { name: 'OCTAVES', scale: 1, notes: [0, 7, 0, 7, 0, 7, 0, 7, 5, 5, 5, 5, 6, 6, 4, 4], acc: [1, 5, 9, 13] },
  { name: 'DRONE', scale: 1, notes: [0, _, _, _, _, _, _, _, 4, _, _, _, 2, _, _, _], slide: [8, 12] },
  { name: 'STABS', scale: 0, notes: [_, _, 4, _, _, _, 4, _, _, _, 4, _, _, 5, _, 4], acc: [13] },
];

export function melodyState(name: string) {
  const pre = MELODY_PRESETS.find((m) => m.name === name)!;
  const bits = (on?: number[]) => Array.from({ length: 16 }, (_, i) => (on?.includes(i) ? '1' : '0')).join('');
  return { n: pre.notes, a: bits(pre.acc), s: bits(pre.slide) };
}

// Chord shapes as stacked scale degrees.
const CHORDS = [[0], [0, 4], [0, 2, 4], [0, 2, 4, 6]];

export class Melody extends Mod {
  notes: number[] = Array(16).fill(-1);
  acc: boolean[] = Array(16).fill(false);
  slide: boolean[] = Array(16).fill(false);
  private pos = -1;
  private shown = -1;
  private preset = -1;

  constructor(e: Engine) {
    super(e, 'melody', 'MELODY', 'seq', 160, 102);
    this.port('clk', 'CLK', 'trig', 'in', 4, 12);
    this.port('note', 'OUT', 'note', 'out', 147, 12);
    this.knob({ id: 'len', label: 'LEN', x: 4, y: 31, min: 1, max: 16, def: 16, step: 1 });
    this.knob({ id: 'root', label: 'KEY', x: 26, y: 80, min: 0, max: 11, def: 0, names: NOTE_NAMES });
    this.knob({ id: 'scale', label: 'SCL', x: 42, y: 80, min: 0, max: 3, def: 1, names: SCALE_NAMES });
    this.knob({ id: 'oct', label: 'OCT', x: 58, y: 80, min: 1, max: 5, def: 2, step: 1 });
    this.knob({ id: 'gate', label: 'GAT', x: 74, y: 80, min: 0.1, max: 1, def: 0.5, fmt: pct });
    this.knob({ id: 'chord', label: 'CHD', x: 90, y: 80, min: 0, max: 3, def: 0, names: ['ONE', 'PWR', 'TRI', '7TH'] });
  }

  private semi(r: number) {
    const sc = SCALES[this.p.scale];
    return sc[r % sc.length] + 12 * Math.floor(r / sc.length);
  }

  private rowY(r: number) { return 16 + (7 - r) * 6; }

  private colAt(lx: number) {
    for (let c = 0; c < 16; c++) {
      const x = Beats.cellX(c);
      if (lx >= x && lx < x + 7) return c;
    }
    return -1;
  }

  // A note cell, or a cell in the accent ('a') / slide ('s') rows.
  private cellAt(lx: number, ly: number): { r: number | 'a' | 's'; c: number } | null {
    const c = this.colAt(lx);
    if (c < 0) return null;
    if (ly >= 66 && ly < 70) return { r: 'a', c };
    if (ly >= 71 && ly < 75) return { r: 's', c };
    const r = 7 - Math.floor((ly - 16) / 6);
    if (r < 0 || r > 7 || ly < 16) return null;
    return { r, c };
  }

  reset() { this.pos = -1; this.shown = -1; }

  onEvent(port: string, ev: Ev) {
    if (port !== 'clk' || ev.off) return;
    const len = this.p.len;
    const s = (this.pos = (this.pos + 1) % len);
    this.eng.at(ev.t, () => (this.shown = s));
    const r = this.notes[s];
    if (r < 0) return;
    // A slide on the next step keeps this note held so the synth can glide into it.
    const next = (s + 1) % len;
    const tie = this.slide[next] && this.notes[next] >= 0;
    const dur = tie ? ev.dur * 1.05 : ev.dur * this.p.gate;
    const shape = CHORDS[this.p.chord];
    for (const o of shape) {
      const note = 12 * (this.p.oct + 1) + this.p.root + this.semi(r + o);
      this.emit('note', { t: ev.t, dur, note, acc: this.acc[s], slide: this.slide[s], voices: shape.length });
    }
  }

  drawBody(g: Gfx) {
    const len = this.p.len;
    for (let c = 0; c < len; c++) {
      g.rect(Beats.cellX(c), 13, 6, 2, c === this.shown ? C.lime : C.black);
    }
    const sl = SCALES[this.p.scale].length;
    for (let r = 0; r < 8; r++) {
      const y = this.rowY(r);
      g.text(NOTE_NAMES[(this.p.root + this.semi(r)) % 12], 16, y, r % sl === 0 ? C.yellow : C.slate);
      for (let c = 0; c < 16; c++) {
        const x = Beats.cellX(c), cur = c === this.shown;
        if (c >= len) g.rect(x, y, 6, 5, this.notes[c] === r ? C.slate : C.black);
        else if (this.notes[c] === r) {
          g.rect(x, y, 6, 5, cur ? C.white : C.yellow);
          g.rect(x, y, 6, 1, C.white);
        } else {
          g.rect(x, y, 6, 5, cur ? C.slate : r % sl === 0 ? C.navy : C.ink);
        }
      }
    }
    // accent and slide rows
    g.text('AC', 16, 65, C.white);
    g.text('SL', 16, 70, C.sky);
    for (let c = 0; c < 16; c++) {
      const x = Beats.cellX(c), off = c >= len ? C.black : C.ink;
      g.rect(x, 66, 6, 4, this.acc[c] ? C.white : off);
      g.rect(x, 71, 6, 4, this.slide[c] ? C.sky : off);
    }
    drawPresetBar(g, 104, 79, this.preset < 0 ? 'PRESET' : MELODY_PRESETS[this.preset].name, 54);
    drawButton(g, 104, 90, 25, 'RND', C.yellow);
    drawButton(g, 131, 90, 25, 'CLR', C.silver);
  }

  press(lx: number, ly: number): Drag | null {
    const dir = presetStep(lx, ly, 104, 79, 54);
    if (dir) {
      const n = MELODY_PRESETS.length;
      this.preset = (((this.preset < 0 && dir < 0 ? 0 : this.preset) + dir) % n + n) % n;
      const pre = MELODY_PRESETS[this.preset];
      this.load(melodyState(pre.name));
      this.set('scale', pre.scale);
      return noDrag;
    }
    if (inBtn(lx, ly, 104, 90, 25)) {
      this.notes = this.notes.map(() => (Math.random() < 0.7 ? Math.floor(Math.random() ** 1.6 * 8) : -1));
      this.acc = this.acc.map(() => Math.random() < 0.2);
      this.slide = this.slide.map(() => Math.random() < 0.15);
      this.eng.dirty = true;
      return noDrag;
    }
    if (inBtn(lx, ly, 131, 90, 25)) {
      this.notes.fill(-1);
      this.acc.fill(false);
      this.slide.fill(false);
      this.eng.dirty = true;
      return noDrag;
    }
    const first = this.cellAt(lx, ly);
    if (!first) return null;
    if (first.r === 'a' || first.r === 's') {
      const row = first.r === 'a' ? this.acc : this.slide;
      const val = !row[first.c];
      const apply = (c: number) => { if (c >= 0) { row[c] = val; this.eng.dirty = true; } };
      apply(first.c);
      return { move: (x) => apply(this.colAt(x)) };
    }
    const erase = this.notes[first.c] === first.r;
    const apply = (cell: { r: number | 'a' | 's'; c: number } | null) => {
      if (!cell || typeof cell.r !== 'number') return;
      this.notes[cell.c] = erase ? -1 : cell.r;
      this.eng.dirty = true;
    };
    apply(first);
    return { move: (x, y) => apply(this.cellAt(x, y)) };
  }

  save() {
    const bits = (b: boolean[]) => b.map((x) => (x ? '1' : '0')).join('');
    return { n: this.notes, a: bits(this.acc), s: bits(this.slide) };
  }

  load(s: unknown) {
    // Older patches stored just the notes array.
    const st = (Array.isArray(s) ? { n: s } : s) as { n?: unknown[]; a?: string; s?: string } | null;
    if (!st) return;
    const n = Array.isArray(st.n) ? st.n : [];
    this.notes = Array.from({ length: 16 }, (_, i) => (typeof n[i] === 'number' ? (n[i] as number) : -1));
    const bits = (x?: string) => Array.from({ length: 16 }, (_, i) => x?.[i] === '1');
    this.acc = bits(st.a);
    this.slide = bits(st.s);
  }
}

// ---------------------------------------------------------------- KEYS

// The computer keyboard as a piano (by physical key position): A S D F... are white
// keys, W E T Y U... the black ones; Z and X shift the octave.
const KEYMAP: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8,
  KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
};
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const BLACK = [[1, 0], [3, 1], [6, 3], [8, 4], [10, 5]]; // semitone, white key it sits after

export class Keys extends Mod {
  private held = new Set<number>();
  private byCode = new Map<string, number>();
  private midi: MIDIAccess | null = null;
  private flash = 0;

  constructor(e: Engine) {
    super(e, 'keys', 'KEYS', 'seq', 122, 60);
    this.port('note', 'OUT', 'note', 'out', 107, 12);
    this.knob({ id: 'oct', label: 'OCT', x: 4, y: 38, min: 0, max: 6, def: 3, step: 1 });
  }

  private base() { return 12 * (this.p.oct + 1); }

  noteOn(n: number) {
    if (this.held.has(n)) return;
    this.held.add(n);
    this.flash = now();
    this.emit('note', { t: ac.currentTime + 0.005, dur: 0, note: n, hold: true });
  }

  noteOff(n: number) {
    if (!this.held.delete(n)) return;
    this.emit('note', { t: ac.currentTime + 0.005, dur: 0, note: n, off: true });
  }

  allOff() {
    for (const n of [...this.held]) this.noteOff(n);
    this.byCode.clear();
  }

  // Computer keyboard; returns whether the key was used.
  key(code: string, down: boolean) {
    if (down && (code === 'KeyZ' || code === 'KeyX')) {
      this.set('oct', Math.min(6, Math.max(0, this.p.oct + (code === 'KeyZ' ? -1 : 1))));
      return true;
    }
    if (!(code in KEYMAP)) return false;
    if (down) {
      const n = this.base() + KEYMAP[code];
      this.byCode.set(code, n);
      this.noteOn(n);
    } else {
      const n = this.byCode.get(code);
      this.byCode.delete(code);
      if (n !== undefined) this.noteOff(n);
    }
    return true;
  }

  private enableMidi() {
    if (this.midi || !navigator.requestMIDIAccess) return;
    navigator.requestMIDIAccess().then((access) => {
      this.midi = access;
      const listen = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = (msg) => {
            const [st, d1, d2] = msg.data ?? [];
            const cmd = st & 0xf0;
            if (cmd === 0x90 && d2 > 0) this.noteOn(d1);
            else if (cmd === 0x80 || cmd === 0x90) this.noteOff(d1);
          };
        }
      };
      listen();
      access.onstatechange = listen;
    }).catch(() => { /* permission denied or no MIDI */ });
  }

  private keyAt(lx: number, ly: number) {
    if (ly < 12 || ly >= 34 || lx < 4 || lx >= 102) return -1;
    const oct = Math.floor((lx - 4) / 49), ox = 4 + oct * 49;
    if (ly < 25) {
      for (const [semi, after] of BLACK) {
        const x = ox + after * 7 + 5;
        if (lx >= x && lx < x + 5) return this.base() + oct * 12 + semi;
      }
    }
    return this.base() + oct * 12 + WHITE[Math.floor((lx - ox) / 7)];
  }

  drawBody(g: Gfx) {
    const base = this.base();
    for (let oct = 0; oct < 2; oct++) {
      const ox = 4 + oct * 49;
      WHITE.forEach((semi, i) => {
        const down = this.held.has(base + oct * 12 + semi);
        g.rect(ox + i * 7, 12, 6, 22, down ? C.yellow : C.white);
        g.rect(ox + i * 7, 33, 6, 1, C.silver);
        if (semi === 0) g.textC(String(this.p.oct + oct), ox + i * 7 + 3, 27, C.silver);
      });
      for (const [semi, after] of BLACK) {
        const down = this.held.has(base + oct * 12 + semi);
        g.rect(ox + after * 7 + 5, 12, 5, 13, down ? C.yellow : C.black);
      }
    }
    drawButton(g, 20, 40, 22, 'MIDI', this.midi ? C.lime : C.silver);
    led(g, 47, 42, now() - this.flash < 90, C.yellow);
    g.text('PLAY: A-K', 56, 40, C.slate);
    g.text('OCT: Z X', 56, 47, C.slate);
  }

  press(lx: number, ly: number): Drag | null {
    if (inBtn(lx, ly, 20, 40, 22)) { this.enableMidi(); return noDrag; }
    let n = this.keyAt(lx, ly);
    if (n < 0) return null;
    this.noteOn(n);
    // Sliding across the keys plays each one, like a glissando.
    return {
      move: (x, y) => {
        const m = this.keyAt(x, y);
        if (m === n) return;
        this.noteOff(n);
        if (m >= 0) this.noteOn(m);
        n = m;
      },
      up: () => { if (n >= 0) this.noteOff(n); },
    };
  }

  destroy() {
    this.allOff();
    if (this.midi) for (const input of this.midi.inputs.values()) input.onmidimessage = null;
  }
}

// ---------------------------------------------------------------- SYNTH

const WAVES: OscillatorType[] = ['sawtooth', 'square', 'triangle', 'sine'];

export class Synth extends Mod {
  out = ac.createGain();
  cv = ac.createGain();

  constructor(e: Engine) {
    super(e, 'synth', 'SYNTH', 'synth', 64, 74);
    this.knobRow([
      { id: 'wave', label: 'WAV', min: 0, max: 3, def: 0, names: ['SAW', 'SQR', 'TRI', 'SIN'] },
      { id: 'oct', label: 'OCT', min: -2, max: 2, def: 0, step: 1, fmt: (v) => (v > 0 ? '+' : '') + v },
      { id: 'cut', label: 'CUT', min: 0, max: 1, def: 0.35, fmt: hz },
    ], 13, 18);
    this.knobRow([
      { id: 'res', label: 'RES', min: 0, max: 20, def: 6, fmt: (v) => v.toFixed(1) },
      { id: 'env', label: 'ENV', min: 0, max: 1, def: 0.6, fmt: pct },
      { id: 'dec', label: 'DEC', min: 0.05, max: 1.5, def: 0.3, fmt: ms },
    ], 33, 18);
    this.cv.gain.value = CV_CENTS;
    this.port('in', 'NOTE', 'note', 'in', 4, 53);
    this.port('cv', 'CUT', 'cv', 'in', 27, 53);
    this.port('out', 'OUT', 'audio', 'out', 51, 53);
  }

  audioIn() { return this.cv; }
  audioOut() { return this.out; }

  // Voices of the chord that started most recently, and the one before it (for slides).
  private chord: Voice[] = [];
  private chordT = -1;
  private prev: Voice[] = [];
  // Live notes held until their note-off.
  private live = new Map<number, Voice>();

  onEvent(_port: string, ev: Ev) {
    const note = ev.note ?? 48;
    if (ev.off) {
      const v = this.live.get(note);
      if (v) { release(v, ev.t); this.live.delete(note); }
      return;
    }
    const { wave, oct, cut, res, env, dec } = this.p;
    const t = ev.t, dur = ev.hold ? HOLD : Math.max(0.02, ev.dur);
    if (t !== this.chordT) { this.prev = this.chord; this.chord = []; this.chordT = t; }
    const f = 440 * 2 ** ((note - 69) / 12 + oct);
    const peak = (0.35 * (ev.acc ? 1.4 : 1)) / Math.sqrt(ev.voices ?? 1);

    // Slide: bend the still-sounding voice to the new pitch without a new attack.
    const old = this.prev[this.chord.length];
    if (ev.slide && old && old.end > t) {
      old.o.frequency.setTargetAtTime(f, t, 0.025);
      old.g.gain.cancelScheduledValues(t);
      old.g.gain.setValueAtTime(peak, t);
      hold(old, t + dur, peak);
      this.chord.push(old);
      return;
    }

    const o = ac.createOscillator(), fl = ac.createBiquadFilter(), g = ac.createGain();
    o.type = WAVES[wave];
    o.frequency.value = f;
    fl.type = 'lowpass';
    fl.Q.value = res;
    const base = cutHz(cut), amt = Math.min(1, env + (ev.acc ? 0.35 : 0));
    fl.frequency.setValueAtTime(Math.min(18000, base * (1 + amt * 16)), t);
    fl.frequency.exponentialRampToValueAtTime(base, t + dec);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.004);
    o.connect(fl).connect(g).connect(this.out);
    this.cv.connect(fl.detune);
    o.onended = () => this.cv.disconnect(fl.detune);
    o.start(t);
    const v: Voice = { o, g, end: 0 };
    hold(v, t + dur, peak);
    this.chord.push(v);
    if (ev.hold) this.live.set(note, v);
  }
}

interface Voice { o: OscillatorNode; g: GainNode; end: number }

// How long a live (held) note may ring before it stops by itself.
const HOLD = 60;

// Keep a voice at peak until `end`, then fade it out.
function hold(v: Voice, end: number, peak: number) {
  v.g.gain.setValueAtTime(peak, end);
  v.g.gain.exponentialRampToValueAtTime(0.001, end + 0.08);
  v.o.stop(end + 0.1);
  v.end = end;
}

function release(v: Voice, t: number) {
  v.g.gain.cancelScheduledValues(t);
  v.g.gain.setTargetAtTime(0.0001, t, 0.03);
  v.o.stop(t + 0.3);
  v.end = t;
}

// ---------------------------------------------------------------- MIXER

export class Mixer extends Mod {
  ins = [0, 1, 2, 3].map(() => ac.createGain());
  out = ac.createGain();

  constructor(e: Engine) {
    super(e, 'mixer', 'MIXER', 'util', 64, 66);
    this.ins.forEach((g, c) => {
      g.connect(this.out);
      this.port('i' + c, String(c + 1), 'audio', 'in', 5 + c * 15, 13);
      this.knob({ id: 'l' + c, label: '', x: 4 + c * 15, y: 30, min: 0, max: 1, def: 0.8, fmt: pct });
    });
    this.knob({ id: 'vol', label: 'VOL', x: 4, y: 47, min: 0, max: 1.5, def: 1, fmt: pct });
    this.port('out', 'OUT', 'audio', 'out', 51, 46);
  }

  onParam(id: string, v: number) {
    const g = id === 'vol' ? this.out : this.ins[Number(id.slice(1))];
    g.gain.setTargetAtTime(v, ac.currentTime, 0.01);
  }

  audioIn(port: string) { return this.ins[Number(port.slice(1))]; }
  audioOut() { return this.out; }
}

// Eight channels, each with level and stereo pan, plus a master volume.
export class BigMixer extends Mod {
  ins = Array.from({ length: 8 }, () => ac.createGain());
  pans = this.ins.map((g) => g.connect(ac.createStereoPanner()) as StereoPannerNode);
  out = ac.createGain();

  constructor(e: Engine) {
    super(e, 'mixer8', 'BIG MIXER', 'util', 142, 84);
    const panFmt = (v: number) => (Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));
    this.ins.forEach((_, c) => {
      this.pans[c].connect(this.out);
      this.port('i' + c, String(c + 1), 'audio', 'in', 19 + c * 15, 13);
      this.knob({ id: 'l' + c, label: '', x: 18 + c * 15, y: 30, min: 0, max: 1, def: 0.8, fmt: pct });
      this.knob({ id: 'p' + c, label: '', x: 18 + c * 15, y: 45, min: -1, max: 1, def: 0, fmt: panFmt });
    });
    this.knob({ id: 'vol', label: 'VOL', x: 18, y: 62, min: 0, max: 1.5, def: 1, fmt: pct });
    this.port('out', 'OUT', 'audio', 'out', 129, 62);
  }

  onParam(id: string, v: number) {
    const t = ac.currentTime, c = Number(id.slice(1));
    if (id === 'vol') this.out.gain.setTargetAtTime(v, t, 0.01);
    else if (id[0] === 'l') this.ins[c].gain.setTargetAtTime(v, t, 0.01);
    else this.pans[c].pan.setTargetAtTime(v, t, 0.01);
  }

  drawBody(g: Gfx) {
    g.text('LVL', 3, 33, C.silver);
    g.text('PAN', 3, 48, C.silver);
  }

  audioIn(port: string) { return this.ins[Number(port.slice(1))]; }
  audioOut() { return this.out; }
}

// ---------------------------------------------------------------- FX

export class Filter extends Mod {
  f = ac.createBiquadFilter();
  cv = ac.createGain();

  constructor(e: Engine) {
    super(e, 'filter', 'FILTER', 'fx', 50, 52);
    this.knobRow([
      { id: 'type', label: 'TYP', min: 0, max: 2, def: 0, names: ['LP', 'HP', 'BP'] },
      { id: 'cut', label: 'CUT', min: 0, max: 1, def: 0.6, fmt: hz },
      { id: 'res', label: 'RES', min: 0, max: 20, def: 2, fmt: (v) => v.toFixed(1) },
    ], 13);
    io(this, 'audio');
    this.cv.gain.value = CV_CENTS;
    this.cv.connect(this.f.detune);
    this.port('cv', 'CUT', 'cv', 'in', 20, 32);
  }

  onParam(id: string, v: number) {
    if (id === 'type') this.f.type = (['lowpass', 'highpass', 'bandpass'] as const)[v];
    if (id === 'cut') this.f.frequency.setTargetAtTime(cutHz(v), ac.currentTime, 0.02);
    if (id === 'res') this.f.Q.setTargetAtTime(v, ac.currentTime, 0.02);
  }

  audioIn(port: string) { return port === 'cv' ? this.cv : this.f; }
  audioOut() { return this.f; }
}

export class Delay extends Mod {
  in = ac.createGain();
  out = ac.createGain();
  d = ac.createDelay(2);
  fb = ac.createGain();
  wet = ac.createGain();
  cv = ac.createGain();

  constructor(e: Engine) {
    super(e, 'delay', 'DELAY', 'fx', 50, 52);
    this.in.connect(this.out);
    this.in.connect(this.d);
    this.d.connect(this.fb).connect(this.d);
    this.d.connect(this.wet).connect(this.out);
    // A CV of 1 adds a quarter second.
    this.cv.gain.value = 0.25;
    this.cv.connect(this.d.delayTime);
    this.knobRow([
      { id: 'time', label: 'TIM', min: 0.05, max: 1, def: 0.375, fmt: ms },
      { id: 'fb', label: 'FBK', min: 0, max: 0.9, def: 0.4, fmt: pct },
      { id: 'mix', label: 'MIX', min: 0, max: 1, def: 0.35, fmt: pct },
    ], 13);
    io(this, 'audio');
    this.port('cv', 'TIM', 'cv', 'in', 20, 32);
  }

  onParam(id: string, v: number) {
    const t = ac.currentTime;
    if (id === 'time') this.d.delayTime.setTargetAtTime(v, t, 0.05);
    if (id === 'fb') this.fb.gain.setTargetAtTime(v, t, 0.02);
    if (id === 'mix') this.wet.gain.setTargetAtTime(v, t, 0.02);
  }

  audioIn(port: string) { return port === 'cv' ? this.cv : this.in; }
  audioOut() { return this.out; }
}

export class Reverb extends Mod {
  in = ac.createGain();
  out = ac.createGain();
  conv = ac.createConvolver();
  wet = ac.createGain();
  cv = ac.createGain();
  private timer = 0;

  constructor(e: Engine) {
    super(e, 'reverb', 'REVERB', 'fx', 50, 52);
    this.in.connect(this.out);
    this.in.connect(this.conv);
    this.conv.connect(this.wet).connect(this.out);
    this.cv.gain.value = 0.5;
    this.cv.connect(this.wet.gain);
    this.knobRow([
      { id: 'size', label: 'SIZ', min: 0, max: 1, def: 0.5, fmt: pct },
      { id: 'mix', label: 'MIX', min: 0, max: 1, def: 0.3, fmt: pct },
    ], 13);
    io(this, 'audio');
    this.port('cv', 'MIX', 'cv', 'in', 20, 32);
  }

  private build() {
    const len = Math.floor(ac.sampleRate * (0.4 + this.p.size * 3.6));
    const buf = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    }
    this.conv.buffer = buf;
  }

  onParam(id: string, v: number) {
    if (id === 'mix') this.wet.gain.setTargetAtTime(v, ac.currentTime, 0.02);
    if (id === 'size') {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.build(), 120);
    }
  }

  audioIn(port: string) { return port === 'cv' ? this.cv : this.in; }
  audioOut() { return this.out; }
  destroy() { clearTimeout(this.timer); }
}

// ---------------------------------------------------------------- SPEAKER

export class Speaker extends Mod {
  in = ac.createGain();
  an = ac.createAnalyser();
  vol = ac.createGain();
  private buf = new Uint8Array(256);

  constructor(e: Engine) {
    super(e, 'speaker', 'SPEAKER', 'util', 64, 54);
    this.an.fftSize = 256;
    this.in.connect(this.an);
    this.in.connect(this.vol).connect(e.master);
    this.port('in', 'IN', 'audio', 'in', 4, 33);
    this.knob({ id: 'vol', label: 'VOL', x: 49, y: 32, min: 0, max: 1, def: 0.8, fmt: pct });
  }

  onParam(_id: string, v: number) { this.vol.gain.setTargetAtTime(v, ac.currentTime, 0.01); }

  audioIn() { return this.in; }

  drawBody(g: Gfx) {
    g.rect(3, 12, 58, 18, C.black);
    this.an.getByteTimeDomainData(this.buf);
    // Trigger on a rising zero crossing so the wave stands still.
    let s = 0;
    for (let i = 1; i < 128; i++) {
      if (this.buf[i - 1] < 128 && this.buf[i] >= 128) { s = i; break; }
    }
    let py = -1;
    for (let x = 0; x < 56; x++) {
      const y = 20 - Math.round(((this.buf[s + x * 2] - 128) / 128) * 7);
      const y0 = py < 0 ? y : py;
      g.rect(4 + x, Math.min(y, y0), 1, Math.abs(y - y0) + 1, C.lime);
      py = y;
    }
    // speaker grille
    for (let y = 34; y < 47; y += 3) for (let x = 18; x < 45; x += 3) g.rect(x, y, 2, 2, C.ink);
  }

  destroy() { this.vol.disconnect(); }
}

// ---------------------------------------------------------------- VOICE PARTS

// Linear FM: an input of 1 swings the frequency by this many times the note's own
// frequency, so the timbre stays the same up and down the keyboard.
const FM_DEPTH = 4;

export class Osc extends Mod {
  o = ac.createOscillator();
  out = ac.createGain();
  cv = ac.createGain();
  fm = ac.createGain();
  private note = 48;

  constructor(e: Engine) {
    super(e, 'osc', 'OSC', 'synth', 64, 52);
    this.o.connect(this.out);
    this.out.gain.value = 0.3;
    // A CV of 1 bends the pitch by one octave, like 1V/oct.
    this.cv.gain.value = 1200;
    this.cv.connect(this.o.detune);
    this.fm.connect(this.o.frequency);
    this.o.start();
    this.knobRow([
      { id: 'wave', label: 'WAV', min: 0, max: 3, def: 0, names: ['SAW', 'SQR', 'TRI', 'SIN'] },
      { id: 'oct', label: 'OCT', min: -2, max: 2, def: 0, step: 1, fmt: (v) => (v > 0 ? '+' : '') + v },
      { id: 'glide', label: 'GLD', min: 0, max: 0.5, def: 0, fmt: ms },
    ], 13);
    this.port('in', 'NOTE', 'note', 'in', 5, 32);
    this.port('cv', 'PIT', 'cv', 'in', 20, 32);
    this.port('fm', 'FM', 'cv', 'in', 35, 32);
    this.port('out', 'OUT', 'audio', 'out', 51, 32);
  }

  private freq() { return 440 * 2 ** ((this.note - 69) / 12 + this.p.oct); }

  private setFreq(t: number, glide: number) {
    const f = this.freq();
    for (const [param, v] of [[this.o.frequency, f], [this.fm.gain, f * FM_DEPTH]] as const) {
      if (glide > 0) param.setTargetAtTime(v, t, glide / 3);
      else param.setValueAtTime(v, t);
    }
  }

  onParam(id: string, v: number) {
    if (id === 'wave') this.o.type = WAVES[v];
    if (id === 'oct') this.setFreq(ac.currentTime, 0);
  }

  onEvent(_port: string, ev: Ev) {
    if (ev.note === undefined || ev.off) return;
    this.note = ev.note;
    this.setFreq(ev.t, ev.slide ? Math.max(this.p.glide, 0.06) : this.p.glide);
  }

  audioIn(port: string) { return port === 'fm' ? this.fm : this.cv; }
  audioOut() { return this.out; }
  destroy() { this.o.stop(); }
}

export class Noise extends Mod {
  src = ac.createBufferSource();
  f = ac.createBiquadFilter();
  out = ac.createGain();

  constructor(e: Engine) {
    super(e, 'noise', 'NOISE', 'synth', 50, 52);
    this.src.buffer = noiseBuffer();
    this.src.loop = true;
    this.f.type = 'lowpass';
    this.src.connect(this.f).connect(this.out);
    this.src.start();
    this.knobRow([
      { id: 'tone', label: 'TON', min: 0, max: 1, def: 0.8, fmt: hz },
      { id: 'lvl', label: 'LVL', min: 0, max: 1, def: 0.3, fmt: pct },
    ], 13);
    this.port('out', 'OUT', 'audio', 'out', 37, 32);
  }

  onParam(id: string, v: number) {
    if (id === 'tone') this.f.frequency.setTargetAtTime(cutHz(v), ac.currentTime, 0.02);
    if (id === 'lvl') this.out.gain.setTargetAtTime(v, ac.currentTime, 0.02);
  }

  drawBody(g: Gfx) {
    for (let i = 0; i < 40; i++) g.px(5 + ((i * 37) % 26), 34 + ((i * 11) % 13), C.slate);
  }

  audioOut() { return this.out; }
  destroy() { this.src.stop(); }
}

// ---------------------------------------------------------------- MODULATION

const lfoHz = (v: number) => 0.05 * 2 ** (v * 9);

export class Lfo extends Mod {
  o = ac.createOscillator();
  cv = ac.createGain();
  out = ac.createGain();
  an = ac.createAnalyser();
  private buf = new Float32Array(32);

  constructor(e: Engine) {
    super(e, 'lfo', 'LFO', 'mod', 50, 52);
    this.an.fftSize = 32;
    this.o.connect(this.out);
    this.out.connect(this.an);
    this.o.start();
    // A CV of 1 adds 5 Hz.
    this.cv.gain.value = 5;
    this.cv.connect(this.o.frequency);
    this.port('cv', 'RAT', 'cv', 'in', 4, 32);
    this.knobRow([
      { id: 'rate', label: 'RAT', min: 0, max: 1, def: 0.4, fmt: (v) => lfoHz(v).toFixed(2) + 'HZ' },
      { id: 'shape', label: 'SHP', min: 0, max: 3, def: 0, names: ['SIN', 'TRI', 'SAW', 'SQR'] },
      { id: 'depth', label: 'DEP', min: 0, max: 1, def: 0.5, fmt: pct },
    ], 13);
    this.port('out', 'OUT', 'cv', 'out', 37, 32);
  }

  onParam(id: string, v: number) {
    const t = ac.currentTime;
    if (id === 'rate') this.o.frequency.setTargetAtTime(lfoHz(v), t, 0.02);
    if (id === 'shape') this.o.type = (['sine', 'triangle', 'sawtooth', 'square'] as const)[v];
    if (id === 'depth') this.out.gain.setTargetAtTime(v, t, 0.02);
  }

  drawBody(g: Gfx) {
    // A centre-zero meter showing where the LFO is right now.
    this.an.getFloatTimeDomainData(this.buf);
    const v = Math.max(-1, Math.min(1, this.buf[this.buf.length - 1]));
    g.rect(16, 34, 18, 7, C.black);
    g.rect(25, 33, 1, 9, C.slate);
    const n = Math.round(v * 8);
    g.rect(n < 0 ? 25 + n : 26, 36, Math.abs(n), 3, C.lime);
  }

  audioIn() { return this.cv; }
  audioOut() { return this.out; }
  destroy() { this.o.stop(); }
}

const envSec = (v: number) => 0.002 * 1000 ** v;

export class Envelope extends Mod {
  src = ac.createConstantSource();
  private flash = 0;

  constructor(e: Engine) {
    super(e, 'env', 'ENVELOPE', 'mod', 64, 70);
    this.src.offset.value = 0;
    this.src.start();
    const time = (v: number) => ms(envSec(v));
    this.knobRow([
      { id: 'a', label: 'A', min: 0, max: 1, def: 0.1, fmt: time },
      { id: 'd', label: 'D', min: 0, max: 1, def: 0.6, fmt: time },
      { id: 's', label: 'S', min: 0, max: 1, def: 0.3, fmt: pct },
      { id: 'r', label: 'R', min: 0, max: 1, def: 0.55, fmt: time },
    ], 31);
    this.port('in', 'GATE', 'trig', 'in', 5, 51);
    this.port('out', 'OUT', 'cv', 'out', 51, 51);
  }

  onEvent(_port: string, ev: Ev) {
    const a = envSec(this.p.a), d = envSec(this.p.d), r = envSec(this.p.r), s = this.p.s;
    const t = ev.t, lvl = this.src.offset;
    lvl.cancelScheduledValues(t);
    if (ev.off) { lvl.setTargetAtTime(0, t, r / 4); return; }
    const dur = ev.hold ? HOLD : ev.dur;
    // A slide keeps the gate open: no new attack, just a later release.
    if (!ev.slide) {
      lvl.setTargetAtTime(ev.acc ? 1.3 : 1, t, a / 4);
      lvl.setTargetAtTime(s, t + a, d / 4);
    }
    lvl.setTargetAtTime(0, t + Math.max(a, dur), r / 4);
    if (!ev.slide) this.eng.at(t, () => (this.flash = now()));
  }

  drawBody(g: Gfx) {
    // Envelope shape: attack, decay, a fixed-length sustain, release.
    g.rect(3, 12, 58, 16, C.black);
    const a = envSec(this.p.a), d = envSec(this.p.d), r = envSec(this.p.r), s = this.p.s;
    const hold = 0.3, total = a + d + hold + r, k = 54 / total;
    const pts: [number, number][] = [[0, 0], [a, 1], [a + d, s], [a + d + hold, s], [total, 0]];
    for (let i = 1; i < pts.length; i++) {
      const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
      g.line(5 + Math.round(t0 * k), 26 - Math.round(v0 * 12), 5 + Math.round(t1 * k), 26 - Math.round(v1 * 12), C.lime);
    }
    led(g, 30, 53, now() - this.flash < 90, C.lime);
  }

  audioOut() { return this.src; }
  destroy() { this.src.stop(); }
}

export class Vca extends Mod {
  g = ac.createGain();
  cv = ac.createGain();

  constructor(e: Engine) {
    super(e, 'vca', 'VCA', 'mod', 50, 52);
    this.cv.connect(this.g.gain);
    this.knobRow([
      { id: 'base', label: 'LVL', min: 0, max: 1, def: 0, fmt: pct },
      { id: 'amt', label: 'CV', min: 0, max: 1, def: 1, fmt: pct },
    ], 13);
    io(this, 'audio');
    this.port('cv', 'CV', 'cv', 'in', 20, 32);
  }

  onParam(id: string, v: number) {
    const t = ac.currentTime;
    if (id === 'base') this.g.gain.setTargetAtTime(v, t, 0.01);
    if (id === 'amt') this.cv.gain.setTargetAtTime(v, t, 0.01);
  }

  audioIn(port: string) { return port === 'cv' ? this.cv : this.g; }
  audioOut() { return this.g; }
}

// ---------------------------------------------------------------- RHYTHM TOOLS

// Clock divider / multiplier: X2 doubles the incoming pulses, /2 /4 /8 thin them out.
export class Divider extends Mod {
  private n = 0;

  constructor(e: Engine) {
    super(e, 'divider', 'DIVIDER', 'seq', 50, 56);
    this.port('in', 'IN', 'trig', 'in', 4, 14);
    this.port('x2', 'X2', 'trig', 'out', 22, 14);
    this.port('d2', '/2', 'trig', 'out', 37, 14);
    this.port('d4', '/4', 'trig', 'out', 22, 34);
    this.port('d8', '/8', 'trig', 'out', 37, 34);
  }

  reset() { this.n = 0; }

  onEvent(_port: string, ev: Ev) {
    if (ev.off) return;
    const half = ev.dur / 2, n = this.n++;
    this.emit('x2', { t: ev.t, dur: half });
    this.emit('x2', { t: ev.t + half, dur: half });
    if (n % 2 === 0) this.emit('d2', { ...ev, dur: ev.dur * 2 });
    if (n % 4 === 0) this.emit('d4', { ...ev, dur: ev.dur * 4 });
    if (n % 8 === 0) this.emit('d8', { ...ev, dur: ev.dur * 8 });
  }
}

// Spreads HITS as evenly as possible over STEPS, the way many world rhythms are built.
export class Euclid extends Mod {
  private pos = -1;
  private shown = -1;

  constructor(e: Engine) {
    super(e, 'euclid', 'EUCLID', 'seq', 64, 58);
    this.port('clk', 'CLK', 'trig', 'in', 4, 14);
    this.port('out', 'OUT', 'trig', 'out', 51, 14);
    this.knobRow([
      { id: 'steps', label: 'STP', min: 1, max: 16, def: 8, step: 1 },
      { id: 'hits', label: 'HIT', min: 0, max: 16, def: 3, step: 1 },
      { id: 'rot', label: 'ROT', min: 0, max: 15, def: 0, step: 1 },
    ], 38, 18);
  }

  private hit(i: number) {
    const n = this.p.steps, k = Math.min(this.p.hits, n);
    const j = (((i - this.p.rot) % n) + n) % n;
    return (j * k) % n < k;
  }

  reset() { this.pos = -1; this.shown = -1; }

  onEvent(_port: string, ev: Ev) {
    if (ev.off) return;
    const s = (this.pos = (this.pos + 1) % this.p.steps);
    this.eng.at(ev.t, () => (this.shown = s));
    if (this.hit(s)) this.emit('out', ev);
  }

  drawBody(g: Gfx) {
    const n = this.p.steps;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = 32 + Math.round(Math.sin(a) * 10), y = 25 - Math.round(Math.cos(a) * 10);
      const col = i === this.shown ? C.white : this.hit(i) ? C.yellow : C.slate;
      g.rect(x - 1, y - 1, 3, 3, C.black);
      g.px(x, y, col);
      if (this.hit(i) || i === this.shown) g.rect(x - 1, y - 1, 3, 3, col);
    }
  }
}

// Passes each trigger to A with the given probability, otherwise to B.
export class Chance extends Mod {
  private flash = 0;
  private lastA = false;

  constructor(e: Engine) {
    super(e, 'chance', 'CHANCE', 'seq', 50, 52);
    this.knob({ id: 'prob', label: 'PRB', x: 4, y: 13, min: 0, max: 1, def: 0.5, fmt: pct });
    this.port('in', 'IN', 'trig', 'in', 4, 32);
    this.port('a', 'A', 'trig', 'out', 22, 32);
    this.port('b', 'B', 'trig', 'out', 37, 32);
  }

  onEvent(_port: string, ev: Ev) {
    if (ev.off) return;
    const a = Math.random() < this.p.prob;
    this.emit(a ? 'a' : 'b', ev);
    this.eng.at(ev.t, () => { this.flash = now(); this.lastA = a; });
  }

  drawBody(g: Gfx) {
    const on = now() - this.flash < 90;
    led(g, 24, 16, on && this.lastA, C.yellow);
    led(g, 39, 16, on && !this.lastA, C.yellow);
    g.text('A', 30, 16, C.silver);
    g.text('B', 45, 16, C.silver);
  }
}

// ---------------------------------------------------------------- CV TOOLS

// Sample & hold: on each trigger, grab the CV input (or a random value if nothing
// is plugged in) and hold it until the next one.
export class SampleHold extends Mod {
  src = ac.createConstantSource();
  private tap = new CvTap();
  private value = 0;

  constructor(e: Engine) {
    super(e, 'snh', 'S&H', 'mod', 50, 52);
    this.src.offset.value = 0;
    this.src.start();
    this.knobRow([
      { id: 'depth', label: 'DEP', min: 0, max: 1, def: 0.5, fmt: pct },
      { id: 'slew', label: 'SLW', min: 0, max: 0.5, def: 0, fmt: ms },
    ], 13);
    this.port('trg', 'TRG', 'trig', 'in', 4, 32);
    this.port('in', 'IN', 'cv', 'in', 20, 32);
    this.port('out', 'OUT', 'cv', 'out', 37, 32);
  }

  onEvent(_port: string, ev: Ev) {
    if (ev.off) return;
    const sampled = this.eng.cablesAt(this, 'in').length > 0;
    const v = (sampled ? this.tap.read() : Math.random() * 2 - 1) * this.p.depth;
    const off = this.src.offset;
    if (this.p.slew > 0) off.setTargetAtTime(v, ev.t, this.p.slew / 3);
    else off.setValueAtTime(v, ev.t);
    this.eng.at(ev.t, () => (this.value = v));
  }

  drawBody(g: Gfx) {
    // vertical meter of the held value
    const n = Math.round(Math.max(-1, Math.min(1, this.value)) * 5);
    g.rect(31, 33, 3, 11, C.black);
    g.rect(31, 38, 3, 1, C.slate);
    g.rect(32, n > 0 ? 38 - n : 39, 1, Math.abs(n), C.lime);
  }

  audioIn() { return this.tap.in; }
  audioOut() { return this.src; }
  destroy() { this.src.stop(); }
}

// Attenuverter: scale (and flip) a CV, then shift it. Also sums everything plugged in.
export class Atten extends Mod {
  in = ac.createGain();
  out = ac.createGain();
  ofs = ac.createConstantSource();

  constructor(e: Engine) {
    super(e, 'atten', 'ATTEN', 'mod', 50, 52);
    this.in.connect(this.out);
    this.ofs.connect(this.out);
    this.ofs.start();
    this.knobRow([
      { id: 'amt', label: 'AMT', min: -4, max: 4, def: 1, fmt: (v) => 'X' + v.toFixed(2) },
      { id: 'ofs', label: 'OFS', min: -1, max: 1, def: 0, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2) },
    ], 13);
    this.port('in', 'IN', 'cv', 'in', 4, 32);
    this.port('out', 'OUT', 'cv', 'out', 37, 32);
  }

  onParam(id: string, v: number) {
    if (id === 'amt') this.in.gain.setTargetAtTime(v, ac.currentTime, 0.01);
    if (id === 'ofs') this.ofs.offset.setTargetAtTime(v, ac.currentTime, 0.01);
  }

  audioIn() { return this.in; }
  audioOut() { return this.out; }
  destroy() { this.ofs.stop(); }
}

// ---------------------------------------------------------------- DIRT

export class Drive extends Mod {
  pre = ac.createGain();
  sh = ac.createWaveShaper();
  lp = ac.createBiquadFilter();
  out = ac.createGain();

  constructor(e: Engine) {
    super(e, 'drive', 'DRIVE', 'fx', 50, 52);
    const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = Math.tanh(((i / (n - 1)) * 2 - 1) * 3);
    this.sh.curve = curve;
    this.sh.oversample = '2x';
    this.lp.type = 'lowpass';
    this.pre.connect(this.sh).connect(this.lp).connect(this.out);
    this.knobRow([
      { id: 'drive', label: 'DRV', min: 0, max: 1, def: 0.5, fmt: pct },
      { id: 'tone', label: 'TON', min: 0, max: 1, def: 0.75, fmt: hz },
      { id: 'lvl', label: 'LVL', min: 0, max: 1, def: 0.5, fmt: pct },
    ], 13);
    io(this, 'audio');
  }

  onParam(id: string, v: number) {
    const t = ac.currentTime;
    if (id === 'drive') this.pre.gain.setTargetAtTime(0.5 + v * v * 30, t, 0.02);
    if (id === 'tone') this.lp.frequency.setTargetAtTime(cutHz(v), t, 0.02);
    if (id === 'lvl') this.out.gain.setTargetAtTime(v, t, 0.02);
  }

  audioIn() { return this.pre; }
  audioOut() { return this.out; }
}

// Wavefolder: loud parts fold back on themselves instead of clipping, adding harmonics.
export class Fold extends Mod {
  pre = ac.createGain();
  sh = ac.createWaveShaper();
  out = ac.createGain();

  constructor(e: Engine) {
    super(e, 'fold', 'FOLD', 'fx', 50, 52);
    this.pre.connect(this.sh).connect(this.out);
    this.knobRow([
      { id: 'fold', label: 'FLD', min: 0, max: 1, def: 0.4, fmt: pct },
      { id: 'lvl', label: 'LVL', min: 0, max: 1, def: 0.6, fmt: pct },
    ], 13);
    io(this, 'audio');
  }

  onParam(id: string, v: number) {
    if (id === 'lvl') this.out.gain.setTargetAtTime(v, ac.currentTime, 0.02);
    if (id === 'fold') {
      const k = 1 + v * 9, n = 2048, curve = new Float32Array(n);
      for (let i = 0; i < n; i++) curve[i] = Math.sin(((i / (n - 1)) * 2 - 1) * k * (Math.PI / 2));
      this.sh.curve = curve;
    }
  }

  audioIn() { return this.pre; }
  audioOut() { return this.out; }
}

// Bitcrusher: fewer bits and a lower sample rate, via a tiny AudioWorklet.
const CRUSH_PROCESSOR = `
class Crush extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bits = 8; this.rate = 4; this.n = 0; this.held = [0, 0];
    this.port.onmessage = (e) => { this.bits = e.data.bits; this.rate = e.data.rate; };
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    const steps = 2 ** (this.bits - 1);
    for (let ch = 0; ch < out.length; ch++) {
      const i = inp[ch] || inp[0], o = out[ch];
      if (!i) { o.fill(0); continue; }
      let n = this.n;
      for (let s = 0; s < o.length; s++) {
        if (n++ % this.rate === 0) this.held[ch] = Math.round(i[s] * steps) / steps;
        o[s] = this.held[ch];
      }
      if (ch === out.length - 1) this.n = n;
    }
    return true;
  }
}
registerProcessor('crush', Crush);
`;
let crushReady: Promise<void> | null = null;

export class Crush extends Mod {
  in = ac.createGain();
  out = ac.createGain();
  private node: AudioWorkletNode | null = null;

  constructor(e: Engine) {
    super(e, 'crush', 'CRUSH', 'fx', 50, 52);
    // Pass audio straight through until the worklet has loaded.
    this.in.connect(this.out);
    this.knobRow([
      { id: 'bits', label: 'BIT', min: 1, max: 16, def: 6, step: 1 },
      { id: 'rate', label: 'RAT', min: 1, max: 32, def: 6, step: 1, fmt: (v) => '/' + Math.round(v) },
      { id: 'lvl', label: 'LVL', min: 0, max: 1, def: 0.7, fmt: pct },
    ], 13);
    io(this, 'audio');
    crushReady ??= ac.audioWorklet.addModule(URL.createObjectURL(new Blob([CRUSH_PROCESSOR], { type: 'text/javascript' })));
    void crushReady.then(() => {
      this.node = new AudioWorkletNode(ac, 'crush', { outputChannelCount: [2] });
      this.in.disconnect(this.out);
      this.in.connect(this.node).connect(this.out);
      this.send();
    });
  }

  private send() { this.node?.port.postMessage({ bits: this.p.bits, rate: this.p.rate }); }

  onParam(id: string, v: number) {
    if (id === 'lvl') this.out.gain.setTargetAtTime(v, ac.currentTime, 0.02);
    else this.send();
  }

  audioIn() { return this.in; }
  audioOut() { return this.out; }
  destroy() { this.node?.disconnect(); }
}

// ---------------------------------------------------------------- registry

export interface Kind { type: string; label: string; cat: Cat; make: (e: Engine) => Mod }

export const KINDS: Kind[] = [
  { type: 'clock', label: 'CLOCK', cat: 'seq', make: (e) => new Clock(e) },
  { type: 'beats', label: 'BEATS', cat: 'seq', make: (e) => new Beats(e) },
  { type: 'melody', label: 'MELODY', cat: 'seq', make: (e) => new Melody(e) },
  { type: 'keys', label: 'KEYS', cat: 'seq', make: (e) => new Keys(e) },
  { type: 'divider', label: 'DIVIDER', cat: 'seq', make: (e) => new Divider(e) },
  { type: 'euclid', label: 'EUCLID', cat: 'seq', make: (e) => new Euclid(e) },
  { type: 'chance', label: 'CHANCE', cat: 'seq', make: (e) => new Chance(e) },
  { type: 'kick', label: 'KICK', cat: 'drum', make: (e) => new Kick(e) },
  { type: 'snare', label: 'SNARE', cat: 'drum', make: (e) => new Snare(e) },
  { type: 'hihat', label: 'HIHAT', cat: 'drum', make: (e) => new HiHat(e) },
  { type: 'clap', label: 'CLAP', cat: 'drum', make: (e) => new Clap(e) },
  { type: 'cowbell', label: 'BELL', cat: 'drum', make: (e) => new Cowbell(e) },
  { type: 'synth', label: 'SYNTH', cat: 'synth', make: (e) => new Synth(e) },
  { type: 'osc', label: 'OSC', cat: 'synth', make: (e) => new Osc(e) },
  { type: 'noise', label: 'NOISE', cat: 'synth', make: (e) => new Noise(e) },
  { type: 'lfo', label: 'LFO', cat: 'mod', make: (e) => new Lfo(e) },
  { type: 'env', label: 'ENV', cat: 'mod', make: (e) => new Envelope(e) },
  { type: 'vca', label: 'VCA', cat: 'mod', make: (e) => new Vca(e) },
  { type: 'snh', label: 'S&H', cat: 'mod', make: (e) => new SampleHold(e) },
  { type: 'atten', label: 'ATTEN', cat: 'mod', make: (e) => new Atten(e) },
  { type: 'filter', label: 'FILTER', cat: 'fx', make: (e) => new Filter(e) },
  { type: 'delay', label: 'DELAY', cat: 'fx', make: (e) => new Delay(e) },
  { type: 'reverb', label: 'REVERB', cat: 'fx', make: (e) => new Reverb(e) },
  { type: 'drive', label: 'DRIVE', cat: 'fx', make: (e) => new Drive(e) },
  { type: 'fold', label: 'FOLD', cat: 'fx', make: (e) => new Fold(e) },
  { type: 'crush', label: 'CRUSH', cat: 'fx', make: (e) => new Crush(e) },
  { type: 'mixer', label: 'MIXER', cat: 'util', make: (e) => new Mixer(e) },
  { type: 'mixer8', label: 'BIG MIXER', cat: 'util', make: (e) => new BigMixer(e) },
  { type: 'speaker', label: 'SPEAKER', cat: 'util', make: (e) => new Speaker(e) },
];
