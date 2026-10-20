import { beatSteps, MELODY_PRESETS, melodyState } from './modules';

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
    return this.add('melody', x, y, { scale: pre.scale, ...p }, melodyState(preset));
  }

  // A melody from scratch: rows per step (-1 = rest).
  notes(x: number, y: number, notes: number[], p: Record<string, number> = {}) {
    return this.add('melody', x, y, p, { n: notes });
  }
}

function groove() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30);
  const beats = b.beats(82, 30, 'HOUSE');
  const drums = ['kick', 'snare', 'hihat', 'clap'].map((t, i) => b.add(t, 256 + (i % 2) * 56, 14 + (i >> 1) * 66));
  const mixer = b.add('mixer', 378, 40);
  const speaker = b.add('speaker', 458, 60);
  const melody = b.melody(82, 116, 'BASSLINE', { oct: 2 });
  const synth = b.add('synth', 256, 146);
  const delay = b.add('delay', 334, 160);
  const reverb = b.add('reverb', 398, 160);
  const lfo = b.add('lfo', 192, 226, { rate: 0.25, depth: 0.35 });
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
  const kick = b.add('kick', 256, 14, { kit: 1, tune: 55, punch: 0.7, dec: 0.35 });
  const hat = b.add('hihat', 312, 14, { kit: 1, dec: 0.04, tone: 0.7 });
  const clap = b.add('clap', 256, 80);
  const melody = b.melody(82, 116, 'ACID', { oct: 2, gate: 0.6 });
  const synth = b.add('synth', 256, 146, { cut: 0.2, res: 17, env: 0.8, dec: 0.18 });
  const lfo = b.add('lfo', 192, 226, { rate: 0.2, depth: 0.5, shape: 1 });
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
  const filter = b.add('filter', 330, 30, { cut: 0.3, res: 8 });
  const vca = b.add('vca', 390, 30);
  const delay = b.add('delay', 450, 30, { time: 0.41, fb: 0.4, mix: 0.3 });
  const reverb = b.add('reverb', 510, 30, { size: 0.6, mix: 0.3 });
  const env = b.add('env', 256, 100, { a: 0.05, d: 0.55, s: 0.2, r: 0.5 });
  const lfo = b.add('lfo', 340, 100, { rate: 0.55, depth: 0.02 });
  const speaker = b.add('speaker', 450, 100);
  // Play the same voice live from the computer keyboard.
  const keys = b.add('keys', 82, 142);
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(melody, 'note', osc, 'in');
  b.wire(melody, 'note', env, 'in');
  b.wire(keys, 'note', osc, 'in');
  b.wire(keys, 'note', env, 'in');
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
  const mixer = b.add('mixer', 330, 40, { l0: 0.6, l1: 0.5, l2: 0.6 });
  const filter = b.add('filter', 408, 40, { cut: 0.4, res: 5 });
  const sweep = b.add('lfo', 408, 110, { rate: 0.05, depth: 0.6 });
  const reverb = b.add('reverb', 468, 40, { size: 1, mix: 0.6 });
  const delay = b.add('delay', 528, 40, { time: 0.8, fb: 0.6, mix: 0.4 });
  const speaker = b.add('speaker', 468, 110);
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
  const kick = b.add('kick', 256, 14, { kit: 4, tune: 45, dec: 0.7, punch: 0.3 });
  const snare = b.add('snare', 312, 14, { kit: 3, tune: 160, dec: 0.25 });
  const hat = b.add('hihat', 256, 80, { kit: 2, tone: 0.2 });
  const melody = b.melody(82, 116, 'PENTA', { oct: 2, gate: 0.8, root: 9 });
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
  const kick = b.add('kick', 256, 14, { tune: 42, punch: 0.4, dec: 0.6 });
  const hat = b.add('hihat', 312, 14, { tone: 0.3, dec: 0.05 });
  const clap = b.add('clap', 256, 80, { kit: 2, tone: 2200, dec: 0.08 });
  const mixer = b.add('mixer', 378, 40, { l1: 0.5, l2: 0.35, l3: 0.7 });
  const speaker = b.add('speaker', 458, 60);
  const melody = b.melody(82, 116, 'STABS', { scale: 1, root: 2, oct: 3, gate: 0.25, chord: 2 });
  const stab = b.add('synth', 256, 146, { wave: 0, cut: 0.38, res: 7, env: 0.45, dec: 0.12 });
  const lfo = b.add('lfo', 192, 226, { rate: 0.12, shape: 1, depth: 0.3 });
  const delay = b.add('delay', 334, 160, { time: 0.375, fb: 0.62, mix: 0.5 });
  const reverb = b.add('reverb', 398, 160, { size: 0.85, mix: 0.45 });
  const sub = b.add('synth', 256, 148, { wave: 3, oct: -1, cut: 0.5, env: 0, dec: 0.3 });
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
  const drums = ['kick', 'snare', 'hihat', 'cowbell'].map((t, i) => b.add(t, 256 + (i % 2) * 56, 14 + (i >> 1) * 66, t === 'snare' ? { kit: 1, tune: 200, snap: 0.85, dec: 0.22 } : {}));
  const mixer = b.add('mixer', 378, 40, { l3: 0.4 });
  const speaker = b.add('speaker', 458, 60);
  const melody = b.melody(82, 116, 'OCTAVES', { oct: 2, gate: 0.4, root: 5 });
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

