import { ac, cutHz, decay, noiseSrc } from './audio';
import type { Engine } from './engine';
import { C, type Gfx } from './gfx';
import { midi } from './midi';
import { download, Recorder, stamp } from './rec';
import { CvTap, Mod, PITCH_REF, velGain, type Cat, type Drag, type Ev, type KnobDef, type SigType } from './mod';
import { drawButton } from './render';

const now = () => performance.now();
// A CV of 1 moves a filter cutoff by three octaves.
const CV_CENTS = 3600;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const ms = (v: number) => Math.round(v * 1000) + 'MS';
const pct = (v: number) => Math.round(v * 100) + '%';
// Envelope times: knob 0..1 is 2 ms to 2 s, exponentially.
const envSec = (v: number) => 0.002 * 1000 ** v;
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

// SYNC modes: run on the BPM knob, follow incoming MIDI clock, or run and send MIDI clock.
const INT = 0, EXT = 1, OUT = 2;
// Steps derived from incoming MIDI clock play this late, so they are never in the past.
const MIDI_LATENCY = 0.03;
// The advanced DIV output's rates.
const DIVS = ['1/32', '1/8T', '1/8', '1/2', '1BAR', '2BAR'];
const DIV_EVERY: Record<string, number> = { '1/8': 2, '1/2': 8, '1BAR': 16, '2BAR': 32 };

export class Clock extends Mod {
  private next = 0;
  private n = 0;
  private beat = -1;
  // Following MIDI clock (24 ticks per beat): ticks since start and a smoothed tick length.
  private ticks = 0;
  private lastTick = 0;
  private tickLen = 60 / 120 / 24;
  private unlisten: () => void;
  // Advanced: tap tempo, and the step length when following CLK IN.
  private taps: number[] = [];
  private extDur = 0;

  constructor(e: Engine) {
    super(e, 'clock', 'CLOCK', 'seq', 60, 72);
    this.advanced('ADVANCED', 92, 72);
    this.knob({ id: 'bpm', label: 'BPM', x: 4, y: 32, min: 60, max: 200, def: 120, step: 1 });
    this.knob({ id: 'swing', label: 'SWG', x: 20, y: 32, min: 0, max: 0.5, def: 0, fmt: pct });
    this.knob({ id: 'sync', label: 'SYN', x: 22, y: 51, min: 0, max: 2, def: INT, names: ['INT', 'EXT', 'OUT'] });
    this.port('o16', '16TH', 'trig', 'out', 47, 12);
    this.port('o4', 'BEAT', 'trig', 'out', 47, 32);
    this.port('cv', 'BPM', 'cv', 'in', 4, 51);
    this.advOnly(() => {
      this.port('clk', 'CLK', 'trig', 'in', 62, 32);
      this.port('rst', 'RST', 'trig', 'out', 77, 32);
      this.knob({ id: 'div', label: 'DIV', x: 62, y: 51, min: 0, max: DIVS.length - 1, def: 2, names: DIVS });
      this.port('div', 'DIV', 'trig', 'out', 77, 51);
    });
    this.unlisten = midi.on((d, t) => this.midiIn(d, t));
  }

  // Advanced: with a cable in CLK, every trigger there is one 16th step.
  private following() { return this.isAdv && this.eng.cablesAt(this, 'clk').length > 0; }

  private tap = new CvTap();
  audioIn() { return this.tap.in; }

  onParam(id: string, v: number) {
    if (id === 'sync' && v !== INT) void midi.enable();
  }

  // A CV of 1 adds 70 BPM.
  private bpm() {
    if (this.following()) return this.extDur ? 15 / this.extDur : this.p.bpm;
    if (this.p.sync === EXT) return 60 / (24 * this.tickLen);
    return Math.min(300, Math.max(30, this.p.bpm + this.tap.read() * 70));
  }

  reset(t0: number) {
    this.next = t0; this.n = 0; this.beat = -1; this.ticks = 0;
    // Engine.stop resets with t0 = 0.
    if (this.p.sync === OUT) midi.send(t0 ? [0xfa] : [0xfc], t0 || undefined);
    if (t0 && this.isAdv) this.emit('rst', { t: t0, dur: 0.01 });
  }

  onEvent(port: string, ev: Ev) {
    if (port !== 'clk' || ev.off || !this.isAdv) return;
    this.extDur = ev.dur;
    this.step(this.n++, ev.t, ev.dur);
  }

  schedule(until: number) {
    if (this.p.sync === EXT || this.following()) return;
    // Resync if we fell far behind (e.g. a backgrounded tab).
    if (this.next < ac.currentTime - 0.2) this.next = ac.currentTime + 0.02;
    while (this.next < until) {
      const dur = 15 / this.bpm();
      this.step(this.n, this.next + (this.n % 2 ? this.p.swing * dur : 0), dur);
      // Six MIDI clock ticks per 16th, on the straight grid.
      if (this.p.sync === OUT) for (let i = 0; i < 6; i++) midi.send([0xf8], this.next + (i * dur) / 6);
      this.n++;
      this.next += dur;
    }
  }

  private step(n: number, t: number, dur: number) {
    this.emit('o16', { t, dur });
    if (n % 4 === 0) this.emit('o4', { t, dur: dur * 4 });
    if (this.isAdv) this.divide(n, t, dur);
    this.eng.at(t, () => (this.beat = n));
  }

  private divide(n: number, t: number, dur: number) {
    const d = DIVS[this.p.div];
    if (d === '1/32') {
      this.emit('div', { t, dur: dur / 2 });
      this.emit('div', { t: t + dur / 2, dur: dur / 2 });
    } else if (d === '1/8T') {
      // three to the beat
      if (n % 4 === 0) for (let k = 0; k < 3; k++) this.emit('div', { t: t + (k * 4 * dur) / 3, dur: (4 * dur) / 3 });
    } else if (n % DIV_EVERY[d] === 0) {
      this.emit('div', { t, dur: dur * DIV_EVERY[d] });
    }
  }

  // Tap tempo: the average of the last few taps, if they come quickly enough.
  press(lx: number, ly: number): Drag | null {
    if (!this.isAdv || !inBtn(lx, ly, 62, 12, 26)) return null;
    const t = performance.now();
    this.taps = [...this.taps.filter((x) => t - x < 2000), t].slice(-5);
    if (this.taps.length > 1) {
      const gap = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
      this.set('bpm', Math.min(200, Math.max(60, Math.round(60000 / gap))));
    }
    return noDrag;
  }

  private midiIn(d: Uint8Array, t: number) {
    if (this.p.sync !== EXT) return;
    const st = d[0];
    if (st === 0xfa || (st === 0xfb && !this.eng.running)) this.eng.start();
    else if (st === 0xfc) this.eng.stop();
    if (st !== 0xf8 || !this.eng.running) return;
    const gap = t - this.lastTick;
    if (gap > 0 && gap < 0.1) this.tickLen += (gap - this.tickLen) * 0.1;
    this.lastTick = t;
    const tick = this.ticks++;
    if (tick % 6) return;
    const n = tick / 6, dur = this.tickLen * 6;
    const at = Math.max(t, ac.currentTime) + MIDI_LATENCY + (n % 2 ? this.p.swing * dur : 0);
    this.step(n, at, dur);
  }

  destroy() { this.unlisten(); }

  drawBody(g: Gfx) {
    g.rect(3, 12, 39, 16, C.black);
    g.text(String(Math.round(this.eng.running ? this.bpm() : this.p.bpm)).padStart(3, ' '), 5, 15, C.lime, 2);
    const q = this.beat < 0 ? -1 : (this.beat >> 2) % 4;
    for (let i = 0; i < 4; i++) g.rect(30 + i * 3, 15, 2, 2, q === i ? C.lime : C.dark);
    led(g, 34, 21, this.beat >= 0 && this.beat % 4 === 0 && this.eng.running, C.lime);
    if (this.isAdv) drawButton(g, 62, 12, 26, 'TAP', now() - (this.taps[this.taps.length - 1] ?? -1e9) < 120 ? C.white : C.yellow);
  }
}

// ---------------------------------------------------------------- TRIG SEQ

// Rhythm presets as step lists per row; in drum terms the rows are kick, snare, hat, clap.
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

// ---------------------------------------------------------------- PATTERNS

const cellX = (c: number) => 26 + c * 7 + (c >> 2) * 2;
const CHAINS = ['A', 'AB', 'ABC', 'ABCD'];

// One sequencer pattern: its steps, plus per step a chance (in quarters, 4 = always)
// and a ratchet count (hits within the step).
interface Pat<T> { d: T; pr: number[]; rt: number[] }

const digits = (str: string | undefined, def: number) =>
  Array.from({ length: 16 }, (_, i) => { const n = Number(str?.[i]); return n >= 1 && n <= 4 ? n : def; });

// Four patterns A-D. The advanced layout edits all of them, plays chance and ratchets
// and can chain the first CHN patterns; the simple layout plays the one last edited.
// A cable at PAT picks where the chain starts: CV 0 is A, 1/3 B, 2/3 C, 1 D. With
// CHN:A that is the pattern itself; with CHN:AB, PAT C plays C D C D.
class Bank<T> {
  pats: Pat<T>[];
  edit = 0;
  private pass = -1;
  // The pattern PAT picked (or -1), and how many passes ago it did.
  private forced = -1;
  private since = 0;

  constructor(make: () => T) {
    this.pats = [0, 1, 2, 3].map(() => ({ d: make(), pr: Array(16).fill(4), rt: Array(16).fill(1) }));
  }

  get cur() { return this.pats[this.edit]; }

  reset() { this.pass = -1; this.forced = -1; }
  // Call on step 0 of every pass, with the PAT CV if a cable is plugged in there.
  wrap(pat?: number) {
    this.pass++;
    const f = pat === undefined ? -1 : Math.min(3, Math.max(0, Math.round(pat * 3)));
    this.since = f === this.forced ? this.since + 1 : 0;
    this.forced = f;
  }

  // The pattern playing this pass.
  playing(chain: number, adv: boolean) {
    if (!adv) return this.edit;
    if (this.forced >= 0) return (this.forced + (this.since % chain)) % 4;
    return chain > 1 ? this.pass % chain : this.edit;
  }

  // How many times step s of pattern i fires this time (0 when its chance says no).
  hits(i: number, s: number, adv: boolean) {
    if (!adv) return 1;
    const p = this.pats[i];
    return Math.random() * 4 < p.pr[s] ? p.rt[s] : 0;
  }

  copy(from: number, to: number) {
    this.pats[to] = JSON.parse(JSON.stringify(this.pats[from]));
  }

  // Only pattern A in use, without chance or ratchets: saved in the older, shorter form.
  plain(empty: (d: T) => boolean) {
    return this.edit === 0 && this.pats.every((p, i) =>
      (i === 0 || empty(p.d)) && p.pr.every((v) => v === 4) && p.rt.every((v) => v === 1));
  }

  save(out: (d: T) => unknown) {
    return { pats: this.pats.map((p) => out(p.d)), pr: this.pats.map((p) => p.pr.join('')), rt: this.pats.map((p) => p.rt.join('')), e: this.edit };
  }

  // Returns false for the older, single-pattern form.
  load(s: unknown, parse: (x: unknown) => T) {
    const st = s as { pats?: unknown[]; pr?: string[]; rt?: string[]; e?: number } | null;
    if (!st || !Array.isArray(st.pats)) return false;
    this.pats.forEach((p, i) => {
      p.d = parse(st.pats![i]);
      p.pr = digits(st.pr?.[i], 4);
      p.rt = digits(st.rt?.[i], 1);
    });
    this.edit = Math.min(3, Math.max(0, Math.round(st.e ?? 0)));
    return true;
  }
}

// Per-step values as bars (empty at the default), h pixels tall.
function drawBars(g: Gfx, y: number, h: number, vals: number[], def: number, col: string, len: number, shown: number) {
  vals.forEach((v, c) => {
    const x = cellX(c);
    g.rect(x, y, 6, h, c >= len ? C.black : c === shown ? C.slate : C.ink);
    if (v === def) return;
    const bh = Math.max(1, Math.round((v / 4) * h));
    g.rect(x, y + h - bh, 6, bh, col);
  });
}

// Clicking a bar steps it: chance 100 > 75 > 50 > 25%, ratchets 1 > 2 > 3 > 4.
const nextChance = (v: number) => (v === 1 ? 4 : v - 1);
const nextRatchet = (v: number) => (v % 4) + 1;

// Pattern buttons A-D (the edited one lit, a dot on the one playing) and the chain.
function drawPatRow(g: Gfx, y: number, edit: number, playing: number, chain: number) {
  'ABCD'.split('').forEach((ch, i) => {
    drawButton(g, 26 + i * 12, y, 11, ch, i === edit ? C.yellow : C.silver);
    if (i === playing) g.rect(26 + i * 12 + 8, y + 2, 2, 2, C.green);
  });
  drawButton(g, 76, y, 36, 'CHN:' + CHAINS[chain - 1], C.cyan);
  g.text('SHIFT=COPY', 116, y + 2, C.slate);
}

function patRowHit(lx: number, ly: number, y: number): number | 'chain' | null {
  for (let i = 0; i < 4; i++) if (inBtn(lx, ly, 26 + i * 12, y, 11)) return i;
  return inBtn(lx, ly, 76, y, 36) ? 'chain' : null;
}

// The PAT CV at time t, or undefined with no cable at PAT (or in the simple layout).
function patIn(m: Mod & { patTap: CvTap }, t: number) {
  if (!m.isAdv || !m.eng.cablesAt(m, 'pat').length) return undefined;
  return m.cvAt('pat', t, m.patTap);
}

interface GridPreset { name: string; rows: number[][] }

// Step strings for a grid preset: one per row, plus the accent row.
export function gridSteps(pre: GridPreset, rows: number) {
  return Array.from({ length: rows + 1 }, (_, r) =>
    Array.from({ length: 16 }, (_, i) => (pre.rows[r]?.includes(i) ? '1' : '0')).join(''));
}

export function beatSteps(name: string) {
  return gridSteps(BEAT_PRESETS.find((b) => b.name === name)!, 4);
}

const ROW_COLS = [C.red, C.orange, C.yellow, C.lime];

// A 16-step trigger grid with one row per sound and an accent row under them, plus
// preset, random and clear buttons. Advanced adds a reset input, chance and ratchet
// rows, and patterns A-D. Subclasses decide what a lit step does.
abstract class StepGrid extends Mod {
  bank: Bank<boolean[][]>;
  private rows: { name: string; col: string }[];
  private presets: GridPreset[];
  private pos = -1;
  private shown = -1;
  private shownPat = 0;
  private preset = -1;
  private resetAt = Infinity;
  patTap = new CvTap();

  constructor(
    e: Engine, type: string, title: string, w: number, h: number,
    rows: { name: string; col: string }[], presets: GridPreset[],
  ) {
    super(e, type, title, 'seq', w, h);
    this.rows = rows;
    this.presets = presets;
    this.bank = new Bank(() => this.parse(null));
    this.advanced('ADVANCED', w, h + 31);
    this.p.chain = 1;
    this.port('clk', 'CLK', 'trig', 'in', 4, 12);
    this.advOnly(() => {
      this.port('rst', 'RST', 'trig', 'in', 4, 52);
      this.port('pat', 'PAT', 'cv', 'in', 4, 73);
    });
  }

  audioIn(port: string): AudioNode | null { return port === 'pat' ? this.patTap.in : null; }

  // The pattern being edited.
  get steps() { return this.bank.cur.d; }
  set steps(v: boolean[][]) { this.bank.cur.d = v; }

  private get acc() { return this.rows.length; }
  // Where the preset bar and buttons sit, under the last row.
  protected get barY() { return 18 + (this.rows.length + (this.isAdv ? 3 : 1)) * 10; }

  private cellAt(lx: number, ly: number) {
    const r = Math.floor((ly - 16) / 10);
    if (r < 0 || r > this.acc + (this.isAdv ? 2 : 0) || ly - 16 - r * 10 > 8) return null;
    for (let c = 0; c < 16; c++) {
      const x = cellX(c);
      if (lx >= x && lx < x + 7) return { r, c };
    }
    return null;
  }

  reset(_t0: number) { this.pos = -1; this.shown = -1; this.bank.reset(); this.resetAt = Infinity; }

  onEvent(port: string, ev: Ev) {
    if (ev.off) return;
    if (port === 'rst') this.resetAt = ev.t;
    if (port === 'clk') this.clock(ev);
  }

  protected abstract clock(ev: Ev): void;

  // Advance one step and call play for each lit row (per ratchet hit), with the step's accent.
  protected step(ev: Ev, play: (row: number, ev: Ev) => void) {
    if (ev.t >= this.resetAt - 0.001) { this.pos = -1; this.bank.reset(); this.resetAt = Infinity; }
    const s = (this.pos = (this.pos + 1) % this.p.len);
    if (s === 0) this.bank.wrap(patIn(this, ev.t));
    const i = this.bank.playing(this.p.chain, this.isAdv), pat = this.bank.pats[i].d;
    this.eng.at(ev.t, () => { this.shown = s; this.shownPat = i; });
    const n = this.bank.hits(i, s, this.isAdv), acc = pat[this.acc][s];
    for (let k = 0; k < n; k++) {
      const hit = { ...ev, t: ev.t + (k * ev.dur) / n, dur: ev.dur / n, acc };
      for (let r = 0; r < this.acc; r++) if (pat[r][s]) play(r, hit);
    }
  }

