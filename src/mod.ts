import { ac } from './audio';
import { C, type Gfx } from './gfx';
import type { Engine } from './engine';

export type SigType = 'trig' | 'audio' | 'cv';
export type Cat = 'util' | 'drum' | 'seq' | 'synth' | 'mod' | 'fx' | 'pro';

// Category colours: `bar` is used for title bars and the matching toolbar menu.
export const CAT: Record<Cat, { name: string; bar: string; cap: string }> = {
  seq: { name: 'SEQUENCE', bar: C.plum, cap: C.yellow },
  drum: { name: 'DRUMS', bar: C.red, cap: C.orange },
  synth: { name: 'SOUND', bar: C.blue, cap: C.sky },
  mod: { name: 'MODULATE', bar: C.moss, cap: C.lime },
  fx: { name: 'EFFECTS', bar: C.teal, cap: C.cyan },
  util: { name: 'OUTPUT', bar: C.slate, cap: C.silver },
  // Models of real hardware modules: deeper, with more jacks.
  pro: { name: 'ADVANCED', bar: C.rust, cap: C.yellow },
};

export const TYPEC: Record<SigType, string> = { trig: C.yellow, audio: C.red, cv: C.green };

// Audio can drive CV inputs (for FM and ring-mod sounds); everything else must match.
// CV cables are continuous control signals: roughly -1..1 for modulation, or pitch
// at 1 per octave. Trig cables carry gates and triggers as exactly timed events.
export function compatible(out: SigType, inp: SigType) {
  return out === inp || (out === 'audio' && inp === 'cv');
}

// A CV input read from JS, for knobs that are used when scheduling rather than
// being Web Audio params (e.g. a drum's tune, the clock's tempo).
export class CvTap {
  in = ac.createGain();
  private an = ac.createAnalyser();
  private buf = new Float32Array(32);

  constructor() {
    this.an.fftSize = 32;
    this.in.connect(this.an);
  }

  read() {
    this.an.getFloatTimeDomainData(this.buf);
    return this.buf[this.buf.length - 1] || 0;
  }
}

// A gate or trigger on a trig cable: when it opens and how long it stays open, plus
// an accent and a slide (legato: the voice keeps sounding while the pitch CV glides).
// Live playing adds `hold` (open until the gate-off), `off` (the gate-off itself)
// and `vel` (MIDI velocity, 0..1). Pitch travels separately, as CV.
export interface Ev {
  t: number; dur: number;
  acc?: boolean; slide?: boolean;
  hold?: boolean; off?: boolean; vel?: number;
}

// Loudness for a velocity: soft notes stay audible, no velocity means full.
export const velGain = (vel?: number) => (vel === undefined ? 1 : 0.25 + 0.75 * vel);

// Pitch CV: 1 per octave, 0 is this MIDI note (C3, what OSC and SYNTH play with no pitch in).
export const PITCH_REF = 48;

// `adv` jacks and knobs only show in a module's advanced layout.
export interface Port { id: string; label: string; type: SigType; dir: 'in' | 'out'; x: number; y: number; adv?: boolean }

export interface Knob {
  id: string; label: string; x: number; y: number; adv?: boolean;
  // For help, when the label is left blank to pack knobs tightly.
  name?: string;
  min: number; max: number; def: number;
  step?: number;
  names?: string[];
  fmt?: (v: number) => string;
}

export type KnobDef = Omit<Knob, 'x' | 'y'>;

export interface Drag { move(lx: number, ly: number): void; up?(): void }

export abstract class Mod {
  id = 0;
  x = 0;
  y = 0;
  // The jacks and knobs showing in the current layout.
  ports: Port[] = [];
  knobs: Knob[] = [];
  p: Record<string, number> = {};
  // Modules with an advanced (or "big") layout get a +/- toggle in the title bar;
  // advName is its tooltip. The layout is the `adv` param, so it saves like a knob.
  advName = '';
  private sizes: [number, number][] = [];
  private allPorts: Port[] = [];
  private allKnobs: Knob[] = [];
  private building = false;
  // Advanced-layout CV jacks that move a knob ('cv_<knob id>'), and the taps of the
  // ones that are read when a note or step is scheduled.
  private cvIns: Record<string, AudioNode> = {};
  private knobTaps: Record<string, CvTap> = {};
  // MIDI CC number mapped to each knob, by knob id.
  cc: Record<string, number> = {};
  // Effects can be bypassed (shift+click): IN goes straight to OUT. The `byp` param.
  private byp: { in: GainNode; out: GainNode; dry: GainNode; wet: GainNode } | null = null;

