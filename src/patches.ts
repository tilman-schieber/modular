import { beatSteps, MELODY_PRESETS } from './modules';

export interface PatchData {
  mods: { id: number; type: string; x: number; y: number; p: Record<string, number>; s?: unknown }[];
  cables: { a: number; ap: string; b: number; bp: string }[];
}

class Builder {
  data: PatchData = { mods: [], cables: [] };

  add(type: string, x: number, y: number, p: Record<string, number> = {}, s?: unknown) {
    this.data.mods.push({ id: this.data.mods.length + 1, type, x, y, p, s });
    return this.data.mods.length;
  }

  wire(a: number, ap: string, b: number, bp: string) {
    this.data.cables.push({ a, ap, b, bp });
  }

  beats(x: number, y: number, preset: string) {
    return this.add('beats', x, y, {}, beatSteps(preset));
  }

  melody(x: number, y: number, preset: string, p: Record<string, number> = {}) {
    const pre = MELODY_PRESETS.find((m) => m.name === preset)!;
    return this.add('melody', x, y, { scale: pre.scale, ...p }, pre.notes);
  }
}

function groove() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30);
  const beats = b.beats(82, 30, 'HOUSE');
  const drums = ['kick', 'snare', 'hihat', 'clap'].map((t, i) => b.add(t, 256 + (i % 2) * 56, 22 + (i >> 1) * 58));
  const mixer = b.add('mixer', 378, 40);
  const speaker = b.add('speaker', 458, 60);
  const melody = b.melody(82, 112, 'BASSLINE', { oct: 2 });
  const synth = b.add('synth', 256, 146);
  const delay = b.add('delay', 334, 160);
  const reverb = b.add('reverb', 398, 160);
  const lfo = b.add('lfo', 192, 215, { rate: 0.25, depth: 0.35 });
  b.wire(clock, 'o16', beats, 'clk');
  b.wire(clock, 'o16', melody, 'clk');
  drums.forEach((d, i) => {
    b.wire(beats, 'o' + i, d, 'in');
    b.wire(d, 'out', mixer, 'i' + i);
  });
  b.wire(mixer, 'out', speaker, 'in');
  b.wire(melody, 'note', synth, 'in');
  b.wire(lfo, 'out', synth, 'cv');
  b.wire(synth, 'out', delay, 'in');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  return b.data;
}

function acid() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 132 });
  const beats = b.beats(82, 30, 'TECHNO');
  const kick = b.add('kick', 256, 22, { tune: 45, punch: 0.7, dec: 0.4 });
  const hat = b.add('hihat', 312, 22, { dec: 0.04, tone: 0.7 });
  const clap = b.add('clap', 256, 80);
  const melody = b.melody(82, 112, 'ACID', { oct: 2, gate: 0.6 });
  const synth = b.add('synth', 256, 146, { cut: 0.2, res: 17, env: 0.8, dec: 0.18 });
  const lfo = b.add('lfo', 192, 215, { rate: 0.2, depth: 0.5, shape: 1 });
  const delay = b.add('delay', 334, 160, { time: 0.34, fb: 0.45, mix: 0.3 });
  const mixer = b.add('mixer', 378, 40);
  const speaker = b.add('speaker', 458, 60);
  b.wire(clock, 'o16', beats, 'clk');
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(beats, 'o0', kick, 'in');
  b.wire(beats, 'o2', hat, 'in');
  b.wire(beats, 'o3', clap, 'in');
  b.wire(kick, 'out', mixer, 'i0');
  b.wire(hat, 'out', mixer, 'i1');
  b.wire(clap, 'out', mixer, 'i2');
  b.wire(melody, 'note', synth, 'in');
  b.wire(lfo, 'out', synth, 'cv');
  b.wire(synth, 'out', delay, 'in');
  b.wire(delay, 'out', mixer, 'i3');
  b.wire(mixer, 'out', speaker, 'in');
  return b.data;
}