// Four Euclidean rhythms of different lengths drifting against each other.
function euclidJam() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 112 });
  const divider = b.add('divider', 10, 110);
  const rhythms = [
    { e: { steps: 16, hits: 5 }, d: ['kick', { kit: 1 }] },
    { e: { steps: 8, hits: 3, rot: 2 }, d: ['snare', { kit: 2, tune: 190, dec: 0.06 }] },
    { e: { steps: 16, hits: 9 }, d: ['hihat', { kit: 1, dec: 0.04 }] },
    { e: { steps: 7, hits: 2 }, d: ['cowbell', { kit: 1, dec: 0.08 }] },
  ] as const;
  const mixer = b.add('mixer8', 400, 14, { l1: 0.6, l2: 0.45, l3: 0.5, p1: -0.3, p2: 0.4, p3: 0.6, l4: 0.7 });
  rhythms.forEach((r, i) => {
    const e = b.add('euclid', 82, 14 + i * 62, { ...r.e });
    const d = b.add(r.d[0], 160, 14 + i * 66, { ...r.d[1] });
    b.wire(clock, 'o16', e, 'clk');
    b.wire(e, 'out', d, 'in');
    b.wire(d, 'out', mixer, 'i' + i);
  });
  const melody = b.melody(226, 110, 'PENTA', { oct: 2, gate: 0.7, len: 12 });
  const synth = b.add('synth', 226, 218, { wave: 1, cut: 0.3, res: 9, env: 0.6, dec: 0.25 });
  const reverb = b.add('reverb', 300, 230, { size: 0.4, mix: 0.25 });
  const speaker = b.add('speaker', 400, 110);
  b.wire(clock, 'o16', divider, 'in');
  b.wire(divider, 'd2', melody, 'clk');
  b.wire(melody, 'note', synth, 'in');
  b.wire(synth, 'out', mixer, 'i4');
  b.wire(mixer, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  return b.data;
}

// Never quite the same twice: random filter moves, hats that may or may not play.
function generative() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 96, swing: 0.15 });
  const melody = b.melody(82, 30, 'PENTA', { oct: 3, gate: 0.7, len: 13 });
  const synth = b.add('synth', 256, 30, { wave: 2, cut: 0.4, res: 8, env: 0.4, dec: 0.5 });
  const snh = b.add('snh', 256, 112, { depth: 0.6, slew: 0.1 });
  const wobble = b.add('lfo', 316, 112, { rate: 0.1, depth: 0.08 });
  const delay = b.add('delay', 330, 30, { time: 0.5, fb: 0.55, mix: 0.45 });
  const reverb = b.add('reverb', 390, 30, { size: 0.9, mix: 0.5 });
  const speaker = b.add('speaker', 450, 30);
  const chance = b.add('chance', 82, 140, { prob: 0.35 });
  const hat = b.add('hihat', 142, 140, { kit: 1, dec: 0.03, tone: 0.8 });
  const kick = b.add('kick', 196, 140, { kit: 3, dec: 0.8 });
  const euclid = b.add('euclid', 376, 112, { steps: 16, hits: 3 });
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(clock, 'o4', snh, 'trg');
  b.wire(clock, 'o16', chance, 'in');
  b.wire(clock, 'o16', euclid, 'clk');
  b.wire(chance, 'a', hat, 'in');
  b.wire(euclid, 'out', kick, 'in');
  b.wire(melody, 'note', synth, 'in');
  b.wire(snh, 'out', synth, 'cv');
  b.wire(wobble, 'out', delay, 'cv');
  b.wire(synth, 'out', delay, 'in');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  b.wire(hat, 'out', speaker, 'in');
  b.wire(kick, 'out', speaker, 'in');
  return b.data;
}

// FM electric piano, DX7-style: the modulator OSC bends the carrier's pitch at audio
// rate, which adds bell-like overtones. A second envelope fades that FM depth during
// each note, so notes start bright and "tiny" and mellow out, like a struck tine.
// Play it on KEYS too.
function fmPiano() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 84 });
  const melody = b.melody(82, 30, 'ARP', { oct: 4, gate: 0.6, len: 12 });
  const keys = b.add('keys', 82, 142, { oct: 4 });
  const mod = b.add('osc', 256, 30, { wave: 3, oct: 1 });
  const depth = b.add('vca', 330, 30);
  const atten = b.add('atten', 390, 30, { amt: 2.5 });
  const carrier = b.add('osc', 450, 30, { wave: 3 });
  const vca = b.add('vca', 524, 30);
  const bright = b.add('env', 330, 100, { a: 0, d: 0.7, s: 0.1, r: 0.45 });
  const amp = b.add('env', 450, 100, { a: 0.05, d: 0.8, s: 0.2, r: 0.6 });
  const delay = b.add('delay', 584, 30, { time: 0.36, fb: 0.35, mix: 0.25 });
  const reverb = b.add('reverb', 644, 30, { size: 0.7, mix: 0.35 });
  const speaker = b.add('speaker', 584, 100);
  b.wire(clock, 'o16', melody, 'clk');
  for (const src of [melody, keys]) {
    b.wire(src, 'note', mod, 'in');
    b.wire(src, 'note', carrier, 'in');
    b.wire(src, 'note', bright, 'in');
    b.wire(src, 'note', amp, 'in');
  }
  b.wire(mod, 'out', depth, 'in');
  b.wire(bright, 'out', depth, 'cv');
  b.wire(depth, 'out', atten, 'in');
  b.wire(atten, 'out', carrier, 'fm');
  b.wire(carrier, 'out', vca, 'in');
  b.wire(amp, 'out', vca, 'cv');
  b.wire(vca, 'out', delay, 'in');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  return b.data;
}

