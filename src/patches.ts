import { beatSteps, drumSteps, gridSteps, MELODY_PRESETS, melodyState } from './modules';

export interface PatchData {
  mods: { id: number; type: string; x: number; y: number; p: Record<string, number>; s?: unknown; cc?: Record<string, number> }[];
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

  // Pitch and gate from a MELODY or KEYS into a SYNTH.
  play(src: number, synth: number) {
    this.wire(src, 'pit', synth, 'pit');
    this.wire(src, 'gate', synth, 'gate');
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
  b.play(melody, synth);
  b.wire(lfo, 'out', synth, 'cv');
  b.wire(synth, 'out', delay, 'in');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
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
  const speaker = b.add('speaker', 450, 100, { vol: 1 });
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(melody, 'pit', osc, 'cv');
  b.wire(melody, 'gate', env, 'in');
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
  const oscA = b.add('osc', 256, 30, { wave: 0 });
  const oscB = b.add('osc', 256, 90, { wave: 2, oct: 1 });
  // Glide: the pitch CV goes through a SLEW.
  const slew = b.add('slew', 176, 200, { time: 0.9 });
  const noise = b.add('noise', 256, 150, { tone: 0.5, lvl: 0.12 });
  const drift = b.add('lfo', 176, 140, { rate: 0.15, depth: 0.015 });
  const mixer = b.add('mixer', 330, 40, { l0: 0.6, l1: 0.5, l2: 0.6 });
  const filter = b.add('filter', 408, 40, { cut: 0.4, res: 5 });
  const sweep = b.add('lfo', 408, 110, { rate: 0.05, depth: 0.6 });
  const reverb = b.add('reverb', 468, 40, { size: 1, mix: 0.6 });
  const delay = b.add('delay', 528, 40, { time: 0.8, fb: 0.6, mix: 0.4 });
  const speaker = b.add('speaker', 468, 110);
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(melody, 'pit', slew, 'in');
  b.wire(slew, 'out', oscA, 'cv');
  b.wire(slew, 'out', oscB, 'cv');
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

// Minimal 4/4 with filtered stabs drowning in delay and reverb, plus a sine sub doubling them.
function dubTechno() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 120 });
  const beats = b.beats(82, 30, 'TECHNO');
  const kick = b.add('kick', 256, 14, { tune: 42, punch: 0.4, dec: 0.6 });
  const hat = b.add('hihat', 312, 14, { tone: 0.3, dec: 0.05 });
  const clap = b.add('clap', 256, 80, { kit: 2, tone: 2200, dec: 0.08 });
  const mixer = b.add('mixer', 378, 40, { l1: 0.5, l2: 0.35, l3: 0.7 });
  const speaker = b.add('speaker', 458, 60, { vol: 0.64 });
  const melody = b.melody(82, 116, 'STABS', { scale: 1, root: 2, oct: 3, gate: 0.25 });
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
  b.play(melody, stab);
  b.play(melody, sub);
  // The minor stab chord: two more voices, their pitch CV shifted up 3 and 7 semitones.
  for (const [i, semis] of [3, 7].entries()) {
    const shift = b.add('atten', 460, 160 + i * 60, { amt: 1, ofs: semis / 12 });
    const voice = b.add('synth', 520, 146 + i * 80, { wave: 0, cut: 0.38, res: 7, env: 0.45, dec: 0.12 });
    b.wire(melody, 'pit', shift, 'in');
    b.wire(shift, 'out', voice, 'pit');
    b.wire(melody, 'gate', voice, 'gate');
    b.wire(lfo, 'out', voice, 'cv');
    b.wire(voice, 'out', delay, 'in');
  }
  b.wire(sub, 'out', mixer, 'i3');
  b.wire(lfo, 'out', stab, 'cv');
  b.wire(stab, 'out', delay, 'in');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  b.wire(mixer, 'out', speaker, 'in');
  return b.data;
}

// A melody pattern from (step, scale degree, length) notes. A note longer than a step
// is held by sliding into the same note on the following steps.
function phrase(notes: [number, number, number][]) {
  const n = Array(16).fill(-1), sl = Array(16).fill('0');
  for (const [step, deg, len] of notes) {
    for (let i = step; i < step + len; i++) { n[i] = deg; if (i > step) sl[i] = '1'; }
  }
  return { n, a: '0'.repeat(16), s: sl.join('') };
}