  drawBody(g: Gfx) {
    const len = this.p.len, shown = this.shownPat === this.bank.edit ? this.shown : -1;
    for (let c = 0; c < len; c++) {
      g.rect(cellX(c), 13, 6, 2, c === shown ? C.lime : C.black);
    }
    this.steps.forEach((row, r) => {
      const y = 16 + r * 10, col = r === this.acc ? C.white : this.rows[r].col;
      g.text(r === this.acc ? 'AC' : this.rows[r].name, 16, y + 2, col);
      row.forEach((on, c) => {
        const x = cellX(c), cur = c === shown;
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
    const y = this.barY;
    if (this.isAdv) {
      const py = 16 + (this.acc + 1) * 10;
      g.text('PR', 16, py + 2, C.lime);
      g.text('RT', 16, py + 12, C.cyan);
      drawBars(g, py, 8, this.bank.cur.pr, 4, C.lime, len, shown);
      drawBars(g, py + 10, 8, this.bank.cur.rt, 1, C.cyan, len, shown);
      drawPatRow(g, y + 11, this.bank.edit, this.eng.running ? this.shownPat : -1, this.p.chain);
    }
    drawPresetBar(g, 26, y, this.preset < 0 ? 'PRESET' : this.presets[this.preset].name);
    drawButton(g, 100, y, 22, 'RND', C.yellow);
    drawButton(g, 124, y, 22, 'CLR', C.silver);
  }

  press(lx: number, ly: number): Drag | null {
    const y = this.barY;
    const dir = presetStep(lx, ly, 26, y);
    if (dir) {
      const n = this.presets.length;
      this.preset = (((this.preset < 0 && dir < 0 ? 0 : this.preset) + dir) % n + n) % n;
      this.steps = this.parse(gridSteps(this.presets[this.preset], this.acc));
      this.eng.dirty = true;
      return noDrag;
    }
    if (inBtn(lx, ly, 100, y, 22)) {
      // Kick, snare, hats, then everything else; the kick favours the downbeats.
      const density = [0.3, 0.15, 0.6, 0.12, 0.15];
      this.steps = this.steps.map((_, r) => Array.from({ length: 16 }, (_, c) =>
        r === 0 && c % 4 === 0 ? Math.random() < 0.8 : Math.random() < density[Math.min(r, 4)]));
      this.eng.dirty = true;
      return noDrag;
    }
    if (inBtn(lx, ly, 124, y, 22)) {
      this.steps = this.parse(null);
      this.eng.dirty = true;
      return noDrag;
    }
    if (this.isAdv) {
      const hit = patRowHit(lx, ly, y + 11);
      if (hit === 'chain') this.set('chain', (this.p.chain % 4) + 1);
      else if (hit !== null) { this.bank.edit = hit; this.eng.dirty = true; }
      if (hit !== null) return noDrag;
    }
    const first = this.cellAt(lx, ly);
    if (!first) return null;
    if (first.r > this.acc) {
      // chance or ratchet row: step the value, then paint it along a drag
      const vals = first.r === this.acc + 1 ? this.bank.cur.pr : this.bank.cur.rt;
      const val = (first.r === this.acc + 1 ? nextChance : nextRatchet)(vals[first.c]);
      const apply = (cell: { r: number; c: number } | null) => {
        if (cell?.r !== first.r) return;
        vals[cell.c] = val;
        this.eng.dirty = true;
      };
      apply(first);
      return { move: (x, y) => apply(this.cellAt(x, y)) };
    }
    const val = !this.steps[first.r][first.c];
    const apply = (cell: { r: number; c: number } | null) => {
      if (!cell || cell.r > this.acc) return;
      this.steps[cell.r][cell.c] = val;
      this.eng.dirty = true;
    };
    apply(first);
    return { move: (x, y) => apply(this.cellAt(x, y)) };
  }

  // Shift+click a pattern button: copy the edited pattern there and edit the copy.
  pressShift(lx: number, ly: number) {
    const hit = this.isAdv ? patRowHit(lx, ly, this.barY + 11) : null;
    if (typeof hit !== 'number') return false;
    this.bank.copy(this.bank.edit, hit);
    this.bank.edit = hit;
    this.eng.dirty = true;
    return true;
  }

  // Step strings (one per row) to steps; anything else gives an empty pattern.
  private parse(x: unknown) {
    const rows = Array.from({ length: this.acc + 1 }, () => Array(16).fill(false) as boolean[]);
    if (Array.isArray(x)) x.forEach((row, r) => {
      if (typeof row === 'string' && rows[r]) rows[r] = [...row.padEnd(16, '0')].slice(0, 16).map((ch) => ch === '1');
    });
    return rows;
  }

  save() {
    const out = (d: boolean[][]) => d.map((row) => row.map((b) => (b ? 1 : 0)).join(''));
    const empty = (d: boolean[][]) => d.every((row) => row.every((b) => !b));
    return this.bank.plain(empty) ? out(this.bank.pats[0].d) : this.bank.save(out);
  }

  load(s: unknown) {
    if (!this.bank.load(s, (x) => this.parse(x))) this.bank.pats[0].d = this.parse(s);
  }
}

// A trigger sequencer: four numbered rows, each with its own output, for drums,
// envelopes or anything else that takes triggers. (Its type is still 'beats', the
// name it had when its rows were drums.)
export class Beats extends StepGrid {
  constructor(e: Engine) {
    super(e, 'beats', 'TRIG SEQ', 160, 80, ROW_COLS.map((col, r) => ({ name: String(r + 1), col })), BEAT_PRESETS);
    ROW_COLS.forEach((_, r) => this.port('o' + r, '', 'trig', 'out', 147, 16 + r * 10));
    this.knob({ id: 'len', label: 'LEN', x: 4, y: 31, min: 1, max: 16, def: 16, step: 1 });
  }

  protected clock(ev: Ev) { this.step(ev, (r, out) => this.emit('o' + r, out)); }
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
    this.advanced('ADVANCED', 50, 82);
    this.p.kit = 0;
    this.knobRow(knobs, 24);
    this.port('in', 'IN', 'trig', 'in', 4, 44);
    this.port('cv', knobs[0].label, 'cv', 'in', 20, 44);
    this.port('out', 'OUT', 'audio', 'out', 37, 44);
    // Advanced: a CV jack under each of the other knobs.
    for (const k of knobs.slice(1)) this.cvKnob(k.id, this.knobById(k.id).x + 1, 63);
  }

  // Knob values for this hit; CV moves the first knob (tune or tone) by up to half its
  // range, and in the advanced layout the others too.
  protected q() {
    const k = this.knobs[0];
    const v = this.p[k.id] + (this.tap.read() * (k.max - k.min)) / 2;
    const rest = Object.fromEntries(this.knobs.slice(1).map((o) => [o.id, this.val(o.id)]));
    return { ...this.p, ...rest, [k.id]: Math.min(k.max, Math.max(k.min, v)) };
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
    // A hit lights up the IN jack (the title bar has the toggles).
    if (now() - this.flash < 90) g.frame(3, 43, 11, 11, C.red);
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

// A dull lowpass into gentle saturation: a kick off an old tape.
function muffled(dest: AudioNode) {
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  lp.connect(overdrive(dest, 2.5));
  return lp;
}

export class Kick extends Drum {
  private drive = overdrive(this.out, 5);
  // A kick through the crusher's few levels turns into a buzz, so LOFI muffles it instead.
  private dusty = muffled(this.out);

  protected route() { return this.kit === 'HARD' ? this.drive : this.kit === 'LOFI' ? this.dusty : super.route(); }

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
      { name: 'LOFI', set: { tune: 52, punch: 0.3, dec: 0.4 } },
      { name: 'JAZZ', set: { tune: 60, punch: 0.3, dec: 0.3 } },
    ]);
  }

  hit(t: number) {
    const { tune, punch, dec } = this.q(), kit = this.kit;
    const dest = this.dest();
    if (kit === 'JAZZ') {
      // a soft felt beater on a round drum: barely any pitch drop, a muffled thump
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.setValueAtTime(tune * (1.2 + punch), t);
      o.frequency.exponentialRampToValueAtTime(tune, t + 0.025);
      decay(g.gain, t, 0.9, dec);
      o.connect(g).connect(dest);
      o.start(t);
      o.stop(t + dec + 0.02);
      const n = noiseSrc(t, 0.03), lp = ac.createBiquadFilter(), ng = ac.createGain();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      decay(ng.gain, t, 0.15 + punch * 0.3, 0.02);
      n.connect(lp).connect(ng).connect(dest);
      return;
    }
    const o = ac.createOscillator(), g = ac.createGain();
    const drop = kit === '909' || kit === 'LOFI' ? 0.035 : kit === 'HARD' ? 0.05 : 0.07;
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
      { name: 'JAZZ', set: { tune: 180, snap: 0.5, dec: 0.2 } },
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
      case 'JAZZ': {
        // a brush: a soft swish of noise that swells in, no drum tone
        const n = noiseSrc(t, dec + 0.1), bp = ac.createBiquadFilter(), g = ac.createGain();
        bp.type = 'bandpass';
        bp.frequency.value = 2500;
        bp.Q.value = 0.7;
        g.gain.setValueAtTime(0.001, t);
        g.gain.exponentialRampToValueAtTime(0.15 + snap * 0.4, t + 0.012);
        g.gain.exponentialRampToValueAtTime(0.001, t + dec);
        n.connect(bp).connect(g).connect(this.dest());
        break;
      }
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
      { name: 'JAZZ', set: { tone: 0.7, dec: 0.05 } },
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
    if (this.kit === 'JAZZ') {
      // thin and soft, close to a shaker, with a gentle attack
      bp.Q.value = 0.5;
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.001, t + dec);
      noiseSrc(t, dec + 0.02).connect(bp);
      return;
    }
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
      { name: 'JAZZ', set: { tone: 1700, dec: 0.05 } },
    ]);
  }

  hit(t: number) {
    const { tone, dec } = this.q(), kit = this.kit;
    if (kit === 'JAZZ') {
      // a cross-stick: the stick laid on the head, clicking on the rim. Woody, short.
      const o = ac.createOscillator(), bp = ac.createBiquadFilter(), g = ac.createGain();
      o.type = 'square';
      o.frequency.value = tone / 2;
      bp.type = 'bandpass';
      bp.frequency.value = tone;
      bp.Q.value = 5;
      decay(g.gain, t, 0.8, dec);
      o.connect(bp).connect(g).connect(this.dest());
      o.start(t);
      o.stop(t + dec + 0.02);
      const n = noiseSrc(t, 0.01), ng = ac.createGain();
      decay(ng.gain, t, 0.3, 0.006);
      n.connect(ng).connect(this.dest());
      return;
    }
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

// ---------------------------------------------------------------- DRUM MACHINE

const DM_ROWS = [
  { name: 'BD', col: C.red }, { name: 'SD', col: C.orange }, { name: 'CH', col: C.yellow },
  { name: 'OH', col: C.cyan }, { name: 'CP', col: C.lime },
];
// Mix level per row.
const DM_LEVELS = [1, 0.8, 0.45, 0.4, 0.7];
const DM_KITS = ['808', '909', 'LOFI', 'JAZZ'];

// A few patterns with open hats, then the TRIG SEQ ones (whose hats become closed hats).
export const DM_PRESETS: GridPreset[] = [
  { name: 'ACID', rows: [[0, 4, 8, 12], [], [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15], [2, 6, 10, 14], [4, 12], [2, 6, 10, 14]] },
  { name: 'JACK', rows: [[0, 4, 8, 12], [4, 12], [0, 2, 4, 6, 8, 10, 12, 14], [2, 6, 10, 14], [], [0, 8]] },
  { name: 'OFFBEAT', rows: [[0, 4, 8, 12], [], [], [2, 6, 10, 14], [4, 12]] },
  ...BEAT_PRESETS.map((b) => ({ name: b.name, rows: [b.rows[0], b.rows[1], b.rows[2], [], b.rows[3]] })),
];

export function drumSteps(name: string) {
  return gridSteps(DM_PRESETS.find((p) => p.name === name)!, DM_ROWS.length);
}

// A complete drum machine in one module: a step grid playing its own kick, snare,
// closed and open hat and clap, on its own tempo. Patch a clock into CLK to follow it
// instead; 16TH sends its steps on, to drive a MELODY or another sequencer.
export class DrumMachine extends StepGrid {
  out = ac.createGain();
  private voices: Drum[];
  private next = 0;
  private n = 0;

  constructor(e: Engine) {
    super(e, 'drums', 'DRUM MACHINE', 166, 110, DM_ROWS, DM_PRESETS);
    this.voices = [new Kick(e), new Snare(e), new HiHat(e), new HiHat(e), new Clap(e)];
    this.voices.forEach((v, r) => {
      const g = ac.createGain();
      g.gain.value = DM_LEVELS[r];
      v.out.connect(g).connect(this.out);
    });
    this.port('out', 'OUT', 'audio', 'out', 151, 12);
    this.port('sync', '16TH', 'trig', 'out', 151, 33);
    const y = this.barY + 12;
    [
      { id: 'bpm', label: 'BPM', min: 60, max: 200, def: 124, step: 1 },
      { id: 'swing', label: 'SWG', min: 0, max: 0.5, def: 0, fmt: pct },
      { id: 'len', label: 'LEN', min: 1, max: 16, def: 16, step: 1 },
      { id: 'kit', label: 'KIT', min: 0, max: 2, def: 1, names: DM_KITS },
      { id: 'vol', label: 'VOL', min: 0, max: 1.5, def: 1, fmt: pct },
    ].forEach((k, i) => this.knob({ ...k, x: 26 + i * 18, y }));
  }

  onParam(id: string, v: number) {
    if (id === 'vol') this.out.gain.setTargetAtTime(v, ac.currentTime, 0.01);
    if (id !== 'kit' || !this.voices) return;
    this.voices.forEach((d, r) => {
      const kit = Math.max(0, d.kits.findIndex((k) => k.name === DM_KITS[v]));
      d.set('kit', kit);
      for (const [k, val] of Object.entries(d.kits[kit].set)) d.set(k, val);
      // the second hat is the open one
      if (r === 3) d.set('dec', 0.35);
    });
  }

  reset(t0: number) {
    super.reset(t0);
    this.next = t0;
    this.n = 0;
  }

  // Runs on its own BPM unless a clock is patched into CLK.
  schedule(until: number) {
    if (this.eng.cablesAt(this, 'clk').length) return;
    if (this.next < ac.currentTime - 0.2) this.next = ac.currentTime + 0.02;
    while (this.next < until) {
      const dur = 15 / this.p.bpm;
      this.play({ t: this.next + (this.n % 2 ? this.p.swing * dur : 0), dur });
      this.n++;
      this.next += dur;
    }
  }

  protected clock(ev: Ev) { this.play(ev); }

  protected layout(adv: boolean) {
    for (const id of ['bpm', 'swing', 'len', 'kit', 'vol']) this.knobById(id).y = this.barY + (adv ? 23 : 12);
  }

  private play(ev: Ev) {
    this.emit('sync', ev);
    this.step(ev, (r, out) => this.voices[r].onEvent('in', out));
  }

  audioOut() { return this.out; }
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

// How fast a slide glides to its note (time constant, seconds).
const SLIDE_TC = 0.025;

interface MelPat { n: number[]; a: boolean[]; s: boolean[] }

export class Melody extends Mod {
  bank = new Bank<MelPat>(() => Melody.parse(null));
  pit = cvSource();
  // TRN is added to the sequence's pitch: KEYS or another sequencer transposes it.
  trn = ac.createGain();
  pitOut = ac.createGain();
  patTap = new CvTap();
  accCv = cvSource();
  private pos = -1;
  private shown = -1;
  private shownPat = 0;
  private preset = -1;
  private resetAt = Infinity;

  constructor(e: Engine) {
    super(e, 'melody', 'MELODY', 'seq', 160, 102);
    this.advanced('ADVANCED', 160, 123);
    this.p.chain = 1;
    this.port('clk', 'CLK', 'trig', 'in', 4, 12);
    this.port('trn', 'TRN', 'cv', 'in', 4, 73);
    this.pit.connect(this.pitOut);
    this.trn.connect(this.pitOut);
    this.port('pit', 'PIT', 'cv', 'out', 147, 12);
    this.port('gate', 'GAT', 'trig', 'out', 147, 33);
    this.port('acc', 'ACC', 'cv', 'out', 147, 54);
    this.knob({ id: 'len', label: 'LEN', x: 4, y: 31, min: 1, max: 16, def: 16, step: 1 });
    this.knob({ id: 'root', label: 'KEY', x: 26, y: 80, min: 0, max: 11, def: 0, names: NOTE_NAMES });
    this.knob({ id: 'scale', label: 'SCL', x: 42, y: 80, min: 0, max: 3, def: 1, names: SCALE_NAMES });
    this.knob({ id: 'oct', label: 'OCT', x: 58, y: 80, min: 1, max: 5, def: 2, step: 1 });
    this.knob({ id: 'gate', label: 'GAT', x: 74, y: 80, min: 0.1, max: 1, def: 0.5, fmt: pct });
    this.advOnly(() => {
      this.port('rst', 'RST', 'trig', 'in', 4, 52);
      this.port('pat', 'PAT', 'cv', 'in', 4, 94);
    });
  }

  // The pattern being edited.
  get notes() { return this.bank.cur.d.n; }
  get acc() { return this.bank.cur.d.a; }
  get slide() { return this.bank.cur.d.s; }

  // The advanced layout adds the chance and ratchet rows, pushing the controls down.
  private get dy() { return this.isAdv ? 10 : 0; }

  protected layout() {
    for (const id of ['root', 'scale', 'oct', 'gate']) this.knobById(id).y = 80 + this.dy;
  }

  audioIn(port: string) { return port === 'pat' ? this.patTap.in : this.trn; }
  audioOut(port: string) { return port === 'acc' ? this.accCv : this.pitOut; }
  destroy() { this.pit.stop(); this.accCv.stop(); }

  private semi(r: number) {
    const sc = SCALES[this.p.scale];
    return sc[r % sc.length] + 12 * Math.floor(r / sc.length);
  }

  private rowY(r: number) { return 16 + (7 - r) * 6; }

  private colAt(lx: number) {
    for (let c = 0; c < 16; c++) {
      const x = cellX(c);
      if (lx >= x && lx < x + 7) return c;
    }
    return -1;
  }

  // A note cell, or a cell in the accent / slide (and chance / ratchet) rows.
  private cellAt(lx: number, ly: number): { r: number | 'a' | 's' | 'p' | 't'; c: number } | null {
    const c = this.colAt(lx);
    if (c < 0) return null;
    if (ly >= 66 && ly < 71) return { r: 'a', c };
    if (ly >= 71 && ly < 76) return { r: 's', c };
    if (this.isAdv && ly >= 76 && ly < 81) return { r: 'p', c };
    if (this.isAdv && ly >= 81 && ly < 86) return { r: 't', c };
    const r = 7 - Math.floor((ly - 16) / 6);
    if (r < 0 || r > 7 || ly < 16) return null;
    return { r, c };
  }

  reset() { this.pos = -1; this.shown = -1; this.bank.reset(); this.resetAt = Infinity; }

  onEvent(port: string, ev: Ev) {
    if (ev.off) return;
    if (port === 'rst') { this.resetAt = ev.t; return; }
    if (port !== 'clk') return;
    if (ev.t >= this.resetAt - 0.001) { this.pos = -1; this.bank.reset(); this.resetAt = Infinity; }
    const len = this.p.len;
    const s = (this.pos = (this.pos + 1) % len);
    if (s === 0) this.bank.wrap(patIn(this, ev.t));
    const i = this.bank.playing(this.p.chain, this.isAdv), pat = this.bank.pats[i].d;
    this.eng.at(ev.t, () => { this.shown = s; this.shownPat = i; });
    const r = pat.n[s], hits = r < 0 ? 0 : this.bank.hits(i, s, this.isAdv);
    if (!hits) return;
    // A slide on the next step keeps this note held so the synth can glide into it.
    const next = (s + 1) % len;
    const tie = pat.s[next] && pat.n[next] >= 0;
    const note = 12 * (this.p.oct + 1) + this.p.root + this.semi(r);
    const v = (note - PITCH_REF) / 12, acc = pat.a[s], slide = pat.s[s];
    if (slide) this.pit.offset.setTargetAtTime(v, ev.t, SLIDE_TC);
    else this.pit.offset.setValueAtTime(v, ev.t);
    this.accCv.offset.setValueAtTime(acc ? 1 : 0, ev.t);
    const each = ev.dur / hits;
    for (let k = 0; k < hits; k++) {
      const dur = k === hits - 1 && tie ? each * 1.05 : each * this.p.gate;
      this.emit('gate', { t: ev.t + k * each, dur, acc, slide: k === 0 && slide });
    }
  }

  drawBody(g: Gfx) {
    const len = this.p.len, dy = this.dy, shown = this.shownPat === this.bank.edit ? this.shown : -1;
    for (let c = 0; c < len; c++) {
      g.rect(cellX(c), 13, 6, 2, c === shown ? C.lime : C.black);
    }
    const sl = SCALES[this.p.scale].length;
    for (let r = 0; r < 8; r++) {
      const y = this.rowY(r);
      g.text(NOTE_NAMES[(this.p.root + this.semi(r)) % 12], 16, y, r % sl === 0 ? C.yellow : C.slate);
      for (let c = 0; c < 16; c++) {
        const x = cellX(c), cur = c === shown;
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
      const x = cellX(c), off = c >= len ? C.black : C.ink;
      g.rect(x, 66, 6, 4, this.acc[c] ? C.white : off);
      g.rect(x, 71, 6, 4, this.slide[c] ? C.sky : off);
    }
    if (this.isAdv) {
      g.text('PR', 16, 75, C.lime);
      g.text('RT', 16, 80, C.cyan);
      drawBars(g, 76, 4, this.bank.cur.pr, 4, C.lime, len, shown);
      drawBars(g, 81, 4, this.bank.cur.rt, 1, C.cyan, len, shown);
      drawPatRow(g, 111, this.bank.edit, this.eng.running ? this.shownPat : -1, this.p.chain);
    }
    drawPresetBar(g, 104, 79 + dy, this.preset < 0 ? 'PRESET' : MELODY_PRESETS[this.preset].name, 54);
    drawButton(g, 104, 90 + dy, 25, 'RND', C.yellow);
    drawButton(g, 131, 90 + dy, 25, 'CLR', C.silver);
  }

  press(lx: number, ly: number): Drag | null {
    const dy = this.dy, d = this.bank.cur.d;
    const dir = presetStep(lx, ly, 104, 79 + dy, 54);
    if (dir) {
      const n = MELODY_PRESETS.length;
      this.preset = (((this.preset < 0 && dir < 0 ? 0 : this.preset) + dir) % n + n) % n;
      const pre = MELODY_PRESETS[this.preset];
      this.bank.cur.d = Melody.parse(melodyState(pre.name));
      this.set('scale', pre.scale);
      return noDrag;
    }
    if (inBtn(lx, ly, 104, 90 + dy, 25)) {
      d.n = d.n.map(() => (Math.random() < 0.7 ? Math.floor(Math.random() ** 1.6 * 8) : -1));
      d.a = d.a.map(() => Math.random() < 0.2);
      d.s = d.s.map(() => Math.random() < 0.15);
      this.eng.dirty = true;
      return noDrag;
    }
    if (inBtn(lx, ly, 131, 90 + dy, 25)) {
      this.bank.cur.d = Melody.parse(null);
      this.eng.dirty = true;
      return noDrag;
    }
    if (this.isAdv) {
      const hit = patRowHit(lx, ly, 111);
      if (hit === 'chain') this.set('chain', (this.p.chain % 4) + 1);
      else if (hit !== null) { this.bank.edit = hit; this.eng.dirty = true; }
      if (hit !== null) return noDrag;
    }
    const first = this.cellAt(lx, ly);
    if (!first) return null;
    if (first.r === 'p' || first.r === 't') {
      // chance or ratchet row: step the value, then paint it along a drag
      const vals = first.r === 'p' ? this.bank.cur.pr : this.bank.cur.rt;
      const val = (first.r === 'p' ? nextChance : nextRatchet)(vals[first.c]);
      const apply = (c: number) => { if (c >= 0) { vals[c] = val; this.eng.dirty = true; } };
      apply(first.c);
      return { move: (x) => apply(this.colAt(x)) };
    }
    if (first.r === 'a' || first.r === 's') {
      const row = first.r === 'a' ? d.a : d.s;
      const val = !row[first.c];
      const apply = (c: number) => { if (c >= 0) { row[c] = val; this.eng.dirty = true; } };
      apply(first.c);
      return { move: (x) => apply(this.colAt(x)) };
    }
    const erase = d.n[first.c] === first.r;
    const apply = (cell: { r: number | string; c: number } | null) => {
      if (!cell || typeof cell.r !== 'number') return;
      d.n[cell.c] = erase ? -1 : cell.r;
      this.eng.dirty = true;
    };
    apply(first);
    return { move: (x, y) => apply(this.cellAt(x, y)) };
  }

  // Shift+click a pattern button: copy the edited pattern there and edit the copy.
  pressShift(lx: number, ly: number) {
    const hit = this.isAdv ? patRowHit(lx, ly, 111) : null;
    if (typeof hit !== 'number') return false;
    this.bank.copy(this.bank.edit, hit);
    this.bank.edit = hit;
    this.eng.dirty = true;
    return true;
  }

  // A saved pattern { n, a, s } (or, from older patches, just the notes array).
  static parse(x: unknown): MelPat {
    const st = (Array.isArray(x) ? { n: x } : x ?? {}) as { n?: unknown[]; a?: string; s?: string };
    const n = Array.isArray(st.n) ? st.n : [];
    const bits = (b?: string) => Array.from({ length: 16 }, (_, i) => b?.[i] === '1');
    return {
      n: Array.from({ length: 16 }, (_, i) => (typeof n[i] === 'number' ? (n[i] as number) : -1)),
      a: bits(st.a),
      s: bits(st.s),
    };
  }

  save() {
    const bits = (b: boolean[]) => b.map((x) => (x ? '1' : '0')).join('');
    const out = (d: MelPat) => ({ n: d.n, a: bits(d.a), s: bits(d.s) });
    const empty = (d: MelPat) => d.n.every((v) => v < 0) && !d.a.includes(true) && !d.s.includes(true);
    return this.bank.plain(empty) ? out(this.bank.pats[0].d) : this.bank.save(out);
  }

  load(s: unknown) {
    if (!this.bank.load(s, Melody.parse)) this.bank.pats[0].d = Melody.parse(s);
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

// Pitch bend output: full bend is +-2 semitones in pitch CV (1 per octave).
const BEND_RANGE = 2 / 12;

function cvSource() {
  const s = ac.createConstantSource();
  s.offset.value = 0;
  s.start();
  return s;
}

// Monophonic, like a keyboard on a modular: the newest key held sets the pitch and
// retriggers the gate; letting it go glides back to a key still held, without a new
// gate. The gate closes when the last key is up (and the sustain pedal, if down, is up).
export class Keys extends Mod {
  private held: number[] = []; // in the order they went down
  private byCode = new Map<string, number>();
  private flash = 0;
  private pedal = false;
  private gateOpen = false;
  pit = cvSource();
  vel = cvSource();
  mod = cvSource();
  bend = cvSource();
  touch = cvSource();
  private unlisten: () => void;

  constructor(e: Engine) {
    super(e, 'keys', 'KEYS', 'seq', 152, 60);
    this.port('pit', 'PIT', 'cv', 'out', 107, 12);
    this.port('gate', 'GAT', 'trig', 'out', 122, 12);
    this.port('vel', 'VEL', 'cv', 'out', 137, 12);
    this.port('mod', 'MOD', 'cv', 'out', 107, 33);
    this.port('bend', 'BND', 'cv', 'out', 122, 33);
    this.port('touch', 'AT', 'cv', 'out', 137, 33);
    this.knob({ id: 'oct', label: 'OCT', x: 4, y: 38, min: 0, max: 6, def: 3, step: 1 });
    this.unlisten = midi.on((d, t) => this.midiIn(d, t));
  }

  private base() { return 12 * (this.p.oct + 1); }

  private setPitch(n: number, t: number) { this.pit.offset.setValueAtTime((n - PITCH_REF) / 12, t); }

  noteOn(n: number, vel?: number, t = ac.currentTime + 0.005) {
    if (this.held.includes(n)) return;
    this.held.push(n);
    this.flash = now();
    this.setPitch(n, t);
    this.vel.offset.setValueAtTime(vel ?? 1, t);
    this.gateOpen = true;
    this.emit('gate', { t, dur: 0, hold: true, vel });
  }

  noteOff(n: number, t = ac.currentTime + 0.005) {
    const i = this.held.indexOf(n);
    if (i < 0) return;
    this.held.splice(i, 1);
    const top = this.held[this.held.length - 1];
    if (top !== undefined) { if (i === this.held.length) this.setPitch(top, t); return; }
    if (!this.pedal) this.closeGate(t);
  }

  private closeGate(t: number) {
    if (!this.gateOpen) return;
    this.gateOpen = false;
    this.emit('gate', { t, dur: 0, off: true });
  }

  private setPedal(down: boolean, t: number) {
    this.pedal = down;
    if (!down && !this.held.length) this.closeGate(t);
  }

  allOff() {
    this.held = [];
    this.pedal = false;
    this.closeGate(ac.currentTime + 0.005);
    this.byCode.clear();
  }

  private midiIn(d: Uint8Array, t: number) {
    const [st, d1 = 0, d2 = 0] = d, cmd = st & 0xf0;
    const at = Math.max(t, ac.currentTime) + 0.005;
    const glide = (p: AudioParam, v: number) => p.setTargetAtTime(v, at, 0.01);
    if (cmd === 0x90 && d2 > 0) this.noteOn(d1, d2 / 127, at);
    else if (cmd === 0x80 || cmd === 0x90) this.noteOff(d1, at);
    else if (cmd === 0xb0 && d1 === 1) glide(this.mod.offset, d2 / 127);
    else if (cmd === 0xb0 && d1 === 64) this.setPedal(d2 >= 64, at);
    else if (cmd === 0xe0) glide(this.bend.offset, ((((d2 << 7) | d1) - 8192) / 8192) * BEND_RANGE);
    else if (cmd === 0xd0) glide(this.touch.offset, d1 / 127);
    else if (cmd === 0xa0) glide(this.touch.offset, d2 / 127);
  }

  audioOut(port: string) {
    return ({ pit: this.pit, vel: this.vel, mod: this.mod, bend: this.bend, touch: this.touch } as Record<string, AudioNode>)[port] ?? null;
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
        const down = this.held.includes(base + oct * 12 + semi);
        g.rect(ox + i * 7, 12, 6, 22, down ? C.yellow : C.white);
        g.rect(ox + i * 7, 33, 6, 1, C.silver);
        if (semi === 0) g.textC(String(this.p.oct + oct), ox + i * 7 + 3, 27, C.silver);
      });
      for (const [semi, after] of BLACK) {
        const down = this.held.includes(base + oct * 12 + semi);
        g.rect(ox + after * 7 + 5, 12, 5, 13, down ? C.yellow : C.black);
      }
    }
    drawButton(g, 20, 40, 22, 'MIDI', midi.enabled ? C.lime : C.silver);
    led(g, 47, 42, now() - this.flash < 90, C.yellow);
    g.text('PLAY: A-K', 56, 40, C.slate);
    g.text('OCT: Z X', 56, 47, C.slate);
  }

  press(lx: number, ly: number): Drag | null {
    if (inBtn(lx, ly, 20, 40, 22)) { void midi.enable(); return noDrag; }
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
    this.unlisten();
    for (const s of [this.pit, this.vel, this.mod, this.bend, this.touch]) s.stop();
  }
}

// ---------------------------------------------------------------- PADS

const PADS = 4;
const PAD_MODES = ['TRG', 'GAT', 'LAT'];
const [TRG, GAT, LAT] = [0, 1, 2];
// Quantize: how many CLK triggers (16ths) between the points a press may land on.
const PAD_Q = ['OFF', '16TH', 'BEAT', 'BAR'];
const PAD_QN = [0, 1, 4, 16];
// An unquantized TRG gate, and the shortest gate a quick tap makes.
const PAD_TRG = 0.1;
const PAD_MIN = 0.03;
const padX = (i: number) => 3 + i * 15;

// Four pads to play by hand, with the mouse, the keys 1-4 or (+) MIDI. Each pad's mode:
// TRG fires one gate per press, GAT stays open while held, LAT toggles on and off on
// each press (and is saved with the patch). +: CLK and Q hold a press back to the next
// 16th, beat or bar, counted from PLAY; a CV out per pad gives 0 or 1; Alt+click a pad,
// then press a MIDI key or button, to map it.
export class Pads extends Mod {
  cvs = Array.from({ length: PADS }, () => cvSource());
  private open = Array.from({ length: PADS }, () => false); // a GAT or LAT gate is open
  private openAt = Array.from({ length: PADS }, () => 0);
  private down = Array.from({ length: PADS }, () => false); // held by hand right now
  private pending: (number | null)[] = Array.from({ length: PADS }, () => null); // action waiting for the grid
  private upEarly = Array.from({ length: PADS }, () => false); // a GAT let go before it opened
  private flash = Array.from({ length: PADS }, () => -1e9);
  private ticks = 0;
  private lastQ = -1; // time of the latest grid point CLK has scheduled
  private tick = 0.125;
  private learning = -1;
  private unlisten: () => void;

  constructor(e: Engine) {
    super(e, 'pads', 'PADS', 'seq', 64, 56);
    for (let i = 0; i < PADS; i++) {
      this.p['m' + i] = TRG;
      this.p['on' + i] = 0;
      this.p['midi' + i] = -1;
      this.port('g' + i, 'OUT', 'trig', 'out', padX(i) + 2, 37);
    }
    this.advanced('ADVANCED', 79, 77);
    this.advOnly(() => {
      this.port('clk', 'CLK', 'trig', 'in', 65, 14);
      this.knob({ id: 'q', label: 'Q', x: 64, y: 37, min: 0, max: PAD_Q.length - 1, def: 0, names: PAD_Q });
      for (let i = 0; i < PADS; i++) this.port('c' + i, 'CV', 'cv', 'out', padX(i) + 2, 57);
    });
    this.unlisten = midi.on((d, t) => this.midiIn(d, t));
  }

  private mode(i: number) { return this.p['m' + i]; }

  // Presses wait for the grid only with + open, Q set, a clock patched and PLAY on.
  private quantized() {
    return this.isAdv && this.p.q > 0 && this.eng.running && this.eng.cablesAt(this, 'clk').length > 0;
  }

  private padDown(i: number) {
    if (this.down[i]) return;
    this.down[i] = true;
    this.upEarly[i] = false;
    this.request(i, this.mode(i));
  }

  private padUp(i: number) {
    if (!this.down[i]) return;
    this.down[i] = false;
    if (this.mode(i) !== GAT) return;
    if (this.pending[i] !== null) { this.upEarly[i] = true; return; }
    if (this.open[i]) this.close(i, Math.max(ac.currentTime + 0.005, this.openAt[i] + PAD_MIN));
  }

  private request(i: number, action: number) {
    const now = ac.currentTime + 0.005;
    if (!this.quantized()) this.run(i, action, now);
    // CLK schedules ahead: a grid point it already sent may still be in the future.
    else if (this.lastQ > now) this.run(i, action, this.lastQ);
    else this.pending[i] = action;
  }

  private run(i: number, action: number, t: number) {
    this.pending[i] = null;
    this.eng.at(t, () => (this.flash[i] = now()));
    if (action === TRG) {
      const dur = this.quantized() ? this.tick : PAD_TRG;
      this.emit('g' + i, { t, dur });
      this.level(i, 1, t);
      this.level(i, 0, t + dur);
    } else if (action === GAT) {
      this.openGate(i, t);
      if (this.upEarly[i]) { this.upEarly[i] = false; this.close(i, t + Math.max(PAD_MIN, this.quantized() ? this.tick : 0)); }
    } else {
      // The gate moves first, at t; then the saved state follows.
      const on = this.p['on' + i] ? 0 : 1;
      if (on) this.openGate(i, t);
      else this.close(i, t);
      this.set('on' + i, on);
    }
  }

  private openGate(i: number, t: number) {
    if (this.open[i]) return;
    this.open[i] = true;
    this.openAt[i] = t;
    this.emit('g' + i, { t, dur: 0, hold: true });
    this.level(i, 1, t);
  }

  private close(i: number, t: number) {
    if (!this.open[i]) return;
    this.open[i] = false;
    this.emit('g' + i, { t, dur: 0, off: true });
    this.level(i, 0, t);
  }

  // CV outs glide for a few milliseconds so they don't click a VCA.
  private level(i: number, v: number, t: number) { this.cvs[i].offset.setTargetAtTime(v, t, 0.003); }

  onEvent(port: string, ev: Ev) {
    if (port !== 'clk' || ev.off || !this.isAdv) return;
    this.tick = ev.dur || this.tick;
    const n = PAD_QN[Math.round(this.p.q)] || 1;
    if (this.ticks++ % n !== 0) return;
    this.lastQ = ev.t;
    for (let i = 0; i < PADS; i++) if (this.pending[i] !== null) this.run(i, this.pending[i]!, ev.t);
  }

  reset(t0: number) {
    this.ticks = 0;
    this.lastQ = -1;
    this.pending.fill(null);
    // Pads latched on open their gates again on PLAY, after every module has reset.
    if (t0) queueMicrotask(() => {
      for (let i = 0; i < PADS; i++) if (this.open[i]) this.emit('g' + i, { t: t0, dur: 0, hold: true });
    });
  }

  onParam(id: string) {
    const m = /^(m|on)(\d)$/.exec(id);
    if (!m) return;
    const i = Number(m[2]), t = ac.currentTime + 0.005;
    // Leaving a mode lets go of what it held.
    if (m[1] === 'm') {
      this.pending[i] = null;
      this.down[i] = false;
      if (this.p['on' + i]) this.set('on' + i, 0);
      this.close(i, t);
    // A latch set from outside (loading a patch) opens or closes its gate now.
    } else if (this.mode(i) === LAT) {
      if (this.p[id]) this.openGate(i, t);
      else this.close(i, t);
    }
  }

  // Keys 1-4; returns whether the key was used.
  key(code: string, isDown: boolean) {
    const i = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(code);
    if (i < 0) return false;
    if (isDown) this.padDown(i);
    else this.padUp(i);
    return true;
  }

  allOff() { for (let i = 0; i < PADS; i++) this.padUp(i); }

  // A mapped MIDI note plays its pad; a mapped CC presses it at 64 and up.
  private midiIn(d: Uint8Array, _t: number) {
    const [st, d1 = 0, d2 = 0] = d, cmd = st & 0xf0;
    const note = cmd === 0x90 || cmd === 0x80, cc = cmd === 0xb0;
    if (!note && !cc) return;
    const code = cc ? 1000 + d1 : d1, press = cmd !== 0x80 && d2 > 0, on = cc ? d2 >= 64 : press;
    if (this.learning >= 0 && press) {
      this.set('midi' + this.learning, code);
      this.learning = -1;
      return;
    }
    if (!this.isAdv) return;
    for (let i = 0; i < PADS; i++) {
      if (this.p['midi' + i] !== code) continue;
      if (on) this.padDown(i);
      else this.padUp(i);
    }
  }

  private padAt(lx: number, ly: number) {
    for (let i = 0; i < PADS; i++) if (lx >= padX(i) && lx < padX(i) + 13 && ly >= 12 && ly < 25) return i;
    return -1;
  }

  press(lx: number, ly: number): Drag | null {
    for (let i = 0; i < PADS; i++) {
      if (inBtn(lx, ly, padX(i), 26, 13)) {
        this.set('m' + i, (this.mode(i) + 1) % PAD_MODES.length);
        return noDrag;
      }
    }
    const i = this.padAt(lx, ly);
    if (i < 0) return null;
    this.padDown(i);
    return { move() {}, up: () => this.padUp(i) };
  }

  // +: Alt+click a pad to map it to the next MIDI note or button; again to unmap it.
  pressAlt(lx: number, ly: number) {
    const i = this.padAt(lx, ly);
    if (i < 0 || !this.isAdv) return false;
    if (this.learning === i) this.learning = -1;
    else if (this.p['midi' + i] >= 0) this.set('midi' + i, -1);
    else { this.learning = i; void midi.enable(); }
    return true;
  }

  drawBody(g: Gfx) {
    const blink = Math.floor(now() / 250) % 2 === 0;
    for (let i = 0; i < PADS; i++) {
      const x = padX(i), lit = this.open[i] || now() - this.flash[i] < 90;
      g.rect(x, 12, 13, 13, C.black);
      g.rect(x + 1, 13, 11, 11, lit ? C.yellow : C.slate);
      g.rect(x + 1, 13, 11, 1, lit ? C.white : C.silver);
      g.textC(String(i + 1), x + 7, 16, lit ? C.ink : C.dark);
      // Waiting for the grid, or for a MIDI control to learn.
      if ((this.pending[i] !== null && blink) || (this.learning === i && blink)) {
        g.frame(x - 1, 11, 15, 15, this.learning === i ? C.sky : C.yellow);
      }
      if (this.isAdv && this.p['midi' + i] >= 0) g.rect(x + 10, 13, 2, 2, C.sky);
      const m = this.mode(i);
      drawButton(g, x, 26, 13, PAD_MODES[m], m === LAT ? C.lime : m === GAT ? C.cyan : C.yellow);
    }
  }

  audioOut(port: string) { return port.startsWith('c') ? this.cvs[Number(port.slice(1))] ?? null : null; }

  destroy() {
    this.unlisten();
    for (const s of this.cvs) s.stop();
  }
}

// ---------------------------------------------------------------- SYNTH

const WAVES: OscillatorType[] = ['sawtooth', 'square', 'triangle', 'sine'];

// A one-oscillator voice with its own filter and envelopes: give it a pitch CV and gates.
// Each gate starts a voice; the pitch CV moves every sounding voice, sample-accurately.
// The amp rises over ATK, holds while the gate is open, and fades over REL after it.
export class Synth extends Mod {
  out = ac.createGain();
  cv = ac.createGain();
  pitch = ac.createGain();

  constructor(e: Engine) {
    super(e, 'synth', 'SYNTH', 'synth', 64, 74);
    this.knobRow([
      { id: 'wave', label: 'WAV', min: 0, max: 3, def: 0, names: ['SAW', 'SQR', 'TRI', 'SIN'] },
      { id: 'oct', label: 'OCT', min: -2, max: 2, def: 0, step: 1, fmt: (v) => (v > 0 ? '+' : '') + v },
      { id: 'cut', label: 'CUT', min: 0, max: 1, def: 0.35, fmt: hz },
      { id: 'res', label: 'RES', min: 0, max: 20, def: 6, fmt: (v) => v.toFixed(1) },
    ], 13);
    // The defaults (4 ms, 78 ms) are the fixed amp shape SYNTH had before ATK and REL.
    const time = (v: number) => ms(envSec(v));
    this.knobRow([
      { id: 'env', label: 'ENV', min: 0, max: 1, def: 0.6, fmt: pct },
      { id: 'dec', label: 'DEC', min: 0.05, max: 1.5, def: 0.3, fmt: ms },
      { id: 'atk', label: 'ATK', min: 0, max: 1, def: 0.1, fmt: time },
      { id: 'rel', label: 'REL', min: 0, max: 1, def: 0.53, fmt: time },
    ], 33);
    this.cv.gain.value = CV_CENTS;
    // 1 per octave, like OSC.
    this.pitch.gain.value = 1200;
    this.port('pit', 'PIT', 'cv', 'in', 5, 53);
    this.port('gate', 'GAT', 'trig', 'in', 20, 53);
    this.port('cv', 'CUT', 'cv', 'in', 35, 53);
    this.port('out', 'OUT', 'audio', 'out', 50, 53);
    // Advanced: a CV jack under each knob of the second row, and one beside RES.
    this.advanced('ADVANCED', 79, 92);
    this.cvKnob('res', 65, 13);
    for (const id of ['env', 'dec', 'atk', 'rel']) this.cvKnob(id, this.knobById(id).x + 1, 73);
  }

  audioIn(port: string) { return port === 'pit' ? this.pitch : this.cv; }
  audioOut() { return this.out; }

  // The voice started last (a slide carries it on), and the one a live gate is holding.
  private last: Voice | null = null;
  private live: Voice | null = null;

  onEvent(_port: string, ev: Ev) {
    if (ev.off) {
      if (this.live) { release(this.live, ev.t, envSec(this.val('rel'))); this.live = null; }
      return;
    }
    const { wave, oct, cut } = this.p, res = this.val('res'), env = this.val('env'), dec = this.val('dec');
    const atk = envSec(this.val('atk')), rel = envSec(this.val('rel'));
    const t = ev.t, dur = ev.hold ? HOLD : Math.max(0.02, ev.dur);
    const peak = 0.35 * (ev.acc ? 1.4 : 1) * velGain(ev.vel);

    // Slide: keep the still-sounding voice going, with no new attack; the pitch CV glides.
    const old = this.last;
    if (ev.slide && old && old.end > t) {
      // Mid-attack it keeps rising, now towards the new peak.
      const lv = t < old.start + old.atk ? level(old, t) : peak;
      old.g.gain.cancelScheduledValues(t);
      old.g.gain.setValueAtTime(lv, t);
      old.peak = peak;
      hold(old, t, t + dur, rel);
      return;
    }
    // A new live gate takes over from the one being held.
    if (this.live) { release(this.live, t, rel); this.live = null; }

    const o = ac.createOscillator(), fl = ac.createBiquadFilter(), g = ac.createGain();
    o.type = WAVES[wave];
    o.frequency.value = 440 * 2 ** ((PITCH_REF - 69) / 12 + oct);
    fl.type = 'lowpass';
    fl.Q.value = res;
    const base = cutHz(cut), amt = Math.min(1, env + (ev.acc ? 0.35 : 0));
    fl.frequency.setValueAtTime(Math.min(18000, base * (1 + amt * 16)), t);
    fl.frequency.exponentialRampToValueAtTime(base, t + dec);
    g.gain.setValueAtTime(0, t);
    o.connect(fl).connect(g).connect(this.out);
    this.pitch.connect(o.detune);
    this.cv.connect(fl.detune);
    o.onended = () => {
      this.pitch.disconnect(o.detune);
      this.cv.disconnect(fl.detune);
    };
    o.start(t);
    const v: Voice = { o, g, end: 0, start: t, atk, peak };
    hold(v, t, t + dur, rel);
    this.last = v;
    if (ev.hold) this.live = v;
  }
}

// `end` is when the gate closes; the attack rises linearly from `start`, over `atk`, to `peak`.
interface Voice { o: OscillatorNode; g: GainNode; end: number; start: number; atk: number; peak: number }

// The level a voice's attack has reached at t.
const level = (v: Voice, t: number) => v.peak * Math.min(1, Math.max(0, (t - v.start) / v.atk));

// How long a live (held) note may ring before it stops by itself.
const HOLD = 60;

// From `from` (the gain already set there), finish the attack and hold until `end`,
// then fade out over rel. A gate shorter than the attack releases from where it got to.
function hold(v: Voice, from: number, end: number, rel: number) {
  const top = v.start + v.atk, g = v.g.gain;
  if (from < top && end > top) g.linearRampToValueAtTime(v.peak, top);
  const lv = Math.max(0.001, level(v, end));
  if (from < top && end <= top) g.linearRampToValueAtTime(lv, end);
  else g.setValueAtTime(lv, end);
  g.exponentialRampToValueAtTime(0.001, end + rel);
  v.o.stop(end + rel + 0.02);
  v.end = end;
}

// A live gate-off: fade out over rel from wherever the voice is now.
function release(v: Voice, t: number, rel: number) {
  const g = v.g.gain;
  g.cancelScheduledValues(t);
  g.setValueAtTime(Math.max(0.001, level(v, t)), t);
  g.exponentialRampToValueAtTime(0.001, t + rel);
  v.o.stop(t + rel + 0.02);
  v.end = t;
}

// ---------------------------------------------------------------- MIXER

// Four channels with levels; BIG makes it eight, each with stereo pan.
export class Mixer extends Mod {
  ins = Array.from({ length: 8 }, () => ac.createGain());
  pans = this.ins.map((g) => g.connect(ac.createStereoPanner()) as StereoPannerNode);
  out = ac.createGain();

  constructor(e: Engine) {
    super(e, 'mixer', 'MIXER', 'util', 64, 66);
    this.advanced('BIG', 142, 84);
    const panFmt = (v: number) => (Math.abs(v) < 0.02 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100));
    this.ins.forEach((_, c) => {
      this.pans[c].connect(this.out);
      const add = () => {
        this.port('i' + c, String(c + 1), 'audio', 'in', 0, 13);
        this.knob({ id: 'l' + c, label: '', x: 0, y: 30, min: 0, max: 1, def: 0.8, fmt: pct });
      };
      if (c < 4) add(); else this.advOnly(add);
    });
    this.advOnly(() => this.ins.forEach((_, c) =>
      this.knob({ id: 'p' + c, label: '', name: 'PAN', x: 0, y: 45, min: -1, max: 1, def: 0, fmt: panFmt })));
    this.knob({ id: 'vol', label: 'VOL', x: 0, y: 0, min: 0, max: 1.5, def: 1, fmt: pct });
    this.port('out', 'OUT', 'audio', 'out', 0, 0);
    // Mute ('mu') and solo ('so') per channel: click / shift+click the channel number.
    this.ins.forEach((_, c) => { this.p['mu' + c] = 0; this.p['so' + c] = 0; });
    this.layout(false);
  }

  private get chans() { return this.isAdv ? 8 : 4; }

  // A channel plays at its level unless it is muted, or another channel is soloed.
  private levels() {
    // (Not until the constructor has made every channel.)
    if (this.p.mu0 === undefined) return;
    const t = ac.currentTime, n = this.chans;
    const solo = this.ins.some((_, c) => c < n && this.p['so' + c]);
    this.ins.forEach((g, c) => {
      const on = !this.p['mu' + c] && (!solo || this.p['so' + c]);
      g.gain.setTargetAtTime(on ? this.p['l' + c] : 0, t, 0.01);
    });
  }

  // The channel number under a jack, if lx, ly is on one.
  private numAt(lx: number, ly: number) {
    if (ly < 23 || ly > 29) return -1;
    for (let c = 0; c < this.chans; c++) {
      const x = this.portById('i' + c).x;
      if (lx >= x && lx < x + 9) return c;
    }
    return -1;
  }

  press(lx: number, ly: number): Drag | null {
    const c = this.numAt(lx, ly);
    if (c < 0) return null;
    this.set('mu' + c, this.p['mu' + c] ? 0 : 1);
    return noDrag;
  }

  pressShift(lx: number, ly: number) {
    const c = this.numAt(lx, ly);
    if (c < 0) return false;
    this.set('so' + c, this.p['so' + c] ? 0 : 1);
    return true;
  }

  // Big: a LVL / PAN label column on the left, the master row at the bottom.
  protected layout(big: boolean) {
    const x0 = big ? 18 : 4;
    this.ins.forEach((_, c) => {
      this.portById('i' + c).x = x0 + 1 + c * 15;
      this.knobById('l' + c).x = x0 + c * 15;
      this.knobById('p' + c).x = x0 + c * 15;
      // Panning only applies in the big layout.
      this.pans[c].pan.setTargetAtTime(big ? this.p['p' + c] : 0, ac.currentTime, 0.01);
    });
    this.levels();
    Object.assign(this.knobById('vol'), big ? { x: 18, y: 62 } : { x: 4, y: 47 });
    Object.assign(this.portById('out'), big ? { x: 129, y: 62 } : { x: 51, y: 46 });
  }

  onParam(id: string, v: number) {
    const t = ac.currentTime, c = Number(id.slice(1));
    if (id === 'vol') this.out.gain.setTargetAtTime(v, t, 0.01);
    else if (id[0] === 'l' || id.startsWith('mu') || id.startsWith('so')) this.levels();
    else if (id[0] === 'p' && this.isAdv) this.pans[c].pan.setTargetAtTime(v, t, 0.01);
  }

  drawBody(g: Gfx) {
    // A muted channel's number turns red, a soloed one's green.
    for (let c = 0; c < this.chans; c++) {
      const col = this.p['so' + c] ? C.green : this.p['mu' + c] ? C.red : '';
      if (col) g.rect(this.portById('i' + c).x + 1, 23, 7, 7, col);
    }
    if (!this.isAdv) return;
    g.text('LVL', 3, 33, C.silver);
    g.text('PAN', 3, 48, C.silver);
  }

  audioIn(port: string) { return this.ins[Number(port.slice(1))]; }
  audioOut() { return this.out; }
}

// ---------------------------------------------------------------- FX

// The three filter modes run side by side: OUT plays the one TYP picks, and the
// advanced layout has all three as outputs at once, like a real multimode filter.
const FILTER_TYPES = ['lowpass', 'highpass', 'bandpass'] as const;

export class Filter extends Mod {
  in = ac.createGain();
  fs = FILTER_TYPES.map((type) => Object.assign(ac.createBiquadFilter(), { type }));
  out = ac.createGain();
  cv = ac.createGain();
  // PIT: 1 per octave, so the cutoff follows the notes (key tracking).
  pit = ac.createGain();
  private sel = 0;

  constructor(e: Engine) {
    super(e, 'filter', 'FILTER', 'fx', 50, 52);
    this.fs[0].connect(this.out);
    for (const f of this.fs) {
      this.in.connect(f);
      this.cv.connect(f.detune);
      this.pit.connect(f.detune);
    }
    this.pit.gain.value = 1200;
    this.knobRow([
      { id: 'type', label: 'TYP', min: 0, max: 2, def: 0, names: ['LP', 'HP', 'BP'] },
      { id: 'cut', label: 'CUT', min: 0, max: 1, def: 0.6, fmt: hz },
      { id: 'res', label: 'RES', min: 0, max: 20, def: 2, fmt: (v) => v.toFixed(1) },
    ], 13);
    io(this, 'audio');
    this.port('cv', 'CUT', 'cv', 'in', 20, 32);
    this.advanced('ADVANCED', 64, 72);
    this.advOnly(() => {
      // How much the CUT jack moves the cutoff: 1 = 3 octaves per volt, negative flips it.
      this.knob({ id: 'amt', label: 'AMT', x: 49, y: 13, min: -1, max: 1, def: 1, fmt: pct });
      this.port('pit', 'PIT', 'cv', 'in', 35, 32);
      this.port('lp', 'LP', 'audio', 'out', 23, 51);
      this.port('hp', 'HP', 'audio', 'out', 37, 51);
      this.port('bp', 'BP', 'audio', 'out', 51, 51);
    });
    // A CV of 1 adds 10 to the resonance (of all three).
    const res = this.cvParam('res', 4, 51, null, 10);
    for (const f of this.fs) res.connect(f.Q);
    this.bypassable();
  }

  protected layout(adv: boolean) {
    // Room for the AMT knob: the knob row and OUT move apart.
    ['type', 'cut', 'res'].forEach((id, i) => (this.knobById(id).x = adv ? 4 + i * 15 : 6 + i * 13));
    this.portById('out').x = adv ? 51 : 37;
    this.onParam('amt');
  }

  onParam(id: string) {
    const t = ac.currentTime;
    if (id === 'type' && this.fs) {
      this.fs[this.sel].disconnect(this.out);
      this.sel = this.p.type;
      this.fs[this.sel].connect(this.out);
    }
    for (const f of this.fs ?? []) {
      if (id === 'cut') f.frequency.setTargetAtTime(cutHz(this.p.cut), t, 0.02);
      if (id === 'res') f.Q.setTargetAtTime(this.p.res, t, 0.02);
    }
    // The depth knob only applies in the advanced layout, where it shows.
    if (id === 'amt' || id === 'adv') this.cv?.gain.setTargetAtTime(CV_CENTS * (this.isAdv ? this.p.amt ?? 1 : 1), t, 0.01);
  }

  audioIn(port: string) { return port === 'cv' ? this.cv : port === 'pit' ? this.pit : this.in; }
  audioOut(port: string) {
    const i = ['lp', 'hp', 'bp'].indexOf(port);
    return i >= 0 ? this.fs[i] : this.out;
  }
}

// Synced delay times, in 16th notes: 1/16, 1/8 triplet, 1/8, dotted 1/8, 1/4, dotted 1/4, 1/2.
const SYNC_NAMES = ['1/16', '1/8T', '1/8', '1/8.', '1/4', '1/4.', '1/2'];
const SYNC_16THS = [1, 4 / 3, 2, 3, 4, 6, 8];

export class Delay extends Mod {
  private clk: number[] = [];
  // Seconds per clock tick, measured at CLK (0 until two ticks have arrived).
  private tick = 0;
  private time = -1;
  in = ac.createGain();
  out = ac.createGain();
  d = ac.createDelay(2);
  fb = ac.createGain();
  wet = ac.createGain();
  cv = ac.createGain();

  constructor(e: Engine) {
    super(e, 'delay', 'DELAY', 'fx', 50, 70);
    this.in.connect(this.out);
    this.in.connect(this.d);
    // The repeats run through a soft clipper, so feedback pushed past 100% saturates
    // like tape instead of running away. Its slope at zero is exactly 1: quiet echoes
    // pass unchanged, so each repeat comes back at FBK times the one before.
    const clip = ac.createWaveShaper(), n = 1025, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = Math.tanh((i / (n - 1)) * 2 - 1);
    clip.curve = curve;
    this.d.connect(this.fb).connect(clip).connect(this.d);
    this.d.connect(this.wet).connect(this.out);
    // A CV of 1 adds a quarter second.
    this.cv.gain.value = 0.25;
    this.cv.connect(this.d.delayTime);
    this.knobRow([
      { id: 'time', label: 'TIM', min: 0.05, max: 1, def: 0.375, fmt: (v) => (this.synced ? SYNC_NAMES[this.syncIdx(v)] : ms(v)) },
      { id: 'fb', label: 'FBK', min: 0, max: 0.9, def: 0.4, fmt: pct },
      { id: 'mix', label: 'MIX', min: 0, max: 1, def: 0.35, fmt: pct },
    ], 13);
    io(this, 'audio');
    this.port('cv', 'TIM', 'cv', 'in', 20, 32);
    // With a clock at CLK, TIM picks a note value instead of a time.
    this.port('clk', 'CLK', 'trig', 'in', 4, 51);
    this.advanced('ADVANCED', 50, 70);
    this.cvParam('fb', 20, 51, this.fb.gain, 0.45);
    this.cvParam('mix', 35, 51, this.wet.gain, 0.5);
    this.bypassable();
  }

  get synced() { return this.eng.cablesAt(this, 'clk').length > 0; }

  private syncIdx(v: number) { return Math.round(((v - 0.05) / 0.95) * (SYNC_16THS.length - 1)); }

  // Set the delay time from the knob, or from the clock when synced.
  private retime(t: number) {
    const v = this.p.time;
    const sec = this.synced && this.tick ? Math.min(2, this.tick * SYNC_16THS[this.syncIdx(v)]) : v;
    if (Math.abs(sec - this.time) < 0.001) return;
    this.time = sec;
    this.d.delayTime.setTargetAtTime(sec, t, 0.05);
  }

  onEvent(port: string, ev: Ev) {
    if (port !== 'clk' || ev.off) return;
    // Averaged over two ticks, so swing does not wobble the time.
    const c = (this.clk = [...this.clk.slice(-2), ev.t]);
    const tick = c.length === 3 ? (c[2] - c[0]) / 2 : c.length === 2 ? c[1] - c[0] : 0;
    if (tick > 0.02 && tick < 1) { this.tick = tick; this.retime(ev.t); }
  }

  // Unplugging the clock goes back to the knob's time.
  schedule() { if (this.tick && !this.synced) { this.tick = 0; this.retime(ac.currentTime); } }
  reset() { this.clk = []; }

  onParam(id: string, v: number) {
    const t = ac.currentTime;
    if (id === 'time') this.retime(t);
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
    this.bypassable();
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

// ---------------------------------------------------------------- RECORDER

// Records whatever is patched into IN (in stereo, if it is) as WAV files. REC starts
// and stops a take by hand; each trigger at TRG does the same, exactly on time: CLOCK
// RST records from the moment you press play, a 2-bar DIV records 2-bar loops.
// Stopping playback ends a take. Every take downloads when it ends.
export class RecorderMod extends Mod {
  private rec = new Recorder((wav) => {
    download(wav, `pixel-modular-${stamp()}.wav`);
    this.saved = now();
  });
  private an = ac.createAnalyser();
  private buf = new Float32Array(256);
  private saved = -1e9;

  constructor(e: Engine) {
    super(e, 'recorder', 'RECORDER', 'util', 64, 52);
    this.an.fftSize = 256;
    this.rec.in.connect(this.an);
    this.port('in', 'IN', 'audio', 'in', 4, 32);
    this.port('trg', 'TRG', 'trig', 'in', 20, 32);
  }

  private toggle(t: number) {
    if (this.rec.recording) this.rec.stop(t);
    else this.rec.start(t);
  }

  onEvent(_port: string, ev: Ev) { if (!ev.off) this.toggle(ev.t); }

  audioIn() { return this.rec.in; }

  // Engine.stop resets with t0 = 0: that ends a take.
  reset(t0: number) { if (!t0) this.rec.stop(ac.currentTime); }

  press(lx: number, ly: number): Drag | null {
    if (!inBtn(lx, ly, 36, 34, 25)) return null;
    void ac.resume();
    this.toggle(ac.currentTime + 0.02);
    return noDrag;
  }

  drawBody(g: Gfx) {
    const on = this.rec.recording;
    g.rect(3, 12, 58, 16, C.black);
    g.disc(9, 18, 3, on && Math.floor(now() / 400) % 2 === 0 ? C.red : C.dark);
    const s = Math.floor(this.rec.seconds);
    const text = now() - this.saved < 2000 ? 'SAVED' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    g.text(text, 16, 15, on ? C.red : C.silver);
    // input level
    this.an.getFloatTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v));
    g.rect(16, 23, 42, 2, C.ink);
    g.rect(16, 23, Math.round(Math.min(1, peak) * 42), 2, peak > 0.95 ? C.red : C.lime);
    drawButton(g, 36, 34, 25, on ? 'STOP' : 'REC', on ? C.red : C.silver);
  }

  destroy() {
    // A take in progress still ends and downloads.
    this.rec.stop(ac.currentTime);
    setTimeout(() => this.rec.destroy(), 500);
  }
}

// ---------------------------------------------------------------- SPEAKER

// The output to the speakers: a grille and a small LED level meter (after VOL).
const SPEAKER_LEDS = [-36, -30, -24, -18, -12, -6, -3, -0.5]; // dB at which each LED lights

export class Speaker extends Mod {
  in = ac.createGain();
  an = ac.createAnalyser();
  vol = ac.createGain();
  private buf = new Float32Array(256);
  private level = 0;

  constructor(e: Engine) {
    super(e, 'speaker', 'SPEAKER', 'util', 64, 44);
    this.an.fftSize = 256;
    this.in.connect(this.vol).connect(e.master);
    this.vol.connect(this.an);
    this.port('in', 'IN', 'audio', 'in', 4, 23);
    this.knob({ id: 'vol', label: 'VOL', x: 49, y: 22, min: 0, max: 1, def: 0.8, fmt: pct });
  }

  onParam(_id: string, v: number) { this.vol.gain.setTargetAtTime(v, ac.currentTime, 0.01); }

  audioIn() { return this.in; }

  drawBody(g: Gfx) {
    // Peak level, falling back slowly so short hits stay visible.
    this.an.getFloatTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v));
    this.level = Math.max(peak, this.level * 0.9);
    const db = 20 * Math.log10(this.level + 1e-9);
    SPEAKER_LEDS.forEach((at, i) => {
      const col = i === SPEAKER_LEDS.length - 1 ? C.red : i >= SPEAKER_LEDS.length - 3 ? C.yellow : C.lime;
      g.rect(17 + i * 5, 13, 4, 3, db >= at ? col : C.ink);
    });
    // speaker grille
    for (let y = 20; y < 36; y += 3) for (let x = 18; x < 45; x += 3) g.rect(x, y, 2, 2, C.ink);
  }

  destroy() { this.vol.disconnect(); }
}