  constructor(
    public eng: Engine, public type: string, public title: string,
    public cat: Cat, public w: number, public h: number,
  ) {}

  port(id: string, label: string, type: SigType, dir: 'in' | 'out', x: number, y: number) {
    this.allPorts.push({ id, label, type, dir, x, y, adv: this.building });
    this.refresh();
  }

  knob(k: Knob) {
    if (k.names) { k.min = 0; k.max = k.names.length - 1; k.step = 1; }
    k.adv = this.building;
    this.allKnobs.push(k);
    this.refresh();
    this.p[k.id] = k.def;
    this.onParam(k.id, k.def);
  }

  get isAdv() { return this.p.adv === 1; }

  // Give the module an advanced layout of size w x h, named `name` on its toggle.
  protected advanced(name: string, w: number, h: number) {
    this.advName = name;
    this.sizes = [[this.w, this.h], [w, h]];
    this.p.adv = 0;
  }

  // Jacks and knobs added inside fn only show in the advanced layout.
  protected advOnly(fn: () => void) {
    this.building = true;
    fn();
    this.building = false;
  }

  // A CV jack (advanced layout only) for a knob that is read when a note or step is
  // scheduled. A CV of 1 moves the knob by half its range; read it with val().
  protected cvKnob(id: string, x: number, y: number) {
    const tap = new CvTap();
    this.knobTaps[id] = tap;
    this.cvJack(id, x, y, tap.in);
  }

  // A CV jack (advanced layout only) for a knob that is a Web Audio param: the CV,
  // times scale, is added to the param.
  protected cvParam(id: string, x: number, y: number, param: AudioParam | null, scale: number) {
    const g = ac.createGain();
    g.gain.value = scale;
    if (param) g.connect(param);
    this.cvJack(id, x, y, g);
    return g;
  }

  private cvJack(id: string, x: number, y: number, node: AudioNode) {
    const label = this.knobById(id).label;
    this.advOnly(() => this.port('cv_' + id, label, 'cv', 'in', x, y));
    this.cvIns['cv_' + id] = node;
  }

  // A knob's value with its CV added, kept within the knob's range.
  val(id: string) {
    const tap = this.knobTaps[id], v = this.p[id];
    if (!tap) return v;
    const k = this.knobById(id);
    return Math.min(k.max, Math.max(k.min, v + (tap.read() * (k.max - k.min)) / 2));
  }

  // An input CV at time t, for values read when scheduling ahead. A source that knows
  // its own schedule (valueAt, e.g. ARRANGER) gives it exactly; any other is read now.
  cvAt(port: string, t: number, tap: CvTap) {
    let sum = 0;
    for (const c of this.eng.cables) {
      if (c.b !== this || c.bp !== port) continue;
      const v = c.a.valueAt(c.ap, t);
      if (v === undefined) return tap.read();
      sum += v;
    }
    return sum;
  }

  // What output `port` will be at time t, if this module knows it ahead of time.
  valueAt(_port: string, _t: number): number | undefined { return undefined; }

  // Where a cable plugged into this input goes, and where one from this output comes from.
  input(port: string) {
    if (this.byp && port === 'in') return this.byp.in;
    return this.cvIns[port] ?? this.audioIn(port);
  }

  output(port: string) {
    if (this.byp && port === 'out') return this.byp.out;
    return this.audioOut(port);
  }

  // Let the effect be bypassed. Call at the end of the constructor: from then on the
  // 'in' and 'out' jacks go through a dry/wet switch around the effect.
  protected bypassable() {
    const g = () => ac.createGain();
    const b = { in: g(), out: g(), dry: g(), wet: g() };
    b.dry.gain.value = 0;
    b.in.connect(this.audioIn('in')!);
    b.in.connect(b.dry).connect(b.out);
    this.audioOut('out')!.connect(b.wet).connect(b.out);
    this.byp = b;
    this.p.byp = 0;
  }