// An original bossa nova over ii-V-I-vi in C (Dm7 G7 Cmaj7 Am7), four bars, chained as
// patterns A-D in two MELODYs. The one EUCLID plays the rim clave, the most famous
// Euclidean rhythm: 5 hits over 16 steps, turned by 6, x..x..x...x..x.. (Toussaint).
// The DRUM MACHINE plays the bossa kick, x..xx..xx..xx..x, and soft 8th-note hats,
// and its 16TH output clocks everything else.
function euclidBossa() {
  const b = new Builder();
  const bass = (root: number, fifth: number) => phrase([[0, root, 5], [6, fifth, 2], [8, root, 5], [14, fifth, 2]]);
  const bank = (pats: object[]) => ({ pats, pr: ['', '', '', ''], rt: ['', '', '', ''], e: 0 });
  const drums = b.add('drums', 10, 30, { bpm: 128, kit: 2, vol: 0.8 }, gridSteps({
    name: 'BOSSA', rows: [[0, 3, 4, 7, 8, 11, 12, 15], [], [0, 2, 4, 6, 8, 10, 12, 14], [], []],
  }, 5));
  const euclid = b.add('euclid', 186, 30, { steps: 16, hits: 5, rot: 6 });
  const rim = b.add('snare', 260, 30, { kit: 2, tune: 190, snap: 0.2, dec: 0.05 });
  // scale degrees in C major: 0 C, 1 D, 2 E, 3 F, 4 G, 5 A, 6 B, 7 C
  const bassLine = b.add('melody', 10, 180, { adv: 1, chain: 4, scale: 0, root: 0, oct: 2, gate: 0.9 },
    bank([bass(1, 5), bass(4, 1), bass(0, 4), bass(5, 2)]));
  const tune = b.add('melody', 186, 110, { adv: 1, chain: 4, scale: 0, root: 0, oct: 4, gate: 0.8 }, bank([
    phrase([[0, 5, 2], [3, 4, 2], [6, 3, 3], [10, 2, 2], [13, 1, 3]]),
    phrase([[0, 3, 8], [10, 6, 2], [13, 4, 3]]),
    phrase([[0, 2, 8], [10, 4, 2], [13, 6, 3]]),
    phrase([[0, 7, 5], [6, 5, 8]]),
  ]));
  const bassVoice = b.add('synth', 186, 250, { wave: 2, cut: 0.3, res: 1, env: 0.2, dec: 0.4 });
  const lead = b.add('synth', 356, 110, { wave: 3, cut: 0.5, res: 1, env: 0.15, dec: 0.6 });
  const delay = b.add('delay', 430, 110, { time: 0.35, fb: 0.3, mix: 0.25 });
  const mixer = b.add('mixer', 334, 30, { l0: 0.8, l1: 0.5, l2: 0.8, l3: 0.6 });
  const reverb = b.add('reverb', 410, 30, { size: 0.5, mix: 0.25 });
  const speaker = b.add('speaker', 470, 30);
  b.wire(drums, 'sync', euclid, 'clk');
  b.wire(drums, 'sync', bassLine, 'clk');
  b.wire(drums, 'sync', tune, 'clk');
  b.wire(euclid, 'out', rim, 'in');
  b.play(bassLine, bassVoice);
  b.play(tune, lead);
  b.wire(lead, 'out', delay, 'in');
  b.wire(drums, 'out', mixer, 'i0');
  b.wire(rim, 'out', mixer, 'i1');
  b.wire(bassVoice, 'out', mixer, 'i2');
  b.wire(delay, 'out', mixer, 'i3');
  b.wire(mixer, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  return b.data;
}

// FM electric piano, DX7-style: the modulator OSC bends the carrier's pitch at audio
// rate, which adds bell-like overtones. A second envelope fades that FM depth during
// each note, so notes start bright and "tiny" and mellow out, like a struck tine.
// Play it on KEYS, from the computer keyboard (A-K) or a MIDI keyboard.
function fmPiano() {
  const b = new Builder();
  const keys = b.add('keys', 82, 30, { oct: 4 });
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
  b.wire(keys, 'pit', mod, 'cv');
  b.wire(keys, 'pit', carrier, 'cv');
  b.wire(keys, 'gate', bright, 'in');
  b.wire(keys, 'gate', amp, 'in');
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
  const speaker = b.add('speaker', 450, 40, { vol: 0.48 });
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
  b.play(melody, synth);
  b.wire(synth, 'out', fold, 'in');
  b.wire(fold, 'out', drive, 'in');
  b.wire(drive, 'out', mixer, 'i3');
  b.wire(mixer, 'out', speaker, 'in');
  return b.data;
}

// A I-vi-IV-V progression of 7th chords, gently crushed, over a lazy beat. One melody
// plays the roots; ATTEN shifts its pitch CV up by 3.5 and 10.5 semitones and QUANT
// snaps that to F major, which lands on each chord's own third and seventh.
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
    { scale: 0, root: 5, oct: 3, gate: 1 });
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
  b.play(melody, synth);
  b.wire(wow, 'out', synth, 'cv');
  for (const [i, semis] of [3.5, 10.5].entries()) {
    const y = 240 + i * 80;
    const shift = b.add('atten', 256, y, { amt: 1, ofs: semis / 12 });
    const quant = b.add('quant', 314, y, { root: 5, scale: 0 });
    const voice = b.add('synth', 386, y, { wave: 2, cut: 0.38, res: 2, env: 0.2, dec: 0.8 });
    b.wire(melody, 'pit', shift, 'in');
    b.wire(shift, 'out', quant, 'in');
    b.wire(quant, 'out', voice, 'pit');
    b.wire(melody, 'gate', voice, 'gate');
    b.wire(wow, 'out', voice, 'cv');
    b.wire(voice, 'out', crush, 'in');
  }
  b.wire(synth, 'out', crush, 'in');
  b.wire(crush, 'out', reverb, 'in');
  b.wire(reverb, 'out', mixer, 'i3');
  b.wire(mixer, 'out', speaker, 'in');
  return b.data;
}

