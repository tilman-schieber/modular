import { ac, cutHz, decay, noiseSrc } from './audio';
import type { Engine } from './engine';
import { C, type Gfx } from './gfx';
import { Mod, type Cat, type Drag, type Ev, type KnobDef, type SigType } from './mod';
import { drawButton } from './render';

const now = () => performance.now();
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
const ROW_COLS = [C.red, C.orange, C.yellow, C.lime];

export class Beats extends Mod {
  steps: boolean[][] = ROW_NAMES.map(() => Array(16).fill(false));
  private pos = -1;
  private shown = -1;

  constructor(e: Engine) {
    super(e, 'beats', 'BEATS', 'seq', 160, 60);
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
  }

  press(lx: number, ly: number): Drag | null {
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

export class Melody extends Mod {
  notes: number[] = Array(16).fill(-1);
  private pos = -1;
  private shown = -1;

  constructor(e: Engine) {
    super(e, 'melody', 'MELODY', 'seq', 160, 90);
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
    drawButton(g, 104, 70, 22, 'RND', C.yellow);
    drawButton(g, 130, 70, 22, 'CLR', C.silver);
  }

  press(lx: number, ly: number): Drag | null {
    if (ly >= 70 && ly < 79) {
      if (lx >= 104 && lx < 126) {
        this.notes = this.notes.map(() => (Math.random() < 0.7 ? Math.floor(Math.random() ** 1.6 * 8) : -1));
        this.eng.dirty = true;
        return { move() {} };
      }
      if (lx >= 130 && lx < 152) {
        this.notes.fill(-1);
        this.eng.dirty = true;
        return { move() {} };
      }
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
    this.port('in', 'NOTE', 'note', 'in', 4, 53);
    this.port('out', 'OUT', 'audio', 'out', 51, 53);
  }

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

  constructor(e: Engine) {
    super(e, 'filter', 'FILTER', 'fx', 50, 52);
    this.knobRow([
      { id: 'type', label: 'TYP', min: 0, max: 2, def: 0, names: ['LP', 'HP', 'BP'] },
      { id: 'cut', label: 'CUT', min: 0, max: 1, def: 0.6, fmt: hz },
      { id: 'res', label: 'RES', min: 0, max: 20, def: 2, fmt: (v) => v.toFixed(1) },
    ], 13);
    io(this, 'audio');
  }

  onParam(id: string, v: number) {
    if (id === 'type') this.f.type = (['lowpass', 'highpass', 'bandpass'] as const)[v];
    if (id === 'cut') this.f.frequency.setTargetAtTime(cutHz(v), ac.currentTime, 0.02);
    if (id === 'res') this.f.Q.setTargetAtTime(v, ac.currentTime, 0.02);
  }

  audioIn() { return this.f; }
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
  { type: 'filter', label: 'FILTER', cat: 'fx', make: (e) => new Filter(e) },
  { type: 'delay', label: 'DELAY', cat: 'fx', make: (e) => new Delay(e) },
  { type: 'reverb', label: 'REVERB', cat: 'fx', make: (e) => new Reverb(e) },
  { type: 'mixer', label: 'MIXER', cat: 'util', make: (e) => new Mixer(e) },
  { type: 'speaker', label: 'SPEAKER', cat: 'util', make: (e) => new Speaker(e) },
];