// ---------------------------------------------------------------- VOICE PARTS

// Linear FM: an input of 1 swings the frequency by this many times the note's own
// frequency, so the timbre stays the same up and down the keyboard.
const FM_DEPTH = 4;

// The oscillator core runs in a worklet so all its waves share one phase: SAW, SQR (with
// pulse width) and SUB (a square an octave down) are band-limited with polyBLEP; TRI and
// SIN are clean as they are. SYNC restarts the phase on each rising edge (hard sync).
const OSC_PROCESSOR = `
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
class Osc extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'freq', defaultValue: 130.81, automationRate: 'k-rate' },
      { name: 'pw', defaultValue: 0.5, automationRate: 'k-rate' },
      { name: 'fm', defaultValue: ${FM_DEPTH}, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.ph = 0; this.sub = 0; this.last = 0; }
  process(inputs, outputs, params) {
    const o = outputs[0];
    if (!o || o.length < 5) return true;
    const pit = inputs[0][0], fm = inputs[1][0], pwm = inputs[2][0], sync = inputs[3][0];
    const f0 = params.freq[0], pw0 = params.pw[0], fmd = params.fm[0], L = 0.3;
    for (let s = 0; s < o[0].length; s++) {
      let f = pit ? f0 * Math.exp(pit[s] * Math.LN2) : f0;
      if (fm) f *= 1 + fmd * fm[s];
      if (sync) {
        const x = sync[s];
        if (x > 0 && this.last <= 0) { this.ph = 0; this.sub = 0; }
        this.last = x;
      }
      const dt = Math.min(0.5, Math.abs(f) / sampleRate), ph = this.ph, sub = this.sub;
      const pw = Math.min(0.98, Math.max(0.02, pw0 + (pwm ? pwm[s] * 0.45 : 0)));
      o[0][s] = L * (2 * ph - 1 - blep(ph, dt));
      o[1][s] = L * ((ph < pw ? 1 : -1) + blep(ph, dt) - blep((ph - pw + 1) % 1, dt));
      o[2][s] = L * (1 - 4 * Math.abs(((ph + 0.25) % 1) - 0.5));
      o[3][s] = L * Math.sin(2 * Math.PI * ph);
      o[4][s] = L * ((sub < 0.5 ? 1 : -1) + blep(sub, dt / 2) - blep((sub + 0.5) % 1, dt / 2));
      const step = f / sampleRate;
      this.ph = ph + step - Math.floor(ph + step);
      this.sub = sub + step / 2 - Math.floor(sub + step / 2);
    }
    return true;
  }
}
registerProcessor('osc', Osc);
`;