// The classic generative patch: random voltages from S&H, snapped to A minor pentatonic
// by QUANT, play the OSC through its 1V/oct input. A bass SYNTH plays the same pitch
// CV on the beat.
function quantized() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 104 });
  const snh = b.add('snh', 82, 30, { depth: 1 });
  const chance = b.add('chance', 82, 96, { prob: 0.7 });
  const kick = b.add('kick', 82, 160, { kit: 3 });
  const quant = b.add('quant', 142, 30, { root: 9, scale: 2 });
  const osc = b.add('osc', 216, 30, { wave: 1 });
  const env = b.add('env', 216, 96, { a: 0, d: 0.45, s: 0.1, r: 0.45 });
  const filter = b.add('filter', 290, 30, { cut: 0.4, res: 6 });
  const synth = b.add('synth', 290, 96, { wave: 0, oct: -1, cut: 0.25, env: 0.5, dec: 0.4 });
  const vca = b.add('vca', 350, 30);
  const delay = b.add('delay', 410, 30, { time: 0.43, fb: 0.45, mix: 0.35 });
  const reverb = b.add('reverb', 470, 30, { size: 0.7, mix: 0.3 });
  const speaker = b.add('speaker', 530, 30, { vol: 0.47 });
  b.wire(clock, 'o16', chance, 'in');
  b.wire(chance, 'a', snh, 'trg');
  b.wire(chance, 'a', env, 'in');
  b.wire(snh, 'out', quant, 'in');
  b.wire(quant, 'out', osc, 'cv');
  b.wire(osc, 'out', filter, 'in');
  b.wire(env, 'out', filter, 'cv');
  b.wire(filter, 'out', vca, 'in');
  b.wire(env, 'out', vca, 'cv');
  b.wire(vca, 'out', delay, 'in');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  b.wire(clock, 'o4', synth, 'gate');
  b.wire(quant, 'out', synth, 'pit');
  b.wire(synth, 'out', speaker, 'in');
  b.wire(clock, 'o4', kick, 'in');
  b.wire(kick, 'out', speaker, 'in');
  return b.data;
}

// Acid house in seven modules: one DRUM MACHINE plays the beat and clocks a MELODY
// with accents and slides into a squelchy resonant SYNTH. A slow LFO sweeps the cutoff,
// like a hand on the knob.
function acidHouse() {
  const b = new Builder();
  const drums = b.add('drums', 10, 30, { bpm: 124, swing: 0.08, kit: 1 }, drumSteps('ACID'));
  const melody = b.melody(186, 30, 'ACID', { oct: 2, gate: 0.5 });
  const synth = b.add('synth', 356, 30, { wave: 0, cut: 0.18, res: 15, env: 0.75, dec: 0.22 });
  const sweep = b.add('lfo', 356, 112, { rate: 0.22, shape: 1, depth: 0.45 });
  const drive = b.add('drive', 430, 30, { drive: 0.45, tone: 0.7, lvl: 0.45 });
  const delay = b.add('delay', 490, 30, { time: 0.363, fb: 0.35, mix: 0.2 });
  const speaker = b.add('speaker', 550, 30, { vol: 0.36 });
  b.wire(drums, 'sync', melody, 'clk');
  b.play(melody, synth);
  b.wire(sweep, 'out', synth, 'cv');
  b.wire(synth, 'out', drive, 'in');
  b.wire(drive, 'out', delay, 'in');
  b.wire(delay, 'out', speaker, 'in');
  b.wire(drums, 'out', speaker, 'in');
  return b.data;
}