// The textbook subtractive patch: OSC -> FILTER -> VCA, shaped by an envelope.
function voice() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 110 });
  const melody = b.melody(82, 30, 'ARP', { oct: 3, gate: 0.6 });
  const osc = b.add('osc', 256, 30, { wave: 0 });
  const filter = b.add('filter', 316, 30, { cut: 0.3, res: 8 });
  const vca = b.add('vca', 376, 30);
  const delay = b.add('delay', 436, 30, { time: 0.41, fb: 0.4, mix: 0.3 });
  const reverb = b.add('reverb', 496, 30, { size: 0.6, mix: 0.3 });
  const env = b.add('env', 256, 100, { a: 0.05, d: 0.55, s: 0.2, r: 0.5 });
  const lfo = b.add('lfo', 336, 100, { rate: 0.55, depth: 0.02 });
  const speaker = b.add('speaker', 436, 100);
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(melody, 'note', osc, 'in');
  b.wire(melody, 'note', env, 'in');
  b.wire(lfo, 'out', osc, 'cv');
  b.wire(osc, 'out', filter, 'in');
  b.wire(env, 'out', filter, 'cv');
  b.wire(filter, 'out', vca, 'in');
  b.wire(env, 'out', vca, 'cv');
  b.wire(vca, 'out', delay, 'in');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  return b.data;
}

function ambient() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 70 });
  const melody = b.melody(82, 30, 'DRONE', { oct: 3, gate: 1 });
  const oscA = b.add('osc', 256, 30, { wave: 0, glide: 0.3 });
  const oscB = b.add('osc', 256, 90, { wave: 2, oct: 1, glide: 0.3 });
  const noise = b.add('noise', 256, 150, { tone: 0.5, lvl: 0.12 });
  const drift = b.add('lfo', 176, 140, { rate: 0.15, depth: 0.015 });
  const mixer = b.add('mixer', 320, 40, { l0: 0.6, l1: 0.5, l2: 0.6 });
  const filter = b.add('filter', 398, 40, { cut: 0.4, res: 5 });
  const sweep = b.add('lfo', 398, 110, { rate: 0.05, depth: 0.6 });
  const reverb = b.add('reverb', 458, 40, { size: 1, mix: 0.6 });
  const delay = b.add('delay', 518, 40, { time: 0.8, fb: 0.6, mix: 0.4 });
  const speaker = b.add('speaker', 458, 110);
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(melody, 'note', oscA, 'in');
  b.wire(melody, 'note', oscB, 'in');
  b.wire(drift, 'out', oscB, 'cv');
  b.wire(oscA, 'out', mixer, 'i0');
  b.wire(oscB, 'out', mixer, 'i1');
  b.wire(noise, 'out', mixer, 'i2');
  b.wire(mixer, 'out', filter, 'in');
  b.wire(sweep, 'out', filter, 'cv');
  b.wire(filter, 'out', reverb, 'in');
  b.wire(reverb, 'out', delay, 'in');
  b.wire(delay, 'out', speaker, 'in');
  return b.data;
}

function boomBap() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 88, swing: 0.22 });
  const beats = b.beats(82, 30, 'BOOMBAP');
  const kick = b.add('kick', 256, 22, { tune: 45, dec: 0.7, punch: 0.3 });
  const snare = b.add('snare', 312, 22, { tune: 160, dec: 0.25 });
  const hat = b.add('hihat', 256, 80, { tone: 0.2 });
  const melody = b.melody(82, 112, 'PENTA', { oct: 2, gate: 0.8, root: 9 });
  const synth = b.add('synth', 256, 146, { wave: 2, cut: 0.45, res: 2, env: 0.3, dec: 0.4 });
  const mixer = b.add('mixer', 378, 40, { l2: 0.5 });
  const filter = b.add('filter', 458, 40, { cut: 0.72, res: 1 });
  const wobble = b.add('lfo', 458, 110, { rate: 0.3, depth: 0.08 });
  const reverb = b.add('reverb', 518, 40, { size: 0.3, mix: 0.2 });
  const speaker = b.add('speaker', 518, 110);
  b.wire(clock, 'o16', beats, 'clk');
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(beats, 'o0', kick, 'in');
  b.wire(beats, 'o1', snare, 'in');
  b.wire(beats, 'o2', hat, 'in');
  b.wire(kick, 'out', mixer, 'i0');
  b.wire(snare, 'out', mixer, 'i1');
  b.wire(hat, 'out', mixer, 'i2');
  b.wire(melody, 'note', synth, 'in');
  b.wire(synth, 'out', mixer, 'i3');
  b.wire(mixer, 'out', filter, 'in');
  b.wire(wobble, 'out', filter, 'cv');
  b.wire(filter, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  return b.data;
}