// Basic: all four waves out at once, like a real VCO. Advanced: pulse width (PW, with
// a PWM jack), FM depth, hard SYNC and a SUB output an octave down.
const OSC_OUTS = ['saw', 'sqr', 'tri', 'sin', 'sub'];

export class Osc extends Mod {
  pitch = ac.createGain();
  fm = ac.createGain();
  pwm = ac.createGain();
  sync = ac.createGain();
  outs = OSC_OUTS.map(() => ac.createGain());
  private node: AudioWorkletNode | null = null;

  constructor(e: Engine) {
    super(e, 'osc', 'OSC', 'synth', 64, 52);
    this.knob({ id: 'oct', label: 'OCT', x: 4, y: 13, min: -2, max: 2, def: 0, step: 1, fmt: (v) => (v > 0 ? '+' : '') + v });
    this.knob({ id: 'fine', label: 'FIN', x: 19, y: 13, min: -1, max: 1, def: 0, fmt: (v) => (v > 0 ? '+' : '') + Math.round(v * 100) + 'CT' });
    this.port('cv', 'PIT', 'cv', 'in', 35, 13);
    this.port('fm', 'FM', 'cv', 'in', 50, 13);
    ['SAW', 'SQR', 'TRI', 'SIN'].forEach((l, i) => this.port(OSC_OUTS[i], l, 'audio', 'out', 5 + i * 15, 32));
    this.advanced('ADVANCED', 79, 70);
    this.advOnly(() => {
      this.knob({ id: 'pw', label: 'PW', x: 4, y: 51, min: 0.05, max: 0.95, def: 0.5, fmt: pct });
      this.port('pwm', 'PWM', 'cv', 'in', 20, 51);
      this.knob({ id: 'fma', label: 'FMA', x: 34, y: 51, min: 0, max: 2, def: 1, fmt: pct });
      this.port('sync', 'SYN', 'audio', 'in', 50, 51);
      this.port('sub', 'SUB', 'audio', 'out', 65, 51);
    });
    void worklet(OSC_PROCESSOR).then(() => {
      const node = new AudioWorkletNode(ac, 'osc', { numberOfInputs: 4, outputChannelCount: [5] });
      [this.pitch, this.fm, this.pwm, this.sync].forEach((g, i) => g.connect(node, 0, i));
      const split = ac.createChannelSplitter(5);
      node.connect(split);
      this.outs.forEach((o, i) => split.connect(o, i));
      this.node = node;
      for (const id of ['oct', 'pw', 'fma']) this.onParam(id);
    });
  }

