import { ac, cutHz, decay, noiseBuffer, noiseSrc } from './audio';
import type { Engine } from './engine';
import { C, type Gfx } from './gfx';
import { Mod, type Cat, type Drag, type Ev, type KnobDef, type SigType } from './mod';
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

// A "< NAME >" preset selector, 66px wide.
function drawPresetBar(g: Gfx, x: number, y: number, name: string) {
  drawButton(g, x, y, 9, '<', C.silver);
  g.rect(x + 11, y, 44, 9, C.black);
  g.textC(name, x + 33, y + 2, C.yellow);
  drawButton(g, x + 57, y, 9, '>', C.silver);
}

function presetStep(lx: number, ly: number, x: number, y: number) {
  if (inBtn(lx, ly, x, y, 9)) return -1;
  if (inBtn(lx, ly, x + 57, y, 9)) return 1;
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
    super(e, 'clock', 'CLOCK', 'util', 60, 54);
    this.knob({ id: 'bpm', label: 'BPM', x: 4, y: 32, min: 60, max: 200, def: 120, step: 1 });
    this.knob({ id: 'swing', label: 'SWG', x: 20, y: 32, min: 0, max: 0.5, def: 0, fmt: pct });
    this.port('o16', '16TH', 'trig', 'out', 47, 12);
    this.port('o4', 'BEAT', 'trig', 'out', 47, 32);
  }

  reset(t0: number) { this.next = t0; this.n = 0; this.beat = -1; }

  schedule(until: number) {
    // Resync if we fell far behind (e.g. a backgrounded tab).
    if (this.next < ac.currentTime - 0.2) this.next = ac.currentTime + 0.02;
    while (this.next < until) {
      const dur = 15 / this.p.bpm;
      const t = this.next + (this.n % 2 ? this.p.swing * dur : 0);
      const n = this.n;
      this.emit('o16', { t, dur });
      if (n % 4 === 0) this.emit('o4', { t, dur: dur * 4 });
      this.eng.at(t, () => (this.beat = n));
      this.n++;
      this.next += 15 / this.p.bpm;
    }
  }

  drawBody(g: Gfx) {
    g.rect(3, 12, 39, 16, C.black);
    g.text(String(Math.round(this.p.bpm)).padStart(3, ' '), 5, 15, C.lime, 2);
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

export function beatSteps(name: string) {
  const pre = BEAT_PRESETS.find((b) => b.name === name)!;
  return pre.rows.map((on) => Array.from({ length: 16 }, (_, i) => (on.includes(i) ? '1' : '0')).join(''));
}
const ROW_COLS = [C.red, C.orange, C.yellow, C.lime];

export class Beats extends Mod {
  steps: boolean[][] = ROW_NAMES.map(() => Array(16).fill(false));
  private pos = -1;
  private shown = -1;
  private preset = -1;

  constructor(e: Engine) {
    super(e, 'beats', 'BEATS', 'seq', 160, 72);
    this.port('clk', 'CLK', 'trig', 'in', 4, 12);
    ROW_NAMES.forEach((_, r) => this.port('o' + r, '', 'trig', 'out', 147, 16 + r * 10));
  }

  static cellX(c: number) { return 26 + c * 7 + (c >> 2) * 2; }

  private cellAt(lx: number, ly: number) {
    const r = Math.floor((ly - 16) / 10);
    if (r < 0 || r > 3 || ly - 16 - r * 10 > 8) return null;
    for (let c = 0; c < 16; c++) {
      const x = Beats.cellX(c);
      if (lx >= x && lx < x + 7) return { r, c };
    }
    return null;
  }

  reset() { this.pos = -1; this.shown = -1; }

  onEvent(port: string, ev: Ev) {
    if (port !== 'clk') return;
    const s = (this.pos = (this.pos + 1) % 16);
    this.eng.at(ev.t, () => (this.shown = s));
    this.steps.forEach((row, r) => row[s] && this.emit('o' + r, ev));
  }

  drawBody(g: Gfx) {
    for (let c = 0; c < 16; c++) {
      g.rect(Beats.cellX(c), 13, 6, 2, c === this.shown ? C.lime : C.black);
    }
    this.steps.forEach((row, r) => {
      const y = 16 + r * 10;
      g.text(ROW_NAMES[r], 16, y + 2, ROW_COLS[r]);
      row.forEach((on, c) => {
        const x = Beats.cellX(c), cur = c === this.shown;
        if (on) {
          g.rect(x, y, 6, 8, cur ? C.white : ROW_COLS[r]);
          g.rect(x, y, 6, 1, C.white);
          g.rect(x, y + 7, 6, 1, C.black);
        } else {
          g.rect(x, y, 6, 8, cur ? C.slate : C.ink);
          g.rect(x, y + 7, 6, 1, C.black);
        }
      });
    });
    drawPresetBar(g, 26, 60, this.preset < 0 ? 'PRESET' : BEAT_PRESETS[this.preset].name);
    drawButton(g, 100, 60, 22, 'RND', C.yellow);
    drawButton(g, 124, 60, 22, 'CLR', C.silver);
  }

  press(lx: number, ly: number): Drag | null {
    const dir = presetStep(lx, ly, 26, 60);
    if (dir) {
      const n = BEAT_PRESETS.length;
      this.preset = (((this.preset < 0 && dir < 0 ? 0 : this.preset) + dir) % n + n) % n;
      this.load(beatSteps(BEAT_PRESETS[this.preset].name));
      this.eng.dirty = true;
      return noDrag;
    }
    if (inBtn(lx, ly, 100, 60, 22)) {
      const density = [0.3, 0.15, 0.6, 0.12];
      this.steps = this.steps.map((_, r) => Array.from({ length: 16 }, (_, c) =>
        r === 0 && c % 4 === 0 ? Math.random() < 0.8 : Math.random() < density[r]));
      this.eng.dirty = true;
      return noDrag;
    }
    if (inBtn(lx, ly, 124, 60, 22)) {
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

abstract class Drum extends Mod {
  out = ac.createGain();
  private flash = 0;

  constructor(e: Engine, type: string, title: string, knobs: KnobDef[]) {
    super(e, type, title, 'drum', 50, 52);
    this.knobRow(knobs, 13);
    io(this, 'trig');
  }

  abstract hit(t: number): void;

  onEvent(_port: string, ev: Ev) {
    this.eng.at(ev.t, () => (this.flash = now()));
    this.hit(ev.t);
  }

  audioOut() { return this.out; }

  drawBody(g: Gfx) {
    led(g, 23, 35, now() - this.flash < 90);
  }
}

export class Kick extends Drum {
  constructor(e: Engine) {
    super(e, 'kick', 'KICK', [
      { id: 'tune', label: 'TUN', min: 30, max: 90, def: 48, fmt: (v) => Math.round(v) + 'HZ' },
      { id: 'punch', label: 'PCH', min: 0, max: 1, def: 0.5, fmt: pct },
      { id: 'dec', label: 'DEC', min: 0.1, max: 1.5, def: 0.5, fmt: ms },
    ]);
  }

  hit(t: number) {
    const { tune, punch, dec } = this.p;
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.setValueAtTime(tune * (1 + punch * 7), t);
    o.frequency.exponentialRampToValueAtTime(tune, t + 0.07);
    decay(g.gain, t, 1, dec);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + dec + 0.02);
  }
}

export class Snare extends Drum {
  constructor(e: Engine) {
    super(e, 'snare', 'SNARE', [
      { id: 'tune', label: 'TUN', min: 100, max: 320, def: 180, fmt: (v) => Math.round(v) + 'HZ' },
      { id: 'snap', label: 'SNP', min: 0, max: 1, def: 0.7, fmt: pct },
      { id: 'dec', label: 'DEC', min: 0.05, max: 0.5, def: 0.18, fmt: ms },
    ]);
  }

  hit(t: number) {
    const { tune, snap, dec } = this.p;
    const o = ac.createOscillator(), og = ac.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(tune * 1.6, t);
    o.frequency.exponentialRampToValueAtTime(tune, t + 0.03);
    decay(og.gain, t, 0.7, 0.12);
    o.connect(og).connect(this.out);
    o.start(t);
    o.stop(t + 0.15);

    const n = noiseSrc(t, dec + 0.05), hp = ac.createBiquadFilter(), ng = ac.createGain();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    decay(ng.gain, t, 0.05 + snap * 0.8, dec);
    n.connect(hp).connect(ng).connect(this.out);
  }
}

// The six square-wave frequencies of the classic 808 cymbal circuit.
const METAL = [205.3, 304.4, 369.6, 522.7, 540, 800];

export class HiHat extends Drum {
  constructor(e: Engine) {
    super(e, 'hihat', 'HIHAT', [
      { id: 'tone', label: 'TON', min: 0, max: 1, def: 0.5, fmt: pct },
      { id: 'dec', label: 'DEC', min: 0.02, max: 0.8, def: 0.06, fmt: ms },
    ]);
  }

  hit(t: number) {
    const { tone, dec } = this.p;
    const bp = ac.createBiquadFilter(), hp = ac.createBiquadFilter(), g = ac.createGain();
    bp.type = 'bandpass';
    bp.frequency.value = 10000;
    hp.type = 'highpass';
    hp.frequency.value = 5000 + tone * 4000;
    decay(g.gain, t, 0.35, dec);
    bp.connect(hp).connect(g).connect(this.out);
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
    ]);
  }

  hit(t: number) {
    const { tone, dec } = this.p;
    const n = noiseSrc(t, 0.05 + dec), bp = ac.createBiquadFilter(), g = ac.createGain();
    bp.type = 'bandpass';
    bp.frequency.value = tone;
    bp.Q.value = 1.5;
    g.gain.setValueAtTime(0, t);
    for (let i = 0; i < 3; i++) {
      const tt = t + i * 0.01;
      g.gain.setValueAtTime(1, tt);
      g.gain.exponentialRampToValueAtTime(0.08, tt + 0.009);
    }
    decay(g.gain, t + 0.03, 0.9, dec);
    n.connect(bp).connect(g).connect(this.out);
  }
}

export class Cowbell extends Drum {
  constructor(e: Engine) {
    super(e, 'cowbell', 'COWBELL', [
      { id: 'tune', label: 'TUN', min: 0.5, max: 2, def: 1, fmt: (v) => 'X' + v.toFixed(2) },
      { id: 'dec', label: 'DEC', min: 0.05, max: 1, def: 0.3, fmt: ms },
    ]);
  }

  hit(t: number) {
    const { tune, dec } = this.p;
    const bp = ac.createBiquadFilter(), g = ac.createGain();
    bp.type = 'bandpass';
    bp.frequency.value = 800 * tune;
    bp.Q.value = 1;
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + dec);
    bp.connect(g).connect(this.out);
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
export const MELODY_PRESETS: { name: string; scale: number; notes: number[] }[] = [
  { name: 'BASSLINE', scale: 1, notes: [0, _, 0, 2, _, 0, 3, _, 0, _, 4, 3, 2, _, 0, 7] },
  { name: 'ACID', scale: 1, notes: [0, 0, 7, _, 0, 3, _, 0, 4, _, 0, 7, 0, 2, _, 3] },
  { name: 'ARP', scale: 0, notes: [0, 2, 4, 7, 4, 2, 0, 2, 4, 7, 4, 2, 0, 2, 4, 7] },
  { name: 'BLUES', scale: 3, notes: [0, _, 1, 2, 3, 4, _, 5, 6, _, 5, 4, 3, 2, 1, _] },
  { name: 'PENTA', scale: 2, notes: [5, _, 4, 3, _, 3, 2, _, 0, _, 2, 3, 4, _, 3, _] },
  { name: 'OCTAVES', scale: 1, notes: [0, 7, 0, 7, 0, 7, 0, 7, 5, 5, 5, 5, 6, 6, 4, 4] },
  { name: 'DRONE', scale: 1, notes: [0, _, _, _, _, _, _, _, 4, _, _, _, 2, _, _, _] },
  { name: 'STABS', scale: 0, notes: [_, _, 4, _, _, _, 4, _, _, _, 4, _, _, 5, _, 4] },
];

export class Melody extends Mod {
  notes: number[] = Array(16).fill(-1);
  private pos = -1;
  private shown = -1;
  private preset = -1;

  constructor(e: Engine) {
    super(e, 'melody', 'MELODY', 'seq', 160, 93);
    this.port('clk', 'CLK', 'trig', 'in', 4, 12);
    this.port('note', 'OUT', 'note', 'out', 147, 12);
    this.knob({ id: 'root', label: 'KEY', x: 26, y: 69, min: 0, max: 11, def: 0, names: NOTE_NAMES });
    this.knob({ id: 'scale', label: 'SCL', x: 42, y: 69, min: 0, max: 3, def: 1, names: SCALE_NAMES });
    this.knob({ id: 'oct', label: 'OCT', x: 58, y: 69, min: 1, max: 5, def: 2, step: 1 });
    this.knob({ id: 'gate', label: 'LEN', x: 74, y: 69, min: 0.1, max: 1, def: 0.5, fmt: pct });
  }

  private semi(r: number) {
    const sc = SCALES[this.p.scale];
    return sc[r % sc.length] + 12 * Math.floor(r / sc.length);
  }

  private rowY(r: number) { return 16 + (7 - r) * 6; }

  private cellAt(lx: number, ly: number) {
    const r = 7 - Math.floor((ly - 16) / 6);
    if (r < 0 || r > 7 || ly < 16) return null;
    for (let c = 0; c < 16; c++) {
      const x = Beats.cellX(c);
      if (lx >= x && lx < x + 7) return { r, c };
    }
    return null;
  }

  reset() { this.pos = -1; this.shown = -1; }

  onEvent(port: string, ev: Ev) {
    if (port !== 'clk') return;
    const s = (this.pos = (this.pos + 1) % 16);
    this.eng.at(ev.t, () => (this.shown = s));
    const r = this.notes[s];
    if (r < 0) return;
    const note = 12 * (this.p.oct + 1) + this.p.root + this.semi(r);
    this.emit('note', { t: ev.t, dur: ev.dur * this.p.gate, note });
  }

  drawBody(g: Gfx) {
    for (let c = 0; c < 16; c++) {
      g.rect(Beats.cellX(c), 13, 6, 2, c === this.shown ? C.lime : C.black);
    }
    const len = SCALES[this.p.scale].length;
    for (let r = 0; r < 8; r++) {
      const y = this.rowY(r);
      g.text(NOTE_NAMES[(this.p.root + this.semi(r)) % 12], 16, y, r % len === 0 ? C.yellow : C.slate);
      for (let c = 0; c < 16; c++) {
        const x = Beats.cellX(c), cur = c === this.shown;
        if (this.notes[c] === r) {
          g.rect(x, y, 6, 5, cur ? C.white : C.yellow);
          g.rect(x, y, 6, 1, C.white);
        } else {
          g.rect(x, y, 6, 5, cur ? C.slate : r % len === 0 ? C.navy : C.ink);
        }
      }
    }
    drawPresetBar(g, 90, 68, this.preset < 0 ? 'PRESET' : MELODY_PRESETS[this.preset].name);
    drawButton(g, 101, 80, 22, 'RND', C.yellow);
    drawButton(g, 125, 80, 22, 'CLR', C.silver);
  }

  press(lx: number, ly: number): Drag | null {
    const dir = presetStep(lx, ly, 90, 68);
    if (dir) {
      const n = MELODY_PRESETS.length;
      this.preset = (((this.preset < 0 && dir < 0 ? 0 : this.preset) + dir) % n + n) % n;
      const pre = MELODY_PRESETS[this.preset];
      this.notes = [...pre.notes];
      this.set('scale', pre.scale);
      return noDrag;
    }
    if (inBtn(lx, ly, 101, 80, 22)) {
      this.notes = this.notes.map(() => (Math.random() < 0.7 ? Math.floor(Math.random() ** 1.6 * 8) : -1));
      this.eng.dirty = true;
      return noDrag;
    }
    if (inBtn(lx, ly, 125, 80, 22)) {
      this.notes.fill(-1);
      this.eng.dirty = true;
      return noDrag;
    }
    const first = this.cellAt(lx, ly);
    if (!first) return null;
    const erase = this.notes[first.c] === first.r;
    const apply = (cell: { r: number; c: number } | null) => {
      if (!cell) return;
      this.notes[cell.c] = erase ? -1 : cell.r;
      this.eng.dirty = true;
    };
    apply(first);
    return { move: (x, y) => apply(this.cellAt(x, y)) };
  }

  save() { return this.notes; }

  load(s: unknown) {
    if (Array.isArray(s)) this.notes = Array.from({ length: 16 }, (_, i) => (typeof s[i] === 'number' ? s[i] : -1));
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

  onEvent(_port: string, ev: Ev) {
    const { wave, oct, cut, res, env, dec } = this.p;
    const t = ev.t, dur = Math.max(0.02, ev.dur);
    const f = 440 * 2 ** (((ev.note ?? 48) - 69) / 12 + oct);
    const o = ac.createOscillator(), fl = ac.createBiquadFilter(), g = ac.createGain();
    o.type = WAVES[wave];
    o.frequency.value = f;
    fl.type = 'lowpass';
    fl.Q.value = res;
    const base = cutHz(cut);
    fl.frequency.setValueAtTime(Math.min(18000, base * (1 + env * 16)), t);
    fl.frequency.exponentialRampToValueAtTime(base, t + dec);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.35, t + 0.004);
    g.gain.setValueAtTime(0.35, t + dur);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur + 0.08);
    o.connect(fl).connect(g).connect(this.out);
    this.cv.connect(fl.detune);
    o.onended = () => this.cv.disconnect(fl.detune);
    o.start(t);
    o.stop(t + dur + 0.1);
  }
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

  constructor(e: Engine) {
    super(e, 'delay', 'DELAY', 'fx', 50, 52);
    this.in.connect(this.out);
    this.in.connect(this.d);
    this.d.connect(this.fb).connect(this.d);
    this.d.connect(this.wet).connect(this.out);
    this.knobRow([
      { id: 'time', label: 'TIM', min: 0.05, max: 1, def: 0.375, fmt: ms },
      { id: 'fb', label: 'FBK', min: 0, max: 0.9, def: 0.4, fmt: pct },
      { id: 'mix', label: 'MIX', min: 0, max: 1, def: 0.35, fmt: pct },
    ], 13);
    io(this, 'audio');
  }

  onParam(id: string, v: number) {
    const t = ac.currentTime;
    if (id === 'time') this.d.delayTime.setTargetAtTime(v, t, 0.05);
    if (id === 'fb') this.fb.gain.setTargetAtTime(v, t, 0.02);
    if (id === 'mix') this.wet.gain.setTargetAtTime(v, t, 0.02);
  }

  audioIn() { return this.in; }
  audioOut() { return this.out; }
}

export class Reverb extends Mod {
  in = ac.createGain();
  out = ac.createGain();
  conv = ac.createConvolver();
  wet = ac.createGain();
  private timer = 0;

  constructor(e: Engine) {
    super(e, 'reverb', 'REVERB', 'fx', 50, 52);
    this.in.connect(this.out);
    this.in.connect(this.conv);
    this.conv.connect(this.wet).connect(this.out);
    this.knobRow([
      { id: 'size', label: 'SIZ', min: 0, max: 1, def: 0.5, fmt: pct },
      { id: 'mix', label: 'MIX', min: 0, max: 1, def: 0.3, fmt: pct },
    ], 13);
    io(this, 'audio');
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

  audioIn() { return this.in; }
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

export class Osc extends Mod {
  o = ac.createOscillator();
  out = ac.createGain();
  cv = ac.createGain();
  private note = 48;

  constructor(e: Engine) {
    super(e, 'osc', 'OSC', 'synth', 50, 52);
    this.o.connect(this.out);
    this.out.gain.value = 0.3;
    // A CV of 1 bends the pitch by one octave, like 1V/oct.
    this.cv.gain.value = 1200;
    this.cv.connect(this.o.detune);
    this.o.start();
    this.knobRow([
      { id: 'wave', label: 'WAV', min: 0, max: 3, def: 0, names: ['SAW', 'SQR', 'TRI', 'SIN'] },
      { id: 'oct', label: 'OCT', min: -2, max: 2, def: 0, step: 1, fmt: (v) => (v > 0 ? '+' : '') + v },
      { id: 'glide', label: 'GLD', min: 0, max: 0.5, def: 0, fmt: ms },
    ], 13);
    this.port('in', 'NOTE', 'note', 'in', 5, 32);
    this.port('cv', 'PIT', 'cv', 'in', 20, 32);
    this.port('out', 'OUT', 'audio', 'out', 37, 32);
  }

  private freq() { return 440 * 2 ** ((this.note - 69) / 12 + this.p.oct); }

  onParam(id: string, v: number) {
    if (id === 'wave') this.o.type = WAVES[v];
    if (id === 'oct') this.o.frequency.setValueAtTime(this.freq(), ac.currentTime);
  }

  onEvent(_port: string, ev: Ev) {
    if (ev.note === undefined) return;
    this.note = ev.note;
    const glide = this.p.glide;
    if (glide > 0) this.o.frequency.setTargetAtTime(this.freq(), ev.t, glide / 3);
    else this.o.frequency.setValueAtTime(this.freq(), ev.t);
  }

  audioIn() { return this.cv; }
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
  out = ac.createGain();
  an = ac.createAnalyser();
  private buf = new Float32Array(32);

  constructor(e: Engine) {
    super(e, 'lfo', 'LFO', 'mod', 50, 52);
    this.an.fftSize = 32;
    this.o.connect(this.out);
    this.out.connect(this.an);
    this.o.start();
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
    g.rect(4, 34, 29, 7, C.black);
    g.rect(18, 33, 1, 9, C.slate);
    const n = Math.round(v * 13);
    g.rect(n < 0 ? 18 + n : 19, 36, Math.abs(n), 3, C.lime);
  }

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
    const t = ev.t, off = this.src.offset;
    off.cancelScheduledValues(t);
    off.setTargetAtTime(1, t, a / 4);
    off.setTargetAtTime(s, t + a, d / 4);
    off.setTargetAtTime(0, t + Math.max(a, ev.dur), r / 4);
    this.eng.at(t, () => (this.flash = now()));
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

// ---------------------------------------------------------------- registry

export interface Kind { type: string; label: string; cat: Cat; make: (e: Engine) => Mod }

export const KINDS: Kind[] = [
  { type: 'clock', label: 'CLOCK', cat: 'util', make: (e) => new Clock(e) },
  { type: 'beats', label: 'BEATS', cat: 'seq', make: (e) => new Beats(e) },
  { type: 'melody', label: 'MELODY', cat: 'seq', make: (e) => new Melody(e) },
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
  { type: 'filter', label: 'FILTER', cat: 'fx', make: (e) => new Filter(e) },
  { type: 'delay', label: 'DELAY', cat: 'fx', make: (e) => new Delay(e) },
  { type: 'reverb', label: 'REVERB', cat: 'fx', make: (e) => new Reverb(e) },
  { type: 'mixer', label: 'MIXER', cat: 'util', make: (e) => new Mixer(e) },
  { type: 'speaker', label: 'SPEAKER', cat: 'util', make: (e) => new Speaker(e) },
];