function industrial() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 128 });
  const beats = b.beats(82, 30, 'TECHNO');
  const kick = b.add('kick', 256, 14, { kit: 2, tune: 50, punch: 0.9, dec: 0.35 });
  const snare = b.add('snare', 312, 14, { kit: 1, tune: 200, snap: 0.85, dec: 0.22 });
  const hat = b.add('hihat', 256, 80, { kit: 1 });
  const crush = b.add('crush', 312, 80, { bits: 5, rate: 8 });
  const mixer = b.add('mixer', 372, 20);
  const speaker = b.add('speaker', 450, 40);
  const melody = b.melody(82, 116, 'ACID', { oct: 2, gate: 0.5 });
  const synth = b.add('synth', 256, 150, { wave: 1, cut: 0.3, res: 10, env: 0.7, dec: 0.2 });
  const fold = b.add('fold', 330, 150, { fold: 0.5 });
  const drive = b.add('drive', 390, 150, { drive: 0.4, tone: 0.6 });
  b.wire(clock, 'o16', beats, 'clk');
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(beats, 'o0', kick, 'in');
  b.wire(beats, 'o3', snare, 'in');
  b.wire(beats, 'o2', hat, 'in');
  b.wire(kick, 'out', mixer, 'i0');
  b.wire(snare, 'out', crush, 'in');
  b.wire(crush, 'out', mixer, 'i1');
  b.wire(hat, 'out', mixer, 'i2');
  b.wire(melody, 'note', synth, 'in');
  b.wire(synth, 'out', fold, 'in');
  b.wire(fold, 'out', drive, 'in');
  b.wire(drive, 'out', mixer, 'i3');
  b.wire(mixer, 'out', speaker, 'in');
  return b.data;
}

// A I-vi-IV-V progression of 7th chords, gently crushed, over a lazy beat.
function lofiChords() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 78, swing: 0.3 });
  const beats = b.beats(82, 30, 'BOOMBAP');
  const kick = b.add('kick', 256, 14, { kit: 4, tune: 45, dec: 0.6 });
  const snare = b.add('snare', 312, 14, { kit: 3, dec: 0.25 });
  const hat = b.add('hihat', 256, 80, { kit: 2, tone: 0.2 });
  const mixer = b.add('mixer', 378, 40, { l2: 0.4, l3: 0.7 });
  const speaker = b.add('speaker', 458, 60);
  const _ = -1;
  const melody = b.notes(82, 116, [0, _, _, _, 5, _, _, _, 3, _, _, _, 4, _, _, _],
    { scale: 0, root: 5, oct: 3, gate: 1, chord: 3 });
  const synth = b.add('synth', 256, 150, { wave: 2, cut: 0.38, res: 2, env: 0.2, dec: 0.8 });
  const crush = b.add('crush', 334, 160, { bits: 8, rate: 3, lvl: 0.8 });
  const reverb = b.add('reverb', 398, 160, { size: 0.6, mix: 0.35 });
  const wow = b.add('lfo', 192, 226, { rate: 0.15, depth: 0.15 });
  b.wire(clock, 'o16', beats, 'clk');
  b.wire(clock, 'o16', melody, 'clk');
  [kick, snare, hat].forEach((d, i) => {
    b.wire(beats, 'o' + i, d, 'in');
    b.wire(d, 'out', mixer, 'i' + i);
  });
  b.wire(melody, 'note', synth, 'in');
  b.wire(wow, 'out', synth, 'cv');
  b.wire(synth, 'out', crush, 'in');
  b.wire(crush, 'out', reverb, 'in');
  b.wire(reverb, 'out', mixer, 'i3');
  b.wire(mixer, 'out', speaker, 'in');
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
  { name: 'EUCLID JAM', build: euclidJam },
  { name: 'GENERATIVE', build: generative },
  { name: 'FM PIANO', build: fmPiano },
  { name: 'INDUSTRIAL', build: industrial },
  { name: 'LOFI CHORDS', build: lofiChords },
  { name: 'EMPTY', build: () => ({ mods: [], cables: [] }) },
];