  protected layout() { for (const id of ['pw', 'fma']) this.onParam(id); }

  onParam(id: string) {
    const t = ac.currentTime, prm = (n: string) => this.node?.parameters.get(n);
    if (id === 'oct' || id === 'fine') {
      prm('freq')?.setValueAtTime(440 * 2 ** ((PITCH_REF - 69) / 12 + this.p.oct + (this.p.fine ?? 0) / 12), t);
    }
    // The basic layout plays a square wave and the standard FM depth.
    if (id === 'pw') prm('pw')?.setValueAtTime(this.isAdv ? this.p.pw : 0.5, t);
    if (id === 'fma') prm('fm')?.setValueAtTime(FM_DEPTH * (this.isAdv ? this.p.fma : 1), t);
  }

  audioIn(port: string) {
    return port === 'fm' ? this.fm : port === 'pwm' ? this.pwm : port === 'sync' ? this.sync : this.pitch;
  }

  audioOut(port: string) { return this.outs[OSC_OUTS.indexOf(port)] ?? null; }
  destroy() { this.node?.disconnect(); }
}

// Slew limiter: smooths a CV, for portamento on pitch or softening stepped modulation.
const SLEW_PROCESSOR = `
class Slew extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'time', defaultValue: 0, minValue: 0, automationRate: 'k-rate' }]; }
  constructor() { super(); this.y = 0; }
  process(inputs, outputs, params) {
    const i = inputs[0][0], o = outputs[0][0];
    if (!o) return true;
    const tm = params.time[0], k = tm > 0 ? 1 - Math.exp(-1 / (tm * sampleRate)) : 1;
    for (let s = 0; s < o.length; s++) {
      this.y += ((i ? i[s] : 0) - this.y) * k;
      o[s] = this.y;
    }
    return true;
  }
}
registerProcessor('slew', Slew);
`;

export class Slew extends Mod {
  in = ac.createGain();
  out = ac.createGain();
  private node: AudioWorkletNode | null = null;

  constructor(e: Engine) {
    super(e, 'slew', 'SLEW', 'mod', 50, 52);
    this.in.connect(this.out);
    this.knob({ id: 'time', label: 'TIM', x: 4, y: 13, min: 0, max: 1, def: 0.1, fmt: ms });
    this.port('in', 'IN', 'cv', 'in', 4, 32);
    this.port('out', 'OUT', 'cv', 'out', 37, 32);
    this.advanced('ADVANCED', 50, 52);
    // A CV of 1 adds half a second (the param is a third of the time; see onParam).
    const cv = this.cvParam('time', 20, 32, null, 0.5 / 3);
    void worklet(SLEW_PROCESSOR).then(() => {
      this.node = new AudioWorkletNode(ac, 'slew', { outputChannelCount: [1] });
      this.in.disconnect(this.out);
      this.in.connect(this.node).connect(this.out);
      cv.connect(this.node.parameters.get('time')!);
      this.onParam('time', this.p.time);
    });
  }

  onParam(id: string, v: number) {
    // The time constant: about a third of the time it takes to arrive.
    if (id === 'time') this.node?.parameters.get('time')!.setValueAtTime(v / 3, ac.currentTime);
  }

  audioIn() { return this.in; }
  audioOut() { return this.out; }
  destroy() { this.node?.disconnect(); }
}

// ---------------------------------------------------------------- MATHS

// After Make Noise MATHS: two function generators (channels 1 and 4) around two
// attenuverted inputs (2 and 3), all summed onto SUM, INV and OR buses.
// A function generator rises to its input, or to 1 on a trigger, at the RISE rate and
// falls at the FALL rate, shaped by SHP (log, lin, exp). CYCLE makes it start over
// at the bottom: an LFO. Its outputs are the plain function (UNI), the function
// through its attenuverter (OUT, onto the buses), and a gate: EOR on channel 1 (high
// from the end of the rise to the end of the fall), EOC on 4 (high from the end of the
// fall until the next rise, so also at rest). An OUT with a cable in it leaves the
// buses, as on MATHS.
const MATHS_PROCESSOR = `
const secs = (k) => 0.001 * 20000 ** Math.min(1, Math.max(0, k));
function shape(v, s) {
  if (v <= 0 || v >= 1 || Math.abs(s - 0.5) < 0.01) return v;
  const k = 1 + Math.abs(s - 0.5) * 6;
  return s > 0.5 ? v ** k : 1 - (1 - v) ** k;
}
class Maths extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ['rise1', 'fall1', 'both1', 'rise4', 'fall4', 'both4']
      .map((name) => ({ name, defaultValue: 0, automationRate: 'k-rate' }));
  }
  constructor() {
    super();
    // Knob values, the cycle buttons, ins 2 and 3 patched, OUTs patched (off the buses).
    this.k = { rise: [0.4, 0.4], fall: [0.5, 0.5], shp: [0.5, 0.5], cyc: [0, 0], att: [1, 0, 0, 1] };
    this.patched = [false, false];
    this.offBus = [false, false, false, false];
    this.fn = [0, 1].map(() => ({ v: 0, env: '', cyc: false, rising: false, falling: false, eor: false, eoc: true }));
    this.events = [];
    this.out = [];
    this.lvl = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.ev) { this.events.push(d.ev); this.events.sort((a, b) => a.t - b.t); }
      else if (d.stop) { this.events = []; for (const f of this.fn) f.cyc = false; }
      else Object.assign(this, d);
    };
  }
  // A gate change on 'eor' (channel 1) or 'eoc' (channel 4).
  gate(f, j, kind, on, t) {
    if (f[kind] === on) return;
    f[kind] = on;
    if ((j === 0) === (kind === 'eor')) this.out.push({ kind, on, t });
  }
  process(inputs, outputs, params) {
    const o = outputs[0];
    if (!o || o.length < 9) return true;
    const n = o[0].length, sr = sampleRate;
    const sig = [inputs[0][0], inputs[3][0]], ins = [inputs[1][0], inputs[2][0]];
    const rate = [0, 1].map((j) => {
      const c = j ? '4' : '1', both = params['both' + c][0] / 2;
      return [1 / (secs(this.k.rise[j] + params['rise' + c][0] / 2 - both) * sr),
              1 / (secs(this.k.fall[j] + params['fall' + c][0] / 2 - both) * sr)];
    });
    for (let s = 0; s < n; s++) {
      const t = currentTime + s / sr;
      while (this.events.length && this.events[0].t <= t) {
        const e = this.events.shift(), f = this.fn[e.j];
        // A trigger restarts the function unless it is already rising, as on MATHS.
        if (e.k === 'trig' && f.env !== 'rise') f.env = 'rise';
        if (e.k === 'cyc') f.cyc = e.on;
      }
      const vals = [0, 0, 0, 0];
      for (let j = 0; j < 2; j++) {
        const f = this.fn[j], x = sig[j] ? sig[j][s] : 0, [up, dn] = rate[j], was = f.v;
        if (f.env === 'rise') { f.v += up; if (f.v >= 1) { f.v = Math.max(1, x); f.env = 'fall'; } }
        else if (f.env === 'fall') { f.v -= dn; if (f.v <= x) { f.v = x; f.env = ''; } }
        else f.v = x > f.v ? Math.min(x, f.v + up) : Math.max(x, f.v - dn);
        if (!f.env && (this.k.cyc[j] || f.cyc) && f.v <= x + 1e-6) f.env = 'rise';
        const rising = f.env === 'rise' || f.v > was + 1e-9;
        const falling = !rising && (f.env === 'fall' || f.v < was - 1e-9);
        if (rising && !f.rising) { this.gate(f, j, 'eor', false, t); this.gate(f, j, 'eoc', false, t); }
        if (!rising && f.rising) this.gate(f, j, 'eor', true, t);
        if (!rising && !falling && f.falling) { this.gate(f, j, 'eor', false, t); this.gate(f, j, 'eoc', true, t); }
        f.rising = rising; f.falling = falling;
        const u = shape(f.v, this.k.shp[j]);
        o[j][s] = u;
        vals[j ? 3 : 0] = u * this.k.att[j ? 3 : 0];
      }
      for (let j = 0; j < 2; j++) {
        const x = this.patched[j] ? (ins[j] ? ins[j][s] : 0) : (j ? 0.5 : 1);
        vals[j + 1] = x * this.k.att[j + 1];
      }
      let sum = 0, or = 0;
      for (let c = 0; c < 4; c++) {
        o[2 + c][s] = vals[c];
        if (!this.offBus[c]) { sum += vals[c]; or = Math.max(or, vals[c]); }
      }
      o[6][s] = sum; o[7][s] = -sum; o[8][s] = or;
    }
    // Gate changes, and now and then the levels for the LEDs.
    this.lvl += n;
    const lv = this.lvl >= 1024 ? [o[0][n - 1], o[1][n - 1], o[6][n - 1]] : null;
    if (lv) this.lvl = 0;
    if (this.out.length || lv) { this.port.postMessage({ gates: this.out, lv }); this.out = []; }
    return true;
  }
}
registerProcessor('maths', Maths);
`;

const mathsSec = (k: number) => 0.001 * 20000 ** k;
const secFmt = (v: number) => {
  const s = mathsSec(v);
  return s < 1 ? Math.round(s * 1000) + 'MS' : s.toFixed(s < 10 ? 1 : 0) + 'S';
};
const shpFmt = (v: number) => (v < 0.45 ? 'LOG' : v > 0.55 ? 'EXP' : 'LIN');
const attFmt = (v: number) => (v > 0 ? '+' : '') + Math.round(v * 100) + '%';
// The worklet's output channels, in order.
const MATHS_OUTS = ['uni1', 'uni4', 'out1', 'out2', 'out3', 'out4', 'sum', 'inv', 'or'];
// Where the CYCLE buttons are, per function channel.
const MATHS_CYC = [{ x: 4, y: 72 }, { x: 128, y: 72 }];

export class Maths extends Mod {
  sigs = [ac.createGain(), ac.createGain()];
  ins = [ac.createGain(), ac.createGain()];
  // CV for RISE, FALL and BOTH, per function channel; connected to the worklet's params.
  cvs: Record<string, GainNode> = {};
  outs = MATHS_OUTS.map(() => ac.createGain());
  private node: AudioWorkletNode | null = null;
  private lv = [0, 0, 0];
  // When each gate output last went high, so a gate that drops at once still shows.
  private high: Record<string, number> = {};

  constructor(e: Engine) {
    super(e, 'maths', 'MATHS', 'pro', 160, 110);
    for (const [j, c] of ['1', '4'].entries()) {
      const left = j === 0, x = left ? [4, 19, 34] : [115, 130, 145];
      this.knob({ id: 'rise' + c, label: 'RIS', x: x[0] - 1, y: 13, min: 0, max: 1, def: 0.4, fmt: secFmt });
      this.knob({ id: 'fall' + c, label: 'FAL', x: x[1] - 1, y: 13, min: 0, max: 1, def: 0.5, fmt: secFmt });
      this.knob({ id: 'shp' + c, label: 'SHP', x: x[2] - 1, y: 13, min: 0, max: 1, def: 0.5, fmt: shpFmt });
      this.port('sig' + c, 'SIG', 'cv', 'in', x[0], 32);
      this.port('trg' + c, 'TRG', 'trig', 'in', x[1], 32);
      this.port('cyc' + c, 'CYC', 'trig', 'in', x[2], 32);
      for (const [k, id] of ['rise', 'fall', 'both'].entries()) {
        this.cvs[id + c] = ac.createGain();
        this.port('c' + id + c, ['RIS', 'FAL', 'BTH'][k], 'cv', 'in', x[k], 51);
      }
      this.port(left ? 'eor' : 'eoc', left ? 'EOR' : 'EOC', 'trig', 'out', left ? x[2] : x[0], 70);
      // Bottom row, mirrored: ATT UNI OUT on the left, OUT UNI ATT on the right.
      this.knob({ id: 'att' + c, label: 'ATT', x: (left ? x[0] : x[2]) - 1, y: 89, min: -1, max: 1, def: 1, fmt: attFmt });
      this.port('uni' + c, 'UNI', 'cv', 'out', x[1], 89);
      this.port('out' + c, c, 'cv', 'out', left ? x[2] : x[0], 89);
      this.p['cy' + c] = 0;
    }
    for (const [j, c] of ['2', '3'].entries()) {
      const x = 62 + j * 28;
      this.port('in' + c, c, 'cv', 'in', x, 13);
      this.knob({ id: 'att' + c, label: 'ATT', x: x - 1, y: 30, min: -1, max: 1, def: 0, fmt: attFmt });
      this.port('out' + c, 'OUT', 'cv', 'out', x, 47);
    }
    this.port('sum', 'SUM', 'cv', 'out', 57, 89);
    this.port('inv', 'INV', 'cv', 'out', 76, 89);
    this.port('or', 'OR', 'cv', 'out', 95, 89);
    void worklet(MATHS_PROCESSOR).then(() => {
      const node = new AudioWorkletNode(ac, 'maths', { numberOfInputs: 4, outputChannelCount: [9] });
      [this.sigs[0], this.ins[0], this.ins[1], this.sigs[1]].forEach((g, i) => g.connect(node, 0, i));
      for (const [id, g] of Object.entries(this.cvs)) g.connect(node.parameters.get(id)!);
      const split = ac.createChannelSplitter(9);
      node.connect(split);
      this.outs.forEach((o, i) => split.connect(o, i));
      node.port.onmessage = (e) => this.fromWorklet(e.data);
      this.node = node;
      this.send();
      this.onCables();
    });
  }

  private fromWorklet(d: { gates: { kind: string; on: boolean; t: number }[]; lv: number[] | null }) {
    if (d.lv) this.lv = d.lv;
    for (const gt of d.gates) {
      // The gate's time has just passed; play it now, and keep a high at least 5 ms.
      let t = Math.max(gt.t, ac.currentTime);
      if (gt.on) this.high[gt.kind] = t;
      else t = Math.max(t, (this.high[gt.kind] ?? 0) + 0.005);
      this.emit(gt.kind, gt.on ? { t, dur: 0, hold: true } : { t, dur: 0, off: true });
    }
  }

  private send() {
    const p = this.p, both = (id: string) => [p[id + '1'], p[id + '4']];
    this.node?.port.postMessage({
      k: { rise: both('rise'), fall: both('fall'), shp: both('shp'), cyc: both('cy'), att: [p.att1, p.att2, p.att3, p.att4] },
    });
  }

  onParam() { this.send(); }

  onCables() {
    const has = (port: string) => this.eng.cablesAt(this, port).length > 0;
    this.node?.port.postMessage({
      patched: [has('in2'), has('in3')],
      offBus: ['out1', 'out2', 'out3', 'out4'].map(has),
    });
  }

  onEvent(port: string, ev: Ev) {
    const j = port.endsWith('4') ? 1 : 0, post = (e: object) => this.node?.port.postMessage({ ev: { j, ...e } });
    if (port.startsWith('trg')) { if (!ev.off) post({ k: 'trig', t: ev.t }); return; }
    if (ev.off) { post({ k: 'cyc', on: false, t: ev.t }); return; }
    post({ k: 'cyc', on: true, t: ev.t });
    if (!ev.hold) post({ k: 'cyc', on: false, t: ev.t + ev.dur });
  }

  reset(t0: number) { if (!t0) this.node?.port.postMessage({ stop: true }); }

  press(lx: number, ly: number): Drag | null {
    for (const [j, b] of MATHS_CYC.entries()) {
      if (lx >= b.x && lx < b.x + 27 && ly >= b.y && ly < b.y + 9) {
        const id = j ? 'cy4' : 'cy1';
        this.set(id, this.p[id] ? 0 : 1);
        return noDrag;
      }
    }
    return null;
  }

  drawBody(g: Gfx) {
    // Channel blocks: 1 on the left, 2 and 3 in the middle, 4 on the right.
    g.rect(52, 12, 1, 94, C.ink);
    g.rect(110, 12, 1, 94, C.ink);
    for (const [j, b] of MATHS_CYC.entries()) {
      const on = this.p[j ? 'cy4' : 'cy1'] === 1;
      drawButton(g, b.x, b.y, 27, 'CYCLE', on ? C.lime : C.slate, on ? C.ink : C.silver);
    }
    // Levels of channel 1, channel 4 and SUM.
    const bar = (y: number, label: string, v: number, col: string) => {
      g.text(label, 56, y, C.silver);
      g.rect(68, y, 38, 5, C.black);
      g.rect(68, y, Math.round(Math.min(1, Math.abs(v)) * 38), 5, v < 0 ? C.red : col);
    };
    bar(67, '1', this.lv[0], C.lime);
    bar(73, '4', this.lv[1], C.lime);
    bar(79, 'S', this.lv[2], C.yellow);
  }

  audioIn(port: string) {
    if (port.startsWith('sig')) return this.sigs[port === 'sig4' ? 1 : 0];
    if (port.startsWith('in')) return this.ins[port === 'in3' ? 1 : 0];
    return this.cvs[port.slice(1)] ?? null;
  }

  audioOut(port: string) { return this.outs[MATHS_OUTS.indexOf(port)] ?? null; }
  destroy() { this.node?.disconnect(); }
}

// Noise in colours: white (flat), pink (-3 dB per octave, Paul Kellet's filter),
// brown (-6 dB, leaky integrated white), blue (+6 dB, differentiated white), plus
// DUST (random single-sample clicks, DNS per second) and a sample and hold: each
// trigger holds a new random value at RND. Holds are queued and land sample-accurately.
const NOISE_PROCESSOR = `
class Noise extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'dens', defaultValue: 20, minValue: 0, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.p = [0, 0, 0, 0, 0, 0, 0]; this.br = 0; this.w0 = 0; this.held = 0;
    this.holds = [];
    this.port.onmessage = (e) => { this.holds.push(e.data.hold); this.holds.sort((a, b) => a - b); };
  }
  process(inputs, outputs, params) {
    const o = outputs[0];
    if (!o || o.length < 6) return true;
    const p = this.p, n = o[0].length, pr = params.dens[0] / sampleRate;
    for (let s = 0; s < n; s++) {
      const t = currentTime + s / sampleRate;
      while (this.holds.length && this.holds[0] <= t) { this.holds.shift(); this.held = Math.random() * 2 - 1; }
      const w = Math.random() * 2 - 1;
      p[0] = 0.99886 * p[0] + w * 0.0555179; p[1] = 0.99332 * p[1] + w * 0.0750759;
      p[2] = 0.969 * p[2] + w * 0.153852; p[3] = 0.8665 * p[3] + w * 0.3104856;
      p[4] = 0.55 * p[4] + w * 0.5329522; p[5] = -0.7616 * p[5] - w * 0.016898;
      const pink = (p[0] + p[1] + p[2] + p[3] + p[4] + p[5] + p[6] + w * 0.5362) * 0.11;
      p[6] = w * 0.115926;
      this.br = (this.br + 0.02 * w) / 1.02;
      o[0][s] = w;
      o[1][s] = pink;
      o[2][s] = this.br * 3.5;
      o[3][s] = (w - this.w0) / 2;
      o[4][s] = Math.random() < pr ? Math.random() * 2 - 1 : 0;
      o[5][s] = this.held;
      this.w0 = w;
    }
    return true;
  }
}
registerProcessor('noise', Noise);
`;
const NOISE_OUTS = ['wht', 'pnk', 'brn', 'blu', 'dst', 'rnd'];
const dustHz = (v: number) => 0.5 * 2 ** (v * 12);