// Minimal 4/4 with filtered stabs drowning in delay and reverb, plus a sine sub doubling them.
function dubTechno() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 120 });
  const beats = b.beats(82, 30, 'TECHNO');
  const kick = b.add('kick', 256, 22, { tune: 42, punch: 0.4, dec: 0.6 });
  const hat = b.add('hihat', 312, 22, { tone: 0.3, dec: 0.05 });
  const clap = b.add('clap', 256, 80, { tone: 900, dec: 0.3 });
  const mixer = b.add('mixer', 378, 40, { l1: 0.5, l2: 0.35, l3: 0.7 });
  const speaker = b.add('speaker', 458, 60);
  const melody = b.melody(82, 112, 'STABS', { scale: 1, root: 2, oct: 3, gate: 0.25 });
  const stab = b.add('synth', 256, 146, { wave: 0, cut: 0.38, res: 7, env: 0.45, dec: 0.12 });
  const lfo = b.add('lfo', 192, 215, { rate: 0.12, shape: 1, depth: 0.3 });
  const delay = b.add('delay', 334, 160, { time: 0.375, fb: 0.62, mix: 0.5 });
  const reverb = b.add('reverb', 398, 160, { size: 0.85, mix: 0.45 });
  const sub = b.add('synth', 256, 228, { wave: 3, oct: -1, cut: 0.5, env: 0, dec: 0.3 });
  b.wire(clock, 'o16', beats, 'clk');
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(beats, 'o0', kick, 'in');
  b.wire(beats, 'o2', hat, 'in');
  b.wire(beats, 'o3', clap, 'in');
  b.wire(kick, 'out', mixer, 'i0');
  b.wire(hat, 'out', mixer, 'i1');
  b.wire(clap, 'out', mixer, 'i2');
  b.wire(melody, 'note', stab, 'in');
  b.wire(melody, 'note', sub, 'in');
  b.wire(sub, 'out', mixer, 'i3');
  b.wire(lfo, 'out', stab, 'cv');
  b.wire(stab, 'out', delay, 'in');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  b.wire(mixer, 'out', speaker, 'in');
  return b.data;
}

function disco() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 118, swing: 0.08 });
  const beats = b.beats(82, 30, 'DISCO');
  const drums = ['kick', 'snare', 'hihat', 'cowbell'].map((t, i) => b.add(t, 256 + (i % 2) * 56, 22 + (i >> 1) * 58));
  const mixer = b.add('mixer', 378, 40, { l3: 0.4 });
  const speaker = b.add('speaker', 458, 60);
  const melody = b.melody(82, 112, 'OCTAVES', { oct: 2, gate: 0.4, root: 5 });
  const synth = b.add('synth', 256, 146, { wave: 0, cut: 0.42, res: 5, env: 0.5, dec: 0.15 });
  const delay = b.add('delay', 334, 160, { time: 0.25, fb: 0.3, mix: 0.2 });
  b.wire(clock, 'o16', beats, 'clk');
  b.wire(clock, 'o16', melody, 'clk');
  drums.forEach((d, i) => {
    b.wire(beats, 'o' + i, d, 'in');
    b.wire(d, 'out', mixer, 'i' + i);
  });
  b.wire(mixer, 'out', speaker, 'in');
  b.wire(melody, 'note', synth, 'in');
  b.wire(synth, 'out', delay, 'in');
  b.wire(delay, 'out', speaker, 'in');
  return b.data;
}

export const PATCHES: { name: string; build: () => PatchData }[] = [
  { name: '808 GROOVE', build: groove },
  { name: 'ACID TECHNO', build: acid },
  { name: 'BUILD A VOICE', build: voice },
  { name: 'AMBIENT DRIFT', build: ambient },
  { name: 'BOOM BAP', build: boomBap },
  { name: 'DUB TECHNO', build: dubTechno },
  { name: 'DISCO BELL', build: disco },
  { name: 'EMPTY', build: () => ({ mods: [], cables: [] }) },
];