  get canBypass() { return this.byp !== null; }
  get bypassed() { return this.p.byp === 1; }

  protected portById(id: string) { return this.allPorts.find((p) => p.id === id)!; }
  protected knobById(id: string) { return this.allKnobs.find((k) => k.id === id)!; }

  private refresh() {
    const shown = (x: { adv?: boolean }) => !x.adv || this.isAdv;
    this.ports = this.allPorts.filter(shown);
    this.knobs = this.allKnobs.filter(shown);
  }

  // Switch layouts; cables on jacks that disappear are unplugged.
  private applyLayout() {
    [this.w, this.h] = this.sizes[this.isAdv ? 1 : 0];
    this.refresh();
    this.layout(this.isAdv);
    const has = (id: string, dir: 'in' | 'out') => this.ports.some((p) => p.id === id && p.dir === dir);
    for (const c of [...this.eng.cables]) {
      if ((c.a === this && !has(c.ap, 'out')) || (c.b === this && !has(c.bp, 'in'))) this.eng.disconnect(c);
    }
  }

  // Move jacks and knobs that sit elsewhere in the advanced layout.
  protected layout(_adv: boolean) {}

  // Lay out knobs in a centered row with a fixed pitch.
  knobRow(defs: KnobDef[], y: number, pitch = 15) {
    const total = (defs.length - 1) * pitch + 11;
    const x0 = Math.floor((this.w - total) / 2);
    defs.forEach((d, i) => this.knob({ ...d, x: x0 + i * pitch, y }));
  }

  set(id: string, v: number) {
    this.p[id] = v;
    if (id === 'adv' && this.advName) this.applyLayout();
    if (id === 'byp' && this.byp) {
      const t = ac.currentTime;
      this.byp.dry.gain.setTargetAtTime(v, t, 0.005);
      this.byp.wet.gain.setTargetAtTime(1 - v, t, 0.005);
    }
    this.onParam(id, v);
    this.eng.dirty = true;
  }

  setKnob(k: Knob, v: number) {
    v = Math.min(k.max, Math.max(k.min, v));
    if (k.step) v = Math.round(v / k.step) * k.step;
    if (v !== this.p[k.id]) this.set(k.id, v);
  }

  knobText(k: Knob) {
    const v = this.p[k.id];
    if (k.names) return k.names[Math.round(v)];
    if (k.fmt) return k.fmt(v);
    return k.step ? String(Math.round(v)) : v.toFixed(2);
  }

  knobLabel(k: Knob) {
    return k.names ? this.knobText(k) : k.label;
  }

  emit(port: string, ev: Ev) { this.eng.emit(this, port, ev); }

  onParam(_id: string, _v: number) {}
  onEvent(_port: string, _ev: Ev) {}
  // A cable was plugged into or out of one of this module's jacks.
  onCables() {}
  schedule(_until: number) {}
  reset(_t0: number) {}
  // Audio and CV ports are both plain Web Audio nodes.
  audioIn(_port: string): AudioNode | null { return null; }
  audioOut(_port: string): AudioNode | null { return null; }
  drawBody(_g: Gfx) {}
  press(_lx: number, _ly: number): Drag | null { return null; }
  // Shift+click on the module body; return true if used (otherwise it toggles selection).
  // On an effect it switches the bypass.
  pressShift(_lx: number, _ly: number) {
    if (!this.byp) return false;
    this.set('byp', this.bypassed ? 0 : 1);
    return true;
  }
  // Alt+click on the module body; return true if used.
  pressAlt(_lx: number, _ly: number) { return false; }
  // The computer keyboard, for modules played live (KEYS, PADS); return true if the
  // key was used. allOff lets go of every held key, e.g. when the window loses focus.
  key(_code: string, _down: boolean) { return false; }
  allOff() {}
  save(): unknown { return undefined; }
  load(_s: unknown) {}
  destroy() {}
}