export class Noise extends Mod {
  f = ac.createBiquadFilter();
  out = ac.createGain();
  // The colours and DUST at LVL; RND is a CV and stays at -1..1.
  outs = NOISE_OUTS.map(() => ac.createGain());
  private node: AudioWorkletNode | null = null;

  constructor(e: Engine) {
    super(e, 'noise', 'NOISE', 'synth', 50, 52);
    this.f.type = 'lowpass';
    this.f.connect(this.out);
    this.knobRow([
      { id: 'tone', label: 'TON', min: 0, max: 1, def: 0.8, fmt: hz },
      { id: 'lvl', label: 'LVL', min: 0, max: 1, def: 0.3, fmt: pct },
    ], 13);
    this.port('out', 'OUT', 'audio', 'out', 37, 32);
    this.advanced('ADVANCED', 100, 70);
    // A CV of 1 raises TON by four octaves; one on LVL adds half the range.
    this.cvParam('tone', 12, 51, this.f.detune, 4800);
    const lvl = this.cvParam('lvl', 27, 51, null, 0.5);
    for (const g of [this.out, ...this.outs.slice(0, 5)]) lvl.connect(g.gain);
    // Advanced, in groups like a Doepfer A-118: the filtered noise (FLT) with TON and LVL
    // on the left; the four fixed colours in a block; DUST over its DNS knob; and the
    // sample and hold, TRG into RND, along the bottom.
    this.advOnly(() => {
      ['WHT', 'PNK', 'BRN', 'BLU'].forEach((l, i) =>
        this.port(NOISE_OUTS[i], l, 'audio', 'out', 52 + (i % 2) * 15, i < 2 ? 13 : 32));
      this.port(NOISE_OUTS[4], 'DST', 'audio', 'out', 85, 13);
      this.knob({ id: 'dens', label: 'DNS', x: 84, y: 32, min: 0, max: 1, def: 0.4, fmt: (v) => Math.round(dustHz(v)) + '/S' });
      this.port('trg', 'TRG', 'trig', 'in', 52, 51);
      this.port('rnd', 'RND', 'cv', 'out', 67, 51);
    });
    void worklet(NOISE_PROCESSOR).then(() => {
      const node = new AudioWorkletNode(ac, 'noise', { outputChannelCount: [6] });
      const split = ac.createChannelSplitter(6);
      node.connect(split);
      this.outs.forEach((o, i) => split.connect(o, i));
      split.connect(this.f, 0);
      this.node = node;
      for (const id of ['tone', 'lvl', 'dens']) this.onParam(id);
    });
  }

  // Among the colour jacks, OUT is named for what it is: the filtered one.
  protected layout(adv: boolean) { this.portById('out').label = adv ? 'FLT' : 'OUT'; }

  onParam(id: string) {
    const t = ac.currentTime;
    if (id === 'tone') this.f.frequency.setTargetAtTime(cutHz(this.p.tone), t, 0.02);
    if (id === 'lvl') for (const g of [this.out, ...this.outs.slice(0, 5)]) g.gain.setTargetAtTime(this.p.lvl, t, 0.02);
    if (id === 'dens') this.node?.parameters.get('dens')!.setTargetAtTime(dustHz(this.p.dens), t, 0.02);
  }

  onEvent(port: string, ev: Ev) {
    if (port === 'trg' && !ev.off) this.node?.port.postMessage({ hold: ev.t });
  }

  // A little screen with a still trace of noise; in the + layout, lines between the groups.
  drawBody(g: Gfx) {
    if (this.isAdv) for (const x of [48, 80]) g.rect(x, 12, 1, this.h - 15, C.ink);
    g.rect(4, 32, 28, 15, C.black);
    let r = 7, y0 = 39;
    for (let x = 6; x < 30; x++) {
      r = (r * 1103515245 + 12345) & 0x7fffffff;
      const y = 39 + ((r >> 8) % 13) - 6;
      g.line(x - 1, y0, x, y, C.sky);
      y0 = y;
    }
  }

  audioOut(port: string) { return port === 'out' ? this.out : this.outs[NOISE_OUTS.indexOf(port)] ?? null; }
  destroy() { this.node?.disconnect(); }
}

// ---------------------------------------------------------------- MODULATION

// Loads an AudioWorklet processor from source, once.
const worklets = new Map<string, Promise<void>>();
function worklet(code: string) {
  let p = worklets.get(code);
  if (!p) {
    p = ac.audioWorklet.addModule(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    worklets.set(code, p);
  }
  return p;
}

const lfoHz = (v: number) => 0.05 * 2 ** (v * 9);

// One phase drives every wave, so all outputs stay in step. The waves start where
// Web Audio's oscillators do (0 rising; the square high first). RND holds a new random
// value each cycle, SMO glides to it. Resets are queued and land sample-accurately.
const LFO_PROCESSOR = `
class Lfo extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'freq', defaultValue: 1, automationRate: 'k-rate' }];
  }
  constructor() {
    super();
    this.ph = 0; this.shape = 0; this.uni = false;
    this.r0 = 0; this.r1 = Math.random() * 2 - 1;
    this.resets = [];
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.reset !== undefined) { this.resets.push(d.reset); this.resets.sort((a, b) => a - b); }
      else Object.assign(this, d);
    };
  }
  next() { this.r0 = this.r1; this.r1 = Math.random() * 2 - 1; }
  process(inputs, outputs, params) {
    const o = outputs[0];
    if (!o || o.length < 7) return true;
    const cv = inputs[0][0], n = o[0].length, f0 = params.freq[0];
    for (let s = 0; s < n; s++) {
      const t = currentTime + s / sampleRate;
      while (this.resets.length && this.resets[0] <= t) { this.resets.shift(); if (this.ph > 0.001) this.next(); this.ph = 0; }
      // A CV of 1 adds 5 Hz.
      this.ph += (f0 + (cv ? cv[s] * 5 : 0)) / sampleRate;
      if (this.ph >= 1) { this.ph -= Math.floor(this.ph); this.next(); }
      else if (this.ph < 0) { this.ph += 1 - Math.floor(this.ph + 1); this.next(); }
      const p = this.ph;
      const w = [
        Math.sin(2 * Math.PI * p),
        p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4,
        p < 0.5 ? 2 * p : 2 * p - 2,
        p < 0.5 ? 1 : -1,
        this.r0,
        this.r0 + (this.r1 - this.r0) * (0.5 - 0.5 * Math.cos(Math.PI * p)),
      ];
      for (let i = 0; i < 6; i++) {
        const v = this.uni ? (w[i] + 1) / 2 : w[i];
        o[i + 1][s] = v;
        if (i === this.shape) o[0][s] = v;
      }
    }
    return true;
  }
}
registerProcessor('lfo', Lfo);
`;

// With a clock at CLK, RAT picks a note value; the clock sends 16ths.
const LFO_SYNC = [1, 2, 4, 8, 16, 32, 64, 128];
const LFO_SYNC_NAMES = ['1/16', '1/8', '1/4', '1/2', '1 BAR', '2 BAR', '4 BAR', '8 BAR'];
const LFO_OUTS = ['out', 'sin', 'tri', 'saw', 'sqr', 'rnd', 'smo'];

export class Lfo extends Mod {
  cv = ac.createGain();
  outs = LFO_OUTS.map(() => ac.createGain());
  an = ac.createAnalyser();
  private buf = new Float32Array(32);
  private node: AudioWorkletNode | null = null;
  private clk: number[] = [];
  private ticks = 0;
  private tick = 0;

  constructor(e: Engine) {
    super(e, 'lfo', 'LFO', 'mod', 50, 52);
    this.an.fftSize = 32;
    this.outs[0].connect(this.an);
    this.port('cv', 'RAT', 'cv', 'in', 4, 32);
    this.knobRow([
      { id: 'rate', label: 'RAT', min: 0, max: 1, def: 0.4, fmt: (v) => (this.synced ? LFO_SYNC_NAMES[this.syncIdx(v)] : lfoHz(v).toFixed(2) + 'HZ') },
      { id: 'shape', label: 'SHP', min: 0, max: 5, def: 0, names: ['SIN', 'TRI', 'SAW', 'SQR', 'RND', 'SMO'] },
      { id: 'depth', label: 'DEP', min: 0, max: 1, def: 0.5, fmt: pct },
    ], 13);
    this.port('out', 'OUT', 'cv', 'out', 37, 32);
    this.advanced('ADVANCED', 97, 70);
    const dep = this.cvParam('depth', 35, 51, null, 0.5);
    for (const o of this.outs) dep.connect(o.gain);
    this.advOnly(() => {
      ['SIN', 'TRI', 'SAW', 'SQR', 'RND', 'SMO'].forEach((l, i) =>
        this.port(LFO_OUTS[i + 1], l, 'cv', 'out', 52 + (i % 3) * 15, i < 3 ? 13 : 32));
      this.port('clk', 'CLK', 'trig', 'in', 4, 51);
      this.port('rst', 'RST', 'trig', 'in', 20, 51);
      this.knob({ id: 'uni', label: 'POL', x: 52, y: 51, min: 0, max: 1, def: 0, step: 1, names: ['+-', '+'] });
    });
    void worklet(LFO_PROCESSOR).then(() => {
      const node = new AudioWorkletNode(ac, 'lfo', { outputChannelCount: [7] });
      this.cv.connect(node);
      const split = ac.createChannelSplitter(7);
      node.connect(split);
      this.outs.forEach((o, i) => split.connect(o, i));
      this.node = node;
      for (const id of ['rate', 'shape', 'depth', 'uni']) this.onParam(id);
    });
  }

  get synced() { return this.isAdv && this.tick > 0 && this.eng.cablesAt(this, 'clk').length > 0; }
  private syncIdx(v: number) { return Math.round(v * (LFO_SYNC.length - 1)); }
  private n() { return LFO_SYNC[this.syncIdx(this.p.rate)]; }

  private retime(t: number) {
    const hz = this.synced ? 1 / (this.tick * this.n()) : lfoHz(this.p.rate);
    this.node?.parameters.get('freq')!.setTargetAtTime(hz, Math.max(t, ac.currentTime), 0.005);
  }

  protected layout() { this.onParam('uni'); this.retime(ac.currentTime); }

  onParam(id: string) {
    const t = ac.currentTime;
    if (id === 'rate') this.retime(t);
    if (id === 'shape') this.node?.port.postMessage({ shape: this.p.shape });
    // The basic layout is always bipolar.
    if (id === 'uni') this.node?.port.postMessage({ uni: this.isAdv && this.p.uni === 1 });
    if (id === 'depth') for (const o of this.outs) o.gain.setTargetAtTime(this.p.depth, t, 0.02);
  }

  onEvent(port: string, ev: Ev) {
    if (ev.off || !this.isAdv) return;
    if (port === 'rst') { this.ticks = 0; this.node?.port.postMessage({ reset: ev.t }); }
    if (port !== 'clk') return;
    // Averaged over two ticks, so swing does not wobble the rate.
    const c = (this.clk = [...this.clk.slice(-2), ev.t]);
    const tick = c.length === 3 ? (c[2] - c[0]) / 2 : c.length === 2 ? c[1] - c[0] : 0;
    if (tick > 0.02 && tick < 1 && Math.abs(tick - this.tick) > 0.0005) { this.tick = tick; this.retime(ev.t); }
    // Start the wave over every cycle's worth of ticks, so it stays locked to the bar.
    if (this.ticks % this.n() === 0) this.node?.port.postMessage({ reset: ev.t });
    this.ticks++;
  }

  // Unplugging the clock goes back to the knob's rate.
  schedule() { if (this.tick && !this.eng.cablesAt(this, 'clk').length) { this.tick = 0; this.retime(ac.currentTime); } }
  reset() { this.clk = []; this.ticks = 0; }

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
  audioOut(port: string) { return this.outs[LFO_OUTS.indexOf(port)] ?? null; }
  destroy() { this.node?.disconnect(); }
}

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
    // Advanced: a CV jack under each knob; the gate and output move down a row.
    this.advanced('ADVANCED', 64, 90);
    for (const id of ['a', 'd', 's', 'r']) this.cvKnob(id, this.knobById(id).x + 1, 51);
  }

  protected layout(adv: boolean) {
    this.portById('in').y = this.portById('out').y = adv ? 71 : 51;
  }

  // STOP releases a held envelope now instead of at the end of its last gate.
  reset(t0: number) {
    if (t0) return;
    const t = ac.currentTime, lvl = this.src.offset;
    if (lvl.cancelAndHoldAtTime) lvl.cancelAndHoldAtTime(t);
    else { lvl.cancelScheduledValues(t); lvl.setValueAtTime(lvl.value, t); }
    lvl.setTargetAtTime(0, t, envSec(this.val('r')) / 4);
  }

  onEvent(_port: string, ev: Ev) {
    const a = envSec(this.val('a')), d = envSec(this.val('d')), r = envSec(this.val('r')), s = this.val('s');
    const t = ev.t, lvl = this.src.offset;
    lvl.cancelScheduledValues(t);
    if (ev.off) { lvl.setTargetAtTime(0, t, r / 4); return; }
    const dur = ev.hold ? HOLD : ev.dur;
    // A slide keeps the gate open: no new attack, just a later release.
    if (!ev.slide) {
      lvl.setTargetAtTime((ev.acc ? 1.3 : 1) * velGain(ev.vel), t, a / 4);
      lvl.setTargetAtTime(s * velGain(ev.vel), t + a, d / 4);
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
    led(g, 30, this.isAdv ? 73 : 53, now() - this.flash < 90, C.lime);
  }

  audioOut() { return this.src; }
  destroy() { this.src.stop(); }
}

// VCA response: RSP 0 is linear, 1 exponential (quiet longer, then a steep rise, like
// a VCA in dB). The CV is halved going into the WaveShaper so -2..2 fits; above 1 it
// continues linearly so an accented envelope (1.3) is not clipped.
function vcaCurve(rsp: number) {
  const n = 257, curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 4 - 2, u = Math.abs(x);
    const e = u <= 1 ? (64 ** u - 1) / 63 : u;
    curve[i] = Math.sign(x) * ((1 - rsp) * u + rsp * e);
  }
  return curve;
}

const VCA_CH = 4;
// Jacks and knobs of channel c: channel 1 keeps the basic layout's ids.
const vcaId = (id: string, c: number) => (c ? id + c : id);
// The QUAD layout's columns, with room between them for the normal arrows.
const vcaX = (c: number) => 22 + c * 17;

// Basic: one VCA. Advanced (QUAD), after quad VCAs like Intellijel's and Mutable's Veils:
// four channels, each with IN, CV, LVL (gain with no CV) and a bipolar CV amount, and
// a shared lin/exp response. Like on those, jacks are normalled down the row: an
// unpatched CV jack gets the CV of the channel before it, and an unpatched OUT adds its
// channel into the next one, so the last OUT is the mix of all four. SUM always mixes all four.
export class Vca extends Mod {
  ins = Array.from({ length: VCA_CH }, () => ac.createGain());
  vcas = this.ins.map((g) => g.connect(ac.createGain()) as GainNode);
  buses = this.vcas.map((v) => v.connect(ac.createGain()) as GainNode);
  cvs = this.ins.map(() => ac.createGain());
  cvBuses = this.cvs.map((cv) => cv.connect(ac.createGain()) as GainNode);
  shapers = this.cvBuses.map(() => ac.createWaveShaper());
  amts = this.ins.map(() => ac.createGain());
  // Normals from channel c-1 into channel c: its OUT into the mix, its CV into this CV.
  outNorm = this.ins.map(() => ac.createGain());
  cvNorm = this.ins.map(() => ac.createGain());
  // SUM: all four channels, whatever is patched into the OUTs.
  sum = ac.createGain();

  constructor(e: Engine) {
    super(e, 'vca', 'VCA', 'mod', 50, 52);
    this.advanced('QUAD', 110, 96);
    for (let c = 0; c < VCA_CH; c++) {
      const half = ac.createGain();
      half.gain.value = 0.5;
      this.vcas[c].gain.value = 0;
      this.vcas[c].connect(this.sum);
      this.cvBuses[c].connect(half).connect(this.shapers[c]).connect(this.amts[c]).connect(this.vcas[c].gain);
      if (c) {
        this.buses[c - 1].connect(this.outNorm[c]).connect(this.buses[c]);
        this.cvBuses[c - 1].connect(this.cvNorm[c]).connect(this.cvBuses[c]);
      }
    }
    this.knobRow([
      { id: 'base', label: 'LVL', min: 0, max: 1, def: 0, fmt: pct },
      { id: 'amt', label: 'CV', min: -1, max: 1, def: 1, fmt: pct },
    ], 13);
    io(this, 'audio');
    this.port('cv', 'CV', 'cv', 'in', 20, 32);
    this.advOnly(() => {
      for (let c = 1; c < VCA_CH; c++) {
        this.port('in' + c, String(c + 1), 'audio', 'in', 0, 13);
        this.port('cv' + c, '', 'cv', 'in', 0, 32);
        this.knob({ id: 'base' + c, label: '', name: 'LVL', x: 0, y: 47, min: 0, max: 1, def: 0, fmt: pct });
        this.knob({ id: 'amt' + c, label: '', name: 'CV', x: 0, y: 62, min: -1, max: 1, def: 1, fmt: pct });
        this.port('out' + c, '', 'audio', 'out', 0, 77);
      }
      this.port('sum', 'SUM', 'audio', 'out', 95, 77);
      this.knob({ id: 'rsp', label: 'RSP', x: 94, y: 13, min: 0, max: 1, def: 0, fmt: (v) => (v < 0.02 ? 'LIN' : v > 0.98 ? 'EXP' : pct(v)) });
    });
    this.layout(false);
  }

  // Basic: channel 1's jacks and knobs where they always were. QUAD: a column per
  // channel with row labels on the left; channel 1's jacks lose their names.
  protected layout(adv: boolean) {
    const at = (o: { x: number; y: number }, x: number, y: number) => Object.assign(o, { x, y });
    for (let c = 0; c < VCA_CH; c++) {
      const x = vcaX(c);
      if (c && !adv) continue;
      at(this.portById(vcaId('in', c)), adv ? x + 1 : 4, adv ? 13 : 32);
      at(this.portById(vcaId('cv', c)), adv ? x + 1 : 20, 32);
      at(this.knobById(vcaId('base', c)), adv ? x : 12, adv ? 47 : 13);
      at(this.knobById(vcaId('amt', c)), adv ? x : 27, adv ? 62 : 13);
      at(this.portById(vcaId('out', c)), adv ? x + 1 : 37, adv ? 77 : 32);
    }
    Object.assign(this.portById('in'), { label: adv ? '1' : 'IN' });
    Object.assign(this.portById('cv'), { label: adv ? '' : 'CV' });
    Object.assign(this.portById('out'), { label: adv ? '' : 'OUT' });
    Object.assign(this.knobById('base'), { label: adv ? '' : 'LVL', name: 'LVL' });
    Object.assign(this.knobById('amt'), { label: adv ? '' : 'CV', name: 'CV' });
    // The basic layout is always linear.
    this.onParam('rsp', this.p.rsp ?? 0);
    this.onCables();
  }

  onCables() {
    const t = ac.currentTime;
    for (let c = 1; c < VCA_CH; c++) {
      const free = (id: string) => (this.eng.cablesAt(this, vcaId(id, c - 1)).length ? 0 : 1);
      this.outNorm[c].gain.setTargetAtTime(free('out'), t, 0.005);
      // The CV normal looks at this channel's own jack.
      this.cvNorm[c].gain.setTargetAtTime(this.eng.cablesAt(this, 'cv' + c).length ? 0 : 1, t, 0.005);
    }
  }

  onParam(id: string, v: number) {
    const t = ac.currentTime, c = Number(id.replace(/\D/g, '')) || 0;
    if (id.startsWith('base')) this.vcas[c].gain.setTargetAtTime(v, t, 0.01);
    if (id.startsWith('amt')) this.amts[c].gain.setTargetAtTime(v, t, 0.01);
    if (id === 'rsp') {
      const curve = vcaCurve(this.isAdv ? v : 0);
      for (const sh of this.shapers) sh.curve = curve;
    }
  }

  audioIn(port: string) {
    const c = Number(port.replace(/\D/g, '')) || 0;
    return port.startsWith('cv') ? this.cvs[c] : this.ins[c];
  }

  audioOut(port: string) { return port === 'sum' ? this.sum : this.buses[Number(port.replace(/\D/g, '')) || 0]; }

