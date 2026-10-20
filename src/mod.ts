import { C, type Gfx } from './gfx';
import type { Engine } from './engine';

export type SigType = 'trig' | 'note' | 'audio' | 'cv';
export type Cat = 'util' | 'drum' | 'seq' | 'synth' | 'mod' | 'fx';

// Category colours: `bar` is used for title bars and the matching toolbar menu.
export const CAT: Record<Cat, { name: string; bar: string; cap: string }> = {
  seq: { name: 'SEQUENCE', bar: C.plum, cap: C.yellow },
  drum: { name: 'DRUMS', bar: C.red, cap: C.orange },
  synth: { name: 'SOUND', bar: C.blue, cap: C.sky },
  mod: { name: 'MODULATE', bar: C.green, cap: C.lime },
  fx: { name: 'EFFECTS', bar: C.teal, cap: C.cyan },
  util: { name: 'OUTPUT', bar: C.slate, cap: C.silver },
};

export const TYPEC: Record<SigType, string> = { trig: C.yellow, note: C.sky, audio: C.red, cv: C.green };

// Notes can also fire trigger inputs; everything else must match exactly.
// CV cables are continuous control signals (roughly -1..1) that modulate knobs.
export function compatible(out: SigType, inp: SigType) {
  return out === inp || (out === 'note' && inp === 'trig');
}

// An event on a trig/note cable: when it happens, how long one step lasts, and an optional MIDI note.
export interface Ev { t: number; dur: number; note?: number }

export interface Port { id: string; label: string; type: SigType; dir: 'in' | 'out'; x: number; y: number }

export interface Knob {
  id: string; label: string; x: number; y: number;
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
  ports: Port[] = [];
  knobs: Knob[] = [];
  p: Record<string, number> = {};

  constructor(
    public eng: Engine, public type: string, public title: string,
    public cat: Cat, public w: number, public h: number,
  ) {}

  port(id: string, label: string, type: SigType, dir: 'in' | 'out', x: number, y: number) {
    this.ports.push({ id, label, type, dir, x, y });
  }

  knob(k: Knob) {
    if (k.names) { k.min = 0; k.max = k.names.length - 1; k.step = 1; }
    this.knobs.push(k);
    this.p[k.id] = k.def;
    this.onParam(k.id, k.def);
  }

  // Lay out knobs in a centered row with a fixed pitch.
  knobRow(defs: KnobDef[], y: number, pitch = 15) {
    const total = (defs.length - 1) * pitch + 11;
    const x0 = Math.floor((this.w - total) / 2);
    defs.forEach((d, i) => this.knob({ ...d, x: x0 + i * pitch, y }));
  }

  set(id: string, v: number) {
    this.p[id] = v;
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
  schedule(_until: number) {}
  reset(_t0: number) {}
  // Audio and CV ports are both plain Web Audio nodes.
  audioIn(_port: string): AudioNode | null { return null; }
  audioOut(_port: string): AudioNode | null { return null; }
  drawBody(_g: Gfx) {}
  press(_lx: number, _ly: number): Drag | null { return null; }
  save(): unknown { return undefined; }
  load(_s: unknown) {}
  destroy() {}
}