// A TURING machine writes a melody that slowly mutates: its voltage, snapped to
// C minor pentatonic by QUANT, plays a SYNTH whenever its newest bit is 1. Turn CHG to
// 0 to lock a loop you like. SCOPE shows the pitch CV and the sound.
function turingMachine() {
  const b = new Builder();
  const drums = b.add('drums', 10, 30, { bpm: 118, kit: 0 }, drumSteps('OFFBEAT'));
  const turing = b.add('turing', 186, 30, { chg: 0.08, len: 8, rng: 1.5 });
  const quant = b.add('quant', 260, 30, { root: 0, scale: 2 });
  const synth = b.add('synth', 334, 30, { wave: 1, cut: 0.3, res: 9, env: 0.55, dec: 0.25 });
  const delay = b.add('delay', 408, 30, { time: 0.38, fb: 0.4, mix: 0.3 });
  const speaker = b.add('speaker', 468, 30, { vol: 0.37 });
  const scope = b.add('scope', 260, 110, { tim: 0.95 });
  b.wire(drums, 'sync', turing, 'clk');
  b.wire(turing, 'out', quant, 'in');
  b.wire(quant, 'out', synth, 'pit');
  b.wire(turing, 'gate', synth, 'gate');
  b.wire(synth, 'out', delay, 'in');
  b.wire(delay, 'out', speaker, 'in');
  b.wire(drums, 'out', speaker, 'in');
  b.wire(quant, 'out', scope, 'a');
  b.wire(synth, 'out', scope, 'b');
  return b.data;
}

// Everything at once. An advanced CLOCK runs the show and resets the sequencers on
// start; its DIV output (every 2 bars) flips a SEQ SW between two pitch sources: a
// TURING melody snapped to A minor pentatonic, and an advanced MELODY with a ratchet.
// LOGIC ORs their gates into the SYNTH, CV MIX adds LFO vibrato, RING adds a bell-like
// edge. The advanced DRUM MACHINE chains two patterns, with a ratcheted and a chance
// step. A big MIXER pans it all; SCOPE shows the pitch CV and the ring-modulated voice.
function showcase() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { adv: 1, bpm: 122, div: 5 });
  const turing = b.add('turing', 112, 30, { chg: 0.06, len: 8, rng: 1 });
  const quant = b.add('quant', 186, 30, { root: 9, scale: 2 });
  const seqsw = b.add('seqsw', 260, 30, { steps: 2 });
  const cvmix = b.add('cvmix', 334, 30, { a0: 1, a1: 1, a2: 0 });
  const synth = b.add('synth', 408, 30, { wave: 0, cut: 0.3, res: 10, env: 0.5, dec: 0.25 });
  const ring = b.add('ring', 482, 30, { mix: 0.35 });
  const delay = b.add('delay', 542, 30, { time: 0.37, fb: 0.4, mix: 0.3 });
  const mixer = b.add('mixer', 602, 30, { adv: 1, l0: 0.9, l1: 0.7, p1: 0.25 });
  const speaker = b.add('speaker', 680, 120);
  const drums = b.add('drums', 10, 120, { adv: 1, chain: 2, bpm: 122, kit: 1 }, {
    pats: [drumSteps('ACID'), drumSteps('JACK'), [], []],
    pr: ['4444444444444424', '', '', ''],
    rt: ['1111111111111113', '1111111131111111', '', ''],
    e: 0,
  });
  const melody = b.add('melody', 186, 120, { adv: 1, scale: 1, root: 9, oct: 2, gate: 0.5 }, {
    pats: [melodyState('ACID'), {}, {}, {}],
    pr: ['', '', '', ''],
    rt: ['1111111211111111', '', '', ''],
    e: 0,
  });
  const logic = b.add('logic', 356, 120);
  const lfo = b.add('lfo', 430, 120, { rate: 0.6, depth: 0.015 });
  const osc = b.add('osc', 490, 120, { wave: 3, oct: 1 });
  const scope = b.add('scope', 564, 120, { tim: 0.9 });
  b.wire(clock, 'o16', drums, 'clk');
  b.wire(clock, 'o16', turing, 'clk');
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(clock, 'rst', drums, 'rst');
  b.wire(clock, 'rst', melody, 'rst');
  b.wire(clock, 'rst', seqsw, 'rst');
  b.wire(clock, 'div', seqsw, 'trg');
  b.wire(turing, 'out', quant, 'in');
  b.wire(quant, 'out', seqsw, 'i0');
  b.wire(melody, 'pit', seqsw, 'i1');
  b.wire(seqsw, 'out', cvmix, 'i0');
  b.wire(lfo, 'out', cvmix, 'i1');
  b.wire(cvmix, 'out', synth, 'pit');
  b.wire(turing, 'gate', logic, 'a');
  b.wire(melody, 'gate', logic, 'b');
  b.wire(logic, 'or', synth, 'gate');
  b.wire(synth, 'out', ring, 'in');
  b.wire(osc, 'out', ring, 'car');
  b.wire(ring, 'out', delay, 'in');
  b.wire(drums, 'out', mixer, 'i0');
  b.wire(delay, 'out', mixer, 'i1');
  b.wire(mixer, 'out', speaker, 'in');
  b.wire(cvmix, 'out', scope, 'a');
  b.wire(ring, 'out', scope, 'b');
  return b.data;
}