  drawBody(g: Gfx) {
    if (!this.isAdv) return;
    g.text('IN', 3, 17, C.silver);
    g.text('CV', 3, 35, C.silver);
    g.text('LVL', 3, 50, C.silver);
    g.text('CV', 3, 65, C.silver);
    g.text('OUT', 3, 80, C.silver);
    // Arrows where a normal is active: CV flows right into an empty CV jack, and an
    // unpatched OUT flows right into the next channel's mix.
    for (let c = 1; c < VCA_CH; c++) {
      const x = vcaX(c) - 3;
      if (!this.eng.cablesAt(this, 'cv' + c).length) g.text('>', x, 35, C.green);
      if (!this.eng.cablesAt(this, vcaId('out', c - 1)).length) g.text('>', x, 80, C.red);
    }
  }
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
    this.advanced('ADVANCED', 64, 76);
    for (const id of ['steps', 'hits', 'rot']) this.cvKnob(id, this.knobById(id).x + 1, 58);
  }

  // Steps, hits and rotation, with their CVs.
  private shape() {
    return { n: Math.round(this.val('steps')), hits: Math.round(this.val('hits')), rot: Math.round(this.val('rot')) };
  }

  private hit(i: number, { n, hits, rot } = this.shape()) {
    const k = Math.min(hits, n), j = (((i - rot) % n) + n) % n;
    return (j * k) % n < k;
  }

  reset() { this.pos = -1; this.shown = -1; }

  onEvent(_port: string, ev: Ev) {
    if (ev.off) return;
    const sh = this.shape();
    const s = (this.pos = (this.pos + 1) % sh.n);
    this.eng.at(ev.t, () => (this.shown = s));
    if (this.hit(s, sh)) this.emit('out', ev);
  }

  drawBody(g: Gfx) {
    const sh = this.shape(), n = sh.n;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = 32 + Math.round(Math.sin(a) * 10), y = 25 - Math.round(Math.cos(a) * 10);
      const on = this.hit(i, sh), col = i === this.shown ? C.white : on ? C.yellow : C.slate;
      g.rect(x - 1, y - 1, 3, 3, C.black);
      g.px(x, y, col);
      if (on || i === this.shown) g.rect(x - 1, y - 1, 3, 3, col);
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
    this.advanced('ADVANCED', 50, 70);
    this.cvKnob('prob', 5, 51);
  }

  onEvent(_port: string, ev: Ev) {
    if (ev.off) return;
    const a = Math.random() < this.val('prob');
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

// ---------------------------------------------------------------- PITCH CV

const pitchName = (n: number) => NOTE_NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12 - 1);

// Snaps a pitch CV (1 per octave) to the nearest semitone allowed by a 12-bit mask
// (bit 0 = C), sample by sample.
const QUANT_PROCESSOR = `
class Quant extends AudioWorkletProcessor {
  constructor() {
    super();
    this.mask = 0xfff; this.last = NaN; this.held = 0;
    this.port.onmessage = (e) => { this.mask = e.data; this.last = NaN; };
  }
  snap(v) {
    const semi = v * 12, base = Math.round(semi);
    let best = base, bd = Infinity;
    for (let d = -6; d <= 6; d++) {
      const n = base + d;
      if (!((this.mask >> (((n % 12) + 12) % 12)) & 1)) continue;
      const dist = Math.abs(n - semi);
      if (dist < bd) { bd = dist; best = n; }
    }
    return best / 12;
  }
  process(inputs, outputs) {
    const i = inputs[0][0], o = outputs[0][0];
    if (!o) return true;
    for (let s = 0; s < o.length; s++) {
      const v = i ? i[s] : 0;
      if (v !== this.last) { this.last = v; this.held = this.snap(v); }
      o[s] = this.held;
    }
    return true;
  }
}
registerProcessor('quant', Quant);
`;

const QSCALE_NAMES = [...SCALE_NAMES, 'CHR'];
const QSCALES = [...SCALES, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]];

// Quantizer: pitch CV in, the nearest note of a scale out. KEY and SCL pick the scale;
// clicking the keys toggles single notes for a custom one.
export class Quant extends Mod {
  in = ac.createGain();
  out = ac.createGain();
  mask = 0;
  private node: AudioWorkletNode | null = null;
  private tap = new CvTap();

  constructor(e: Engine) {
    super(e, 'quant', 'QUANT', 'mod', 64, 66);
    // Unquantized until the worklet has loaded.
    this.in.connect(this.out);
    this.out.connect(this.tap.in);
    this.knobRow([
      { id: 'root', label: 'KEY', min: 0, max: 11, def: 0, names: NOTE_NAMES },
      { id: 'scale', label: 'SCL', min: 0, max: 4, def: 0, names: QSCALE_NAMES },
    ], 30, 18);
    this.port('in', 'IN', 'cv', 'in', 5, 48);
    this.port('out', 'OUT', 'cv', 'out', 51, 48);
    void worklet(QUANT_PROCESSOR).then(() => {
      this.node = new AudioWorkletNode(ac, 'quant', { outputChannelCount: [1] });
      this.in.disconnect(this.out);
      this.in.connect(this.node).connect(this.out);
      this.send();
    });
  }

  private send() { this.node?.port.postMessage(this.mask); }

  onParam(id: string) {
    if (id !== 'root' && id !== 'scale') return;
    const root = this.p.root ?? 0;
    this.mask = QSCALES[this.p.scale ?? 0].reduce((m, s) => m | (1 << ((s + root) % 12)), 0);
    this.send();
  }

  private keyAt(lx: number, ly: number) {
    if (ly < 13 || ly >= 27 || lx < 4 || lx >= 60) return -1;
    if (ly < 21) {
      for (const [semi, after] of BLACK) {
        const x = 4 + after * 8 + 6;
        if (lx >= x && lx < x + 5) return semi;
      }
    }
    return WHITE[Math.floor((lx - 4) / 8)];
  }

  drawBody(g: Gfx) {
    const live = this.eng.cablesAt(this, 'in').length > 0;
    const n = PITCH_REF + Math.round(this.tap.read() * 12), cur = live ? ((n % 12) + 12) % 12 : -1;
    const on = (semi: number) => (this.mask >> semi) & 1;
    WHITE.forEach((semi, i) => {
      const x = 4 + i * 8;
      g.rect(x, 13, 7, 14, semi === cur ? C.yellow : C.white);
      if (on(semi)) g.rect(x + 1, 24, 5, 2, C.green);
    });
    for (const [semi, after] of BLACK) {
      const x = 4 + after * 8 + 6;
      g.rect(x, 13, 5, 8, semi === cur ? C.yellow : C.black);
      if (on(semi)) g.rect(x + 1, 18, 3, 2, C.lime);
    }
    g.rect(17, 49, 30, 9, C.black);
    if (live) g.textC(pitchName(n), 32, 51, C.lime);
  }

  press(lx: number, ly: number): Drag | null {
    const semi = this.keyAt(lx, ly);
    if (semi < 0) return null;
    this.mask ^= 1 << semi;
    this.send();
    this.eng.dirty = true;
    return noDrag;
  }

  save() { return this.mask; }
  load(s: unknown) { if (typeof s === 'number') { this.mask = s & 0xfff; this.send(); } }

  audioIn() { return this.in; }
  audioOut() { return this.out; }
  destroy() { this.node?.disconnect(); }
}

// ---------------------------------------------------------------- CHORD

// The four notes of a chord on pitch v (1 per octave), as pitch CVs. Types 0-6 stack
// fixed intervals on v; type 7 (DIA) snaps v to KEY's major scale and stacks thirds
// inside it, so each degree gets its own chord: C MAJ7, D MIN7, E MIN7, F MAJ7 ...
// The CHORD worklet runs this function too, so it must not use anything outside itself.
function chordNotes(v: number, type: number, key: number): number[] {
  const FIXED = [[0, 4, 7, 12], [0, 3, 7, 12], [0, 4, 7, 10], [0, 4, 7, 11], [0, 3, 7, 10], [0, 5, 7, 12], [0, 3, 6, 9]];
  if (type < 7) return FIXED[type].map((s) => v + s / 12);
  const S = [0, 2, 4, 5, 7, 9, 11];
  const r = v * 12 - key, c = Math.round(r);
  let best = c, bd = Infinity;
  for (let n = c - 2; n <= c + 2; n++) {
    const d = Math.abs(n - r);
    if (S.includes(((n % 12) + 12) % 12) && d < bd) { bd = d; best = n; }
  }
  const pc = ((best % 12) + 12) % 12, oct = (best - pc) / 12, deg = S.indexOf(pc);
  return [0, 2, 4, 6].map((k) => (S[(deg + k) % 7] + 12 * (oct + Math.floor((deg + k) / 7)) + key) / 12);
}

const CHORD_TYPES = ['MAJ', 'MIN', '7', 'MAJ7', 'MIN7', 'SUS4', 'DIM', 'DIA'];
const CHORD_QUALITY: Record<string, string> = {
  '0,4,7,12': 'MAJ', '0,3,7,12': 'MIN', '0,4,7,10': '7', '0,4,7,11': 'MAJ7', '0,3,7,10': 'MIN7',
  '0,5,7,12': 'SUS4', '0,3,6,9': 'DIM', '0,3,6,10': 'MIN7B5',
};

function chordName(notes: number[]) {
  const semis = notes.map((n) => Math.round(n * 12));
  const q = CHORD_QUALITY[semis.map((n) => n - semis[0]).join(',')] ?? '';
  return NOTE_NAMES[((semis[0] % 12) + 12) % 12] + ' ' + q;
}

const CHORD_PROCESSOR = `
const chordNotes = ${chordNotes.toString()};
class Chord extends AudioWorkletProcessor {
  constructor() {
    super();
    this.type = 0; this.key = 0; this.last = NaN; this.held = [0, 0, 0, 0];
    this.port.onmessage = (e) => { this.type = e.data.type; this.key = e.data.key; this.last = NaN; };
  }
  process(inputs, outputs) {
    const i = inputs[0][0], o = outputs[0];
    for (let s = 0; s < o[0].length; s++) {
      const v = i ? i[s] : 0;
      if (v !== this.last) { this.last = v; this.held = chordNotes(v, this.type, this.key); }
      for (let k = 0; k < 4; k++) o[k][s] = this.held[k];
    }
    return true;
  }
}
registerProcessor('chord', Chord);
`;

// Chord: one pitch in, the four notes of a chord on it out (1, 3, 5, 7), each for its
// own voice. Triads repeat the root an octave up on 7.
export class Chord extends Mod {
  in = ac.createGain();
  outs = [0, 1, 2, 3].map(() => ac.createGain());
  private node: AudioWorkletNode | null = null;
  private tap = new CvTap();

  constructor(e: Engine) {
    super(e, 'chord', 'CHORD', 'mod', 78, 52);
    this.in.connect(this.tap.in);
    this.knob({ id: 'type', label: 'TYP', x: 4, y: 13, min: 0, max: 7, def: 0, names: CHORD_TYPES });
    this.knob({ id: 'key', label: 'KEY', x: 22, y: 13, min: 0, max: 11, def: 0, names: NOTE_NAMES });
    this.port('in', 'PIT', 'cv', 'in', 4, 32);
    ['1', '3', '5', '7'].forEach((l, k) => this.port('o' + k, l, 'cv', 'out', 23 + k * 14, 32));
    void worklet(CHORD_PROCESSOR).then(() => {
      const node = new AudioWorkletNode(ac, 'chord', { outputChannelCount: [4] });
      const split = ac.createChannelSplitter(4);
      this.in.connect(node).connect(split);
      this.outs.forEach((o, k) => split.connect(o, k));
      this.node = node;
      this.send();
    });
  }

  private send() { this.node?.port.postMessage({ type: this.p.type, key: this.p.key }); }

  onParam() { this.send(); }

  drawBody(g: Gfx) {
    g.rect(39, 14, 36, 11, C.black);
    g.textC(chordName(chordNotes(this.tap.read(), this.p.type, this.p.key)), 57, 17, C.yellow);
  }

  audioIn() { return this.in; }
  audioOut(port: string) { return this.outs[Number(port.slice(1))]; }
  destroy() { this.node?.disconnect(); }
}

// ---------------------------------------------------------------- ARRANGER

// Section lengths in bars (0 = unused), and the lanes: two pattern lanes (A-D, for the
// sequencers' PAT jacks), two gate lanes (on/off, e.g. into a VCA) and two CV lanes
// (a level per section).
const ARR_SECS = 8;
const ARR_LENS = [0, 1, 2, 4, 8, 16];
const ARR_LANES: { name: string; kind: 'pat' | 'gate' | 'cv'; col: string }[] = [
  { name: 'P1', kind: 'pat', col: C.yellow }, { name: 'P2', kind: 'pat', col: C.orange },
  { name: 'G1', kind: 'gate', col: C.lime }, { name: 'G2', kind: 'gate', col: C.green },
  { name: 'C1', kind: 'cv', col: C.sky }, { name: 'C2', kind: 'cv', col: C.cyan },
];
const arrX = (c: number) => 26 + c * 15;
const arrY = (r: number) => 24 + r * 10;

// Song structure over the clock: each column is a section some bars long (a bar is 16
// clock ticks), each row a lane with a value per section. SEC fires at each section
// start; END fires the first time the last section is over, and the song starts again.
export class Arranger extends Mod {
  lens = [4, 4, 4, 4, 0, 0, 0, 0];
  // Per lane, per section: a pattern 0-3, a gate 0/1 or a level 0..1.
  cells = ARR_LANES.map((l) => Array(ARR_SECS).fill(l.kind === 'gate' ? 1 : 0) as number[]);
  private outs = ARR_LANES.map(() => cvSource());
  // Clock ticks since play (-1 before the first), and the time of the last one.
  private n = -1;
  private lastT = -Infinity;
  private resetAt = Infinity;
  private ended = false;
  private shown = { sec: 0, bar: 0 };

  constructor(e: Engine) {
    super(e, 'arranger', 'ARRANGER', 'seq', 160, 110);
    this.port('clk', 'CLK', 'trig', 'in', 4, 12);
    this.port('rst', 'RST', 'trig', 'in', 4, 40);
    ARR_LANES.forEach((_, r) => this.port('o' + r, '', 'cv', 'out', 147, arrY(r)));
    this.port('sec', 'SEC', 'trig', 'out', 118, 90);
    this.port('end', 'END', 'trig', 'out', 140, 90);
    this.apply(0);
  }

  private get bars() { return this.lens.reduce((a, b) => a + b, 0); }

  // Where tick n falls: its section, the bar within it, and whether it starts the section.
  private where(n: number) {
    const ticks = Math.max(1, this.bars) * 16, k = ((n % ticks) + ticks) % ticks;
    let bar = Math.floor(k / 16);
    for (let sec = 0; sec < ARR_SECS; sec++) {
      if (bar < this.lens[sec]) return { sec, bar, start: bar === 0 && k % 16 === 0, wrapped: k === 0 && n > 0 };
      bar -= this.lens[sec];
    }
    return { sec: 0, bar: 0, start: true, wrapped: false };
  }

  // A lane's output value in a section: patterns go out as 0, 1/3, 2/3, 1.
  private value(r: number, sec: number) {
    const v = this.cells[r][sec];
    return ARR_LANES[r].kind === 'pat' ? v / 3 : v;
  }

  // Patterns jump exactly; gates and levels move over a few ms, so a VCA does not click.
  private apply(t: number) {
    const sec = this.where(Math.max(0, this.n)).sec;
    this.outs.forEach((o, r) => {
      if (ARR_LANES[r].kind === 'pat') o.offset.setValueAtTime(this.value(r, sec), t);
      else o.offset.setTargetAtTime(this.value(r, sec), t, 0.004);
    });
  }

  // The tick at time t is either the last one handled or the next one.
  valueAt(port: string, t: number) {
    const r = Number(port.slice(1));
    if (port[0] !== 'o') return undefined;
    const n = t > this.lastT + 0.001 ? (t >= this.resetAt - 0.001 ? 0 : this.n + 1) : this.n;
    return this.value(r, this.where(Math.max(0, n)).sec);
  }

  reset() {
    this.n = -1;
    this.lastT = -Infinity;
    this.resetAt = Infinity;
    this.ended = false;
    this.shown = { sec: 0, bar: 0 };
    this.apply(ac.currentTime);
  }

  onEvent(port: string, ev: Ev) {
    if (ev.off) return;
    if (port === 'rst') { this.resetAt = ev.t; return; }
    if (port !== 'clk') return;
    if (ev.t >= this.resetAt - 0.001) { this.n = -1; this.resetAt = Infinity; }
    this.n++;
    this.lastT = ev.t;
    const w = this.where(this.n);
    this.eng.at(ev.t, () => { this.shown = { sec: w.sec, bar: w.bar }; });
    if (!w.start) return;
    // END fires once per play, so it can stop a recording that started with play.
    if (w.wrapped && !this.ended) { this.ended = true; this.emit('end', { t: ev.t, dur: ev.dur }); }
    this.emit('sec', { t: ev.t, dur: ev.dur });
    this.apply(ev.t);
  }

  drawBody(g: Gfx) {
    const { sec, bar } = this.shown, run = this.eng.running;
    g.text('BAR', 13, 15, C.silver);
    ARR_LANES.forEach((l, r) => g.text(l.name, 16, arrY(r) + 2, l.col));
    for (let c = 0; c < ARR_SECS; c++) {
      const x = arrX(c), len = this.lens[c], cur = run && c === sec;
      g.rect(x, 12, 14, 9, cur ? C.white : len ? C.slate : C.ink);
      g.textC(len ? String(len) : '-', x + 7, 14, cur ? C.ink : len ? C.white : C.slate);
      // how far into the section the song is
      g.rect(x, 21, 14, 1, C.black);
      if (cur && len) g.rect(x, 21, Math.max(1, Math.round(((bar + 1) / len) * 14)), 1, C.lime);
      ARR_LANES.forEach((l, r) => {
        const y = arrY(r), v = this.cells[r][c];
        g.rect(x, y, 14, 9, !len ? C.black : cur ? C.dark : C.ink);
        if (!len) return;
        if (l.kind === 'pat') g.textC('ABCD'[v], x + 7, y + 2, l.col);
        else if (l.kind === 'gate') { if (v) g.rect(x + 1, y + 1, 12, 7, l.col); }
        else if (v > 0) { const h = Math.max(1, Math.round(v * 7)); g.rect(x + 1, y + 8 - h, 12, h, l.col); }
      });
    }
    g.text(run ? `SEC ${sec + 1} BAR ${bar + 1}/${this.lens[sec]}` : `${this.bars} BARS`, 26, 92, C.silver);
  }

  private colAt(lx: number) {
    for (let c = 0; c < ARR_SECS; c++) if (lx >= arrX(c) && lx < arrX(c) + 14) return c;
    return -1;
  }

  // Click a BAR cell to step its length; click a lane cell to step a pattern, flip a
  // gate or set a level (by height). Dragging paints along the row.
  press(lx: number, ly: number): Drag | null {
    const c0 = this.colAt(lx);
    if (c0 < 0) return null;
    if (ly >= 12 && ly < 21) {
      const i = ARR_LENS.indexOf(this.lens[c0]);
      // The first section always plays.
      this.lens[c0] = ARR_LENS[(i + 1) % ARR_LENS.length] || (c0 === 0 ? 1 : 0);
      this.edited();
      return noDrag;
    }
    const r = Math.floor((ly - 24) / 10);
    if (r < 0 || r >= ARR_LANES.length || ly - arrY(r) > 8) return null;
    const kind = ARR_LANES[r].kind, row = this.cells[r];
    const level = (y: number) => Math.min(1, Math.max(0, Math.round(((arrY(r) + 8 - y) / 7) * 4) / 4));
    const val = kind === 'pat' ? (row[c0] + 1) % 4 : kind === 'gate' ? 1 - row[c0] : level(ly);
    const paint = (c: number, y: number) => {
      if (c < 0) return;
      row[c] = kind === 'cv' ? level(y) : val;
      this.edited();
    };
    paint(c0, ly);
    return { move: (x, y) => paint(this.colAt(x), y) };
  }

  private edited() {
    this.eng.dirty = true;
    this.apply(ac.currentTime);
  }

  save() { return { l: this.lens, c: this.cells }; }

  load(s: unknown) {
    const st = s as { l?: unknown; c?: unknown } | null;
    const lens = st?.l;
    if (Array.isArray(lens)) this.lens = this.lens.map((v, i) => (ARR_LENS.includes(Number(lens[i])) ? Number(lens[i]) : v));
    if (!this.lens[0]) this.lens[0] = 1;
    if (Array.isArray(st?.c)) this.cells = this.cells.map((row, r) => row.map((v, i) => {
      const x = Number((st.c as unknown[][])[r]?.[i]);
      return Number.isFinite(x) ? x : v;
    }));
    this.apply(ac.currentTime);
  }

  audioOut(port: string) { return this.outs[Number(port.slice(1))] ?? null; }
  destroy() { for (const o of this.outs) o.stop(); }
}

// ---------------------------------------------------------------- TURING

// A Turing machine: a 16-bit shift register that loops its last LEN bits. CHG is the
// chance that a bit flips as it comes round, so 0 locks a loop and 100% is all random.
// OUT is the low 8 bits as a voltage (0..RNG octaves of pitch, ready for QUANT); GATE
// fires on steps whose newest bit is 1.
export class Turing extends Mod {
  out = cvSource();
  reg = Math.floor(Math.random() * 0x10000);
  private shown = this.reg;

