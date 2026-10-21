import { ac } from './audio';
import { compatible, type Ev, type Mod, type SigType } from './mod';

export interface Cable { a: Mod; ap: string; b: Mod; bp: string; type: SigType; lit: number }

const LOOKAHEAD = 0.12;

export class Engine {
  mods: Mod[] = [];
  cables: Cable[] = [];
  running = false;
  dirty = false;
  master: GainNode;
  private nextId = 0;
  private queue: { t: number; fn: () => void }[] = [];
  private depth = 0;

  constructor() {
    this.master = ac.createGain();
    this.master.gain.value = 0.8;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ac.destination);
    setInterval(() => this.tick(), 25);
  }

  private tick() {
    if (!this.running) return;
    const until = ac.currentTime + LOOKAHEAD;
    for (const m of this.mods) m.schedule(until);
  }

  start() {
    void ac.resume();
    const t0 = ac.currentTime + 0.05;
    for (const m of this.mods) m.reset(t0);
    this.running = true;
    this.tick();
  }

  stop() {
    this.running = false;
    this.queue = [];
    for (const m of this.mods) m.reset(0);
  }

  // Run fn on the UI side once the audio clock reaches t (for LEDs and step lights).
  at(t: number, fn: () => void) {
    this.queue.push({ t, fn });
  }

  flush() {
    if (!this.queue.length) return;
    const now = ac.currentTime;
    const rest = [];
    for (const e of this.queue) {
      if (e.t <= now) e.fn();
      else rest.push(e);
    }
    this.queue = rest;
  }

  emit(m: Mod, port: string, ev: Ev) {
    // Guards against feedback loops like a sequencer clocking itself.
    if (this.depth > 16) return;
    this.depth++;
    try {
      for (const c of this.cables) {
        if (c.a !== m || c.ap !== port) continue;
        if (!ev.off) this.at(ev.t, () => (c.lit = performance.now()));
        c.b.onEvent(c.bp, ev);
      }
    } finally {
      this.depth--;
    }
  }

  add(m: Mod) {
    m.id = ++this.nextId;
    this.mods.push(m);
    if (this.running) m.reset(ac.currentTime + 0.05);
    this.dirty = true;
  }

  remove(m: Mod) {
    for (const c of this.cables.filter((c) => c.a === m || c.b === m)) this.disconnect(c);
    this.mods = this.mods.filter((x) => x !== m);
    m.destroy();
    this.dirty = true;
  }

  clear() {
    for (const m of [...this.mods]) this.remove(m);
  }

  connect(a: Mod, ap: string, b: Mod, bp: string): Cable | null {
    const po = a.ports.find((p) => p.id === ap && p.dir === 'out');
    const pi = b.ports.find((p) => p.id === bp && p.dir === 'in');
    if (!po || !pi || !compatible(po.type, pi.type)) return null;
    if (this.cables.some((c) => c.a === a && c.ap === ap && c.b === b && c.bp === bp)) return null;
    if (po.type === 'audio' || po.type === 'cv') {
      const o = a.audioOut(ap), i = b.input(bp);
      if (!o || !i) return null;
      o.connect(i);
    }
    const c: Cable = { a, ap, b, bp, type: po.type, lit: 0 };
    this.cables.push(c);
    this.dirty = true;
    return c;
  }

  disconnect(c: Cable) {
    this.cables = this.cables.filter((x) => x !== c);
    if (c.type === 'audio' || c.type === 'cv') {
      try { c.a.audioOut(c.ap)!.disconnect(c.b.input(c.bp)!); } catch { /* already gone */ }
    }
    this.dirty = true;
  }

  cablesAt(m: Mod, port: string) {
    return this.cables.filter((c) => (c.a === m && c.ap === port) || (c.b === m && c.bp === port));
  }
}