// Brings older patches up to date. Before pitch became a voltage, MELODY and KEYS sent NOTE cables. Rewire those as PIT
// and GATE cables. Two of them into one voice would now add their pitches together, so
// only the first source keeps its cables there; returns how many sources were unplugged.
export function migrate(old: PatchData) {
  // BIG MIXER became MIXER with its BIG layout.
  const data = { ...old, mods: old.mods.map((m) => (m.type === 'mixer8' ? { ...m, type: 'mixer', p: { ...m.p, adv: 1 } } : m)) };
  const type = new Map(data.mods.map((m) => [m.id, m.type]));
  const isNote = (c: PatchData['cables'][number]) => c.ap === 'note' && ['melody', 'keys'].includes(type.get(c.a) ?? '');
  const pitchIn = (c: PatchData['cables'][number]) => {
    const t = type.get(c.b);
    return c.bp === 'in' && t === 'synth' ? 'pit' : c.bp === 'in' && t === 'osc' ? 'cv' : null;
  };
  const owner = new Map<string, number>(), losers = new Set<number>();
  for (const c of data.cables.filter(isNote)) {
    const jack = `${c.b}:${pitchIn(c)}`;
    if (!pitchIn(c)) continue;
    if (!owner.has(jack)) owner.set(jack, c.a);
    else if (owner.get(jack) !== c.a) losers.add(c.a);
  }
  const cables = data.cables.flatMap((c) => {
    if (!isNote(c)) return [c];
    if (losers.has(c.a)) return [];
    const pit = pitchIn(c);
    if (pit === 'cv') return [{ ...c, ap: 'pit', bp: 'cv' }];
    if (pit === 'pit') return [{ ...c, ap: 'pit', bp: 'pit' }, { ...c, ap: 'gate', bp: 'gate' }];
    return [{ ...c, ap: 'gate' }];
  });
  return { data: { ...data, cables }, dropped: losers.size };
}

export const PATCHES: { name: string; build: () => PatchData }[] = [
  { name: '808 GROOVE', build: groove },
  { name: 'BUILD A VOICE', build: voice },
  { name: 'AMBIENT DRIFT', build: ambient },
  { name: 'DUB TECHNO', build: dubTechno },
  { name: 'EUCLID BOSSA', build: euclidBossa },
  { name: 'FM PIANO', build: fmPiano },
  { name: 'INDUSTRIAL', build: industrial },
  { name: 'LOFI CHORDS', build: lofiChords },
  { name: 'QUANTIZED', build: quantized },
  { name: 'ACID HOUSE', build: acidHouse },
  { name: 'TURING MACHINE', build: turingMachine },
  { name: 'SHOWCASE', build: showcase },
  { name: 'EMPTY', build: () => ({ mods: [], cables: [] }) },
];