  constructor(e: Engine) {
    super(e, 'turing', 'TURING', 'seq', 64, 66);
    this.knobRow([
      { id: 'chg', label: 'CHG', min: 0, max: 1, def: 0.1, fmt: pct },
      { id: 'len', label: 'LEN', min: 2, max: 16, def: 8, step: 1 },
      { id: 'rng', label: 'RNG', min: 0, max: 2, def: 1, fmt: (v) => v.toFixed(2) + 'OCT' },
    ], 22, 18);
    this.port('clk', 'CLK', 'trig', 'in', 5, 45);
    this.port('out', 'OUT', 'cv', 'out', 36, 45);
    this.port('gate', 'GAT', 'trig', 'out', 51, 45);
    this.advanced('ADVANCED', 64, 84);
    for (const id of ['chg', 'len', 'rng']) this.cvKnob(id, this.knobById(id).x + 1, 64);
  }

  onEvent(_port: string, ev: Ev) {
    if (ev.off) return;
    let bit = (this.reg >> (Math.round(this.val('len')) - 1)) & 1;
    if (Math.random() < this.val('chg')) bit ^= 1;
    const reg = (this.reg = ((this.reg << 1) | bit) & 0xffff);
    this.out.offset.setValueAtTime(((reg & 0xff) / 255) * this.val('rng'), ev.t);
    if (bit) this.emit('gate', ev);
    this.eng.at(ev.t, () => (this.shown = reg));
  }

  drawBody(g: Gfx) {
    // The register, newest bit on the right; bits outside the loop are dim.
    for (let i = 0; i < 16; i++) {
      const on = (this.shown >> (15 - i)) & 1, inLoop = 15 - i < this.p.len;
      g.rect(4 + i * 3 + (i >> 2), 13, 2, 4, on ? (inLoop ? C.yellow : C.slate) : C.black);
    }
  }

  save() { return this.reg; }
  load(s: unknown) { if (typeof s === 'number') this.reg = this.shown = s & 0xffff; }

  audioOut() { return this.out; }
  destroy() { this.out.stop(); }
}

// ---------------------------------------------------------------- LOGIC

interface Span { t: number; end: number } // end is Infinity while a live gate is held

// Gate logic, built for triggers and short gates. AND fires when a gate starts while the
// other input is open (or both start together), lasting while both are open. OR fires on
// every gate of either (gates that start together count once). XOR fires on a gate that
// starts while the other input is closed.
// Gates arrive one at a time while the clock schedules a step, so they are collected
// and judged together once that scheduling pass is done.
export class Logic extends Mod {
  private open: (Span | null)[] = [null, null];
  private pending: { i: number; ev: Ev }[] = [];
  private held = new Set<string>(); // outputs holding a live gate open

  constructor(e: Engine) {
    super(e, 'logic', 'LOGIC', 'seq', 64, 52);
    this.port('and', 'AND', 'trig', 'out', 22, 12);
    this.port('or', 'OR', 'trig', 'out', 37, 12);
    this.port('xor', 'XOR', 'trig', 'out', 51, 12);
    this.port('a', 'A', 'trig', 'in', 5, 32);
    this.port('b', 'B', 'trig', 'in', 20, 32);
  }

  reset() { this.open = [null, null]; this.pending = []; this.held.clear(); }

  onEvent(port: string, ev: Ev) {
    this.pending.push({ i: port === 'a' ? 0 : 1, ev });
    if (this.pending.length === 1) queueMicrotask(() => this.judge());
  }

  private judge() {
    const evs = this.pending.sort((x, y) => x.ev.t - y.ev.t);
    this.pending = [];
    for (let k = 0; k < evs.length;) {
      const t = evs[k].ev.t, started = [false, false];
      let acc = false;
      for (; k < evs.length && evs[k].ev.t - t < 0.001; k++) {
        const { i, ev } = evs[k];
        if (ev.off) { if (this.open[i]) this.open[i]!.end = ev.t; continue; }
        this.open[i] = { t: ev.t, end: ev.hold ? Infinity : ev.t + ev.dur };
        started[i] = true;
        acc ||= !!ev.acc;
      }
      const on = (i: number) => !!this.open[i] && this.open[i]!.t <= t && this.open[i]!.end > t;
      const end = (i: number) => (on(i) ? this.open[i]!.end : t);
      if (started[0] || started[1]) {
        const starters = [0, 1].filter((i) => started[i]);
        this.gate('or', t, Math.max(...starters.map(end)), acc);
        if (on(0) && on(1)) this.gate('and', t, Math.min(end(0), end(1)), acc);
        if (on(0) !== on(1)) this.gate('xor', t, end(on(0) ? 0 : 1), acc);
      }
      // Live gates that were held open close when their condition ends.
      const still = { and: on(0) && on(1), or: on(0) || on(1), xor: on(0) !== on(1) };
      for (const out of [...this.held]) {
        if (!still[out as keyof typeof still]) { this.held.delete(out); this.emit(out, { t, dur: 0, off: true }); }
      }
    }
  }

  private gate(out: string, t: number, end: number, acc: boolean) {
    if (end === Infinity) { this.held.add(out); this.emit(out, { t, dur: 0, hold: true, acc }); }
    else this.emit(out, { t, dur: Math.max(0.005, end - t), acc });
  }
}

// ---------------------------------------------------------------- SEQ SWITCH

// Sequential switch: each trigger passes the next input (of STP) to the output. RST
// goes back to input 1. Works for CV and audio alike.
export class SeqSwitch extends Mod {
  ins = [0, 1, 2, 3].map(() => ac.createGain());
  out = ac.createGain();
  private pos = 0;
  private shown = 0;

  constructor(e: Engine) {
    super(e, 'seqsw', 'SEQ SW', 'mod', 64, 66);
    this.ins.forEach((g, i) => {
      g.gain.value = i === 0 ? 1 : 0;
      g.connect(this.out);
      this.port('i' + i, String(i + 1), 'cv', 'in', 5 + i * 15, 13);
    });
    this.knob({ id: 'steps', label: 'STP', x: 4, y: 32, min: 2, max: 4, def: 4, step: 1 });
    this.port('trg', 'TRG', 'trig', 'in', 5, 51);
    this.port('rst', 'RST', 'trig', 'in', 20, 51);
    // Audio-typed, so it can feed both CV and audio inputs.
    this.port('out', 'OUT', 'audio', 'out', 51, 51);
  }

  private select(i: number, t: number) {
    this.pos = i;
    this.ins.forEach((g, k) => g.gain.setTargetAtTime(k === i ? 1 : 0, t, 0.002));
    this.eng.at(t, () => (this.shown = i));
  }

  reset() { this.select(0, ac.currentTime); }

  onEvent(port: string, ev: Ev) {
    if (ev.off) return;
    this.select(port === 'rst' ? 0 : (this.pos + 1) % this.p.steps, ev.t);
  }

  drawBody(g: Gfx) {
    const i = this.shown;
    g.frame(4 + i * 15, 12, 11, 11, C.lime);
    for (let k = 0; k < this.p.steps; k++) g.rect(23 + k * 8, 36, 5, 3, k === i ? C.lime : C.black);
  }

  audioIn(port: string) { return this.ins[Number(port.slice(1))]; }
  audioOut() { return this.out; }
}

// ---------------------------------------------------------------- CV MIX

// Three CVs, each scaled (and flipped) by its knob, plus an offset.
export class CvMix extends Mod {
  ins = [0, 1, 2].map(() => ac.createGain());
  ofs = cvSource();
  out = ac.createGain();

  constructor(e: Engine) {
    super(e, 'cvmix', 'CV MIX', 'mod', 64, 52);
    for (const g of this.ins) g.connect(this.out);
    this.ofs.connect(this.out);
    const amt = (v: number) => 'X' + v.toFixed(2);
    this.knobRow([
      { id: 'a0', label: '1', min: -1, max: 1, def: 1, fmt: amt },
      { id: 'a1', label: '2', min: -1, max: 1, def: 1, fmt: amt },
      { id: 'a2', label: '3', min: -1, max: 1, def: 1, fmt: amt },
      { id: 'ofs', label: 'OFS', min: -1, max: 1, def: 0, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(2) },
    ], 13);
    this.ins.forEach((_, i) => this.port('i' + i, '', 'cv', 'in', 5 + i * 15, 32));
    this.port('out', 'OUT', 'cv', 'out', 51, 32);
  }

  onParam(id: string, v: number) {
    const t = ac.currentTime;
    if (id === 'ofs') this.ofs.offset.setTargetAtTime(v, t, 0.01);
    else this.ins[Number(id.slice(1))].gain.setTargetAtTime(v, t, 0.01);
  }

  audioIn(port: string) { return this.ins[Number(port.slice(1))]; }
  audioOut() { return this.out; }
  destroy() { this.ofs.stop(); }
}

// ---------------------------------------------------------------- RING MOD

// Multiplies IN by CAR (the carrier): metallic, bell-like sidebands. MIX blends in the dry IN.
export class Ring extends Mod {
  in = ac.createGain();
  car = ac.createGain();
  vca = ac.createGain();
  dry = ac.createGain();
  wet = ac.createGain();
  out = ac.createGain();

  constructor(e: Engine) {
    super(e, 'ring', 'RING', 'fx', 50, 52);
    this.vca.gain.value = 0;
    this.in.connect(this.vca).connect(this.wet).connect(this.out);
    this.car.connect(this.vca.gain);
    this.in.connect(this.dry).connect(this.out);
    this.knob({ id: 'mix', label: 'MIX', x: 4, y: 13, min: 0, max: 1, def: 1, fmt: pct });
    this.port('in', 'IN', 'audio', 'in', 4, 32);
    this.port('car', 'CAR', 'cv', 'in', 20, 32);
    this.port('out', 'OUT', 'audio', 'out', 37, 32);
    this.bypassable();
  }

  onParam(_id: string, v: number) {
    // The product is quieter than its inputs, so the wet side gets a lift.
    this.wet.gain.setTargetAtTime(v * 2, ac.currentTime, 0.02);
    this.dry.gain.setTargetAtTime(1 - v, ac.currentTime, 0.02);
  }

  audioIn(port: string) { return port === 'car' ? this.car : this.in; }
  audioOut() { return this.out; }
}

// ---------------------------------------------------------------- SCOPE

// Window lengths for TIM, in seconds.
const scopeSec = (v: number) => 0.002 * 300 ** v;

// The pitch of a signal by autocorrelation, or 0 if it has none (silence, or a CV
// that steps or drifts rather than oscillates). It works on the signal averaged down
// to a quarter of the sample rate, which keeps it cheap enough to run on every frame
// without a hitch, and refines the peak between samples for the cents.
function detectPitch(raw: Float32Array, rate: number) {
  const D = 4, buf = new Float32Array(raw.length / D);
  let mean = 0;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = (raw[i * D] + raw[i * D + 1] + raw[i * D + 2] + raw[i * D + 3]) / D;
    mean += buf[i];
  }
  mean /= buf.length;
  let rms = 0, crossings = 0;
  for (let i = 0; i < buf.length; i++) {
    buf[i] -= mean;
    rms += buf[i] * buf[i];
    if (i && buf[i - 1] < 0 && buf[i] >= 0) crossings++;
  }
  if (Math.sqrt(rms / buf.length) < 0.01 || crossings < 4) return 0;
  rate /= D;
  const n = buf.length >> 1, minLag = Math.max(2, Math.floor(rate / 4000)), maxLag = Math.min(n, Math.floor(rate / 30));
  const r = new Float32Array(maxLag + 1);
  let best = 0, bestLag = 0, rising = false;
  for (let lag = minLag; lag < maxLag; lag++) {
    let sum = 0, e0 = 0, e1 = 0;
    for (let i = 0; i < n; i++) { sum += buf[i] * buf[i + lag]; e0 += buf[i] * buf[i]; e1 += buf[i + lag] * buf[i + lag]; }
    r[lag] = sum / Math.sqrt(e0 * e1 || 1);
    const prev = lag > minLag ? r[lag - 1] : 1;
    // the first strong peak after the correlation has dipped
    if (r[lag] > prev && prev < 0.5) rising = true;
    if (rising && r[lag] > best) { best = r[lag]; bestLag = lag; }
    if (rising && r[lag] < prev && best > 0.9) break;
  }
  if (best <= 0.8) return 0;
  // a parabola through the peak and its neighbours finds it between samples
  const a = r[bestLag - 1], b = r[bestLag], c = r[bestLag + 1] ?? b;
  const shift = a - 2 * b + c ? (0.5 * (a - c)) / (a - 2 * b + c) : 0;
  return rate / (bestLag + Math.max(-0.5, Math.min(0.5, shift)));
}

// The most recent rising crossing of the signal's mid level in buf[from..to), with some
// hysteresis so noise does not retrigger, or -1. The mid level (halfway between the
// lowest and highest value) also finds signals that never cross zero.
function trigger(buf: Float32Array, from: number, to: number) {
  let lo = Infinity, hi = -Infinity;
  for (let i = from; i < to; i++) { lo = Math.min(lo, buf[i]); hi = Math.max(hi, buf[i]); }
  if (hi - lo < 0.01) return -1;
  const mid = (lo + hi) / 2, hyst = (hi - lo) * 0.1;
  let armed = false, at = -1;
  for (let i = from; i < to; i++) {
    if (buf[i] < mid - hyst) armed = true;
    else if (armed && buf[i] >= mid) { at = i; armed = false; }
  }
  return at;
}

// Two-trace oscilloscope with a tuner on input A. At AMP X1 the screen spans -1..1.
export class Scope extends Mod {
  ins = [ac.createGain(), ac.createGain()];
  ans = [ac.createAnalyser(), ac.createAnalyser()];
  private bufs = [new Float32Array(32768), new Float32Array(32768)];
  private frame = 0;
  private hz = 0;

  constructor(e: Engine) {
    super(e, 'scope', 'SCOPE', 'util', 100, 70);
    this.ins.forEach((g, i) => {
      this.ans[i].fftSize = 32768;
      g.connect(this.ans[i]);
    });
    this.port('a', 'A', 'cv', 'in', 4, 51);
    this.port('b', 'B', 'cv', 'in', 19, 51);
    this.knob({ id: 'tim', label: 'TIM', x: 34, y: 50, min: 0, max: 1, def: 0.4, fmt: (v) => ms(scopeSec(v)) });
    this.knob({ id: 'amp', label: 'AMP', x: 49, y: 50, min: 0.25, max: 4, def: 1, fmt: (v) => 'X' + v.toFixed(2) });
  }

  drawBody(g: Gfx) {
    const x0 = 3, y0 = 12, w = 94, h = 36, mid = y0 + h / 2;
    g.rect(x0, y0, w, h, C.black);
    for (let x = x0 + 4; x < x0 + w; x += 8) g.px(x, mid, C.dark);
    const span = Math.min(16384, Math.floor(scopeSec(this.p.tim) * ac.sampleRate));
    const live = [0, 1].map((i) => this.eng.cablesAt(this, i ? 'b' : 'a').length > 0);
    live.forEach((on, i) => { if (on) this.ans[i].getFloatTimeDomainData(this.bufs[i]); });
    // Hold the picture still on a rising edge of A, or of B when A does not repeat
    // (a stepped pitch CV, say). With neither, the picture rolls.
    const len = this.bufs[0].length, from = Math.max(0, len - 2 * span), to = len - span;
    let start = to;
    for (const i of [0, 1]) {
      const at = live[i] ? trigger(this.bufs[i], from, to) : -1;
      if (at >= 0) { start = at; break; }
    }
    [C.lime, C.sky].forEach((col, i) => {
      if (!live[i]) return;
      const b = this.bufs[i];
      let py = NaN;
      for (let x = 0; x < w; x++) {
        const v = b[Math.min(len - 1, start + Math.floor((x * span) / w))] * this.p.amp;
        const y = Math.round(mid - Math.max(-1, Math.min(1, v)) * (h / 2 - 1));
        const y1 = Number.isNaN(py) ? y : py;
        g.rect(x0 + x, Math.min(y, y1), 1, Math.abs(y - y1) + 1, col);
        py = y;
      }
    });
    // tuner on A, a few times a second
    if (live[0] && this.frame++ % 6 === 0) this.hz = detectPitch(this.bufs[0].subarray(len - 4096), ac.sampleRate);
    if (!live[0]) this.hz = 0;
    g.rect(66, 51, 31, 9, C.black);
    if (this.hz) {
      const n = 69 + 12 * Math.log2(this.hz / 440), near = Math.round(n), cents = Math.round((n - near) * 100);
      g.text(NOTE_NAMES[((near % 12) + 12) % 12] + Math.floor(near / 12 - 1), 68, 53, Math.abs(cents) < 5 ? C.lime : C.yellow);
      g.text((cents >= 0 ? '+' : '') + cents, 84, 53, C.silver);
    }
  }

  audioIn(port: string) { return this.ins[port === 'b' ? 1 : 0]; }
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
    this.advanced('ADVANCED', 50, 52);
    this.cvParam('drive', 20, 32, this.pre.gain, 15);
    this.bypassable();
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
const FOLDS = 10;
export class Fold extends Mod {
  pre = ac.createGain();
  sh = ac.createWaveShaper();
  out = ac.createGain();

  constructor(e: Engine) {
    super(e, 'fold', 'FOLD', 'fx', 50, 52);
    // A fixed curve that folds ten times; FLD is the gain in front of it, so the
    // amount of folding can be modulated at audio rate.
    const n = 4096, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) curve[i] = Math.sin(((i / (n - 1)) * 2 - 1) * FOLDS * (Math.PI / 2));
    this.sh.curve = curve;
    this.pre.connect(this.sh).connect(this.out);
    this.knobRow([
      { id: 'fold', label: 'FLD', min: 0, max: 1, def: 0.4, fmt: pct },
      { id: 'lvl', label: 'LVL', min: 0, max: 1, def: 0.6, fmt: pct },
    ], 13);
    io(this, 'audio');
    this.advanced('ADVANCED', 50, 52);
    this.cvParam('fold', 20, 32, this.pre.gain, 9 / FOLDS / 2);
    this.bypassable();
  }

  onParam(id: string, v: number) {
    const t = ac.currentTime;
    if (id === 'lvl') this.out.gain.setTargetAtTime(v, t, 0.02);
    if (id === 'fold') this.pre.gain.setTargetAtTime((1 + v * 9) / FOLDS, t, 0.02);
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
    this.bypassable();
    void worklet(CRUSH_PROCESSOR).then(() => {
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
  { type: 'drums', label: 'DRUM MACHINE', cat: 'seq', make: (e) => new DrumMachine(e) },
  { type: 'beats', label: 'TRIG SEQ', cat: 'seq', make: (e) => new Beats(e) },
  { type: 'melody', label: 'MELODY', cat: 'seq', make: (e) => new Melody(e) },
  { type: 'keys', label: 'KEYS', cat: 'seq', make: (e) => new Keys(e) },
  { type: 'pads', label: 'PADS', cat: 'seq', make: (e) => new Pads(e) },
  { type: 'divider', label: 'DIVIDER', cat: 'seq', make: (e) => new Divider(e) },
  { type: 'euclid', label: 'EUCLID', cat: 'seq', make: (e) => new Euclid(e) },
  { type: 'chance', label: 'CHANCE', cat: 'seq', make: (e) => new Chance(e) },
  { type: 'turing', label: 'TURING', cat: 'seq', make: (e) => new Turing(e) },
  { type: 'arranger', label: 'ARRANGER', cat: 'seq', make: (e) => new Arranger(e) },
  { type: 'logic', label: 'LOGIC', cat: 'seq', make: (e) => new Logic(e) },
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
  { type: 'quant', label: 'QUANT', cat: 'mod', make: (e) => new Quant(e) },
  { type: 'chord', label: 'CHORD', cat: 'mod', make: (e) => new Chord(e) },
  { type: 'slew', label: 'SLEW', cat: 'mod', make: (e) => new Slew(e) },
  { type: 'cvmix', label: 'CV MIX', cat: 'mod', make: (e) => new CvMix(e) },
  { type: 'seqsw', label: 'SEQ SW', cat: 'mod', make: (e) => new SeqSwitch(e) },
  { type: 'filter', label: 'FILTER', cat: 'fx', make: (e) => new Filter(e) },
  { type: 'delay', label: 'DELAY', cat: 'fx', make: (e) => new Delay(e) },
  { type: 'reverb', label: 'REVERB', cat: 'fx', make: (e) => new Reverb(e) },
  { type: 'drive', label: 'DRIVE', cat: 'fx', make: (e) => new Drive(e) },
  { type: 'fold', label: 'FOLD', cat: 'fx', make: (e) => new Fold(e) },
  { type: 'crush', label: 'CRUSH', cat: 'fx', make: (e) => new Crush(e) },
  { type: 'ring', label: 'RING', cat: 'fx', make: (e) => new Ring(e) },
  { type: 'mixer', label: 'MIXER', cat: 'util', make: (e) => new Mixer(e) },
  { type: 'scope', label: 'SCOPE', cat: 'util', make: (e) => new Scope(e) },
  { type: 'recorder', label: 'RECORDER', cat: 'util', make: (e) => new RecorderMod(e) },
  { type: 'speaker', label: 'SPEAKER', cat: 'util', make: (e) => new Speaker(e) },
  { type: 'maths', label: 'MATHS', cat: 'pro', make: (e) => new Maths(e) },
];
