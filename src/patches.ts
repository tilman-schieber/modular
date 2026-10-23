import { beatSteps, drumSteps, gridSteps, MELODY_PRESETS, melodyState } from './modules';

export interface PatchData {
  // l: the module's label, if it has one.
  mods: { id: number; type: string; x: number; y: number; p: Record<string, number>; s?: unknown; cc?: Record<string, number>; l?: string }[];
  cables: { a: number; ap: string; b: number; bp: string }[];
}

class Builder {
  data: PatchData = { mods: [], cables: [] };

  add(type: string, x: number, y: number, p: Record<string, number> = {}, s?: unknown) {
    this.data.mods.push({ id: this.data.mods.length + 1, type, x, y, p, s });
    return this.data.mods.length;
  }

  // Give module m a label (shown in a bar above its title).
  label(m: number, text: string) {
    this.data.mods[m - 1].l = text;
    return m;
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
  const melody = b.melody(82, 122, 'BASSLINE', { oct: 2 });
  const synth = b.add('synth', 256, 156);
  const delay = b.add('delay', 334, 160);
  const reverb = b.add('reverb', 398, 160);
  const lfo = b.add('lfo', 192, 236, { rate: 0.25, depth: 0.35 });
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
  // Labels: what each part does.
  b.label(melody, 'BASSLINE');
  b.label(synth, 'BASS');
  b.label(lfo, 'BASS WOBBLE');
  return b.data;
}

// The textbook subtractive patch: OSC -> FILTER -> VCA, shaped by an envelope.
function voice() {
  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 110 });
  const melody = b.melody(82, 30, 'ARP', { oct: 3, gate: 0.6 });
  const osc = b.add('osc', 256, 30);
  const filter = b.add('filter', 330, 30, { cut: 0.3, res: 8 });
  const vca = b.add('vca', 390, 30);
  const delay = b.add('delay', 450, 30, { time: 0.41, fb: 0.4, mix: 0.3 });
  const reverb = b.add('reverb', 510, 30, { size: 0.6, mix: 0.3 });
  const env = b.add('env', 256, 100, { a: 0.05, d: 0.55, s: 0.2, r: 0.5 });
  const lfo = b.add('lfo', 340, 100, { rate: 0.55, depth: 0.02 });
  const speaker = b.add('speaker', 450, 110, { vol: 1 });
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(melody, 'pit', osc, 'cv');
  b.wire(melody, 'gate', env, 'in');
  b.wire(lfo, 'out', osc, 'cv');
  b.wire(osc, 'saw', filter, 'in');
  b.wire(env, 'out', filter, 'cv');
  b.wire(filter, 'out', vca, 'in');
  b.wire(env, 'out', vca, 'cv');
  b.wire(vca, 'out', delay, 'in');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  // Labels: what each part does.
  b.label(melody, 'ARPEGGIO');
  b.label(env, 'CONTOUR');
  b.label(lfo, 'VIBRATO');
  return b.data;
}

// A slow Am7 Fmaj7 Cmaj7 G7 pad in delay and reverb, with sparse sine bells on top.
// An ENVELOPE on the pad's VCA makes it swell each bar and fade out when you press STOP;
// an LFO on its A and R jacks makes every swell a little different.
function ambient() {
  const b = new Builder();
  const bank = (pats: object[]) => ({ pats, pr: ['', '', '', ''], rt: ['', '', '', ''], e: 0 });
  const clock = b.add('clock', 10, 30, { bpm: 70 });
  // One held root per bar: Am7, Fmaj7, Cmaj7, G7. A minor's degrees: 0 A, 2 C, 5 F, 6 G.
  const roots = b.add('melody', 82, 30, { adv: 1, chain: 4, scale: 1, root: 9, oct: 2, gate: 1 },
    bank([0, 5, 2, 6].map((d) => phrase([[0, d, 16]]))));
  // CHORD in C (the relative major of A minor) builds the diatonic 7th chord on each root.
  const chord = b.add('chord', 256, 30, { type: 7, key: 0 });
  // Glide: the root goes through a SLEW; the upper voices step.
  const slew = b.add('slew', 256, 96, { time: 0.9 });
  const oscA = b.add('osc', 344, 30);
  const oscB = b.add('osc', 344, 94, { oct: 1 });
  const oscC = b.add('osc', 344, 158, { oct: 1 });
  const drift = b.add('lfo', 256, 160, { rate: 0.15, depth: 0.015 });
  const noise = b.add('noise', 344, 222, { tone: 0.5, lvl: 0.1 });
  const mixer = b.add('mixer', 420, 30, { l0: 0.35, l1: 0.35, l2: 0.4, l3: 0.45 });
  // The pad swells in on each bar and fades out on STOP instead of droning on.
  const env = b.add('env', 420, 110, { adv: 1, a: 0.75, d: 0.8, s: 0.75, r: 0.85 });
  // A slow LFO into the envelope's A and R jacks: some bars swell in slowly and fade long, others bloom fast.
  const breath = b.add('lfo', 420, 214, { rate: 0.1, depth: 0.6 });
  const vca = b.add('vca', 500, 30);
  const filter = b.add('filter', 560, 30, { cut: 0.4, res: 4 });
  const sweep = b.add('lfo', 560, 96, { rate: 0.05, depth: 0.5 });
  const delay = b.add('delay', 620, 30, { time: 0.8, fb: 0.45, mix: 0.35 });
  const reverb = b.add('reverb', 680, 30, { size: 1, mix: 0.5 });
  const speaker = b.add('speaker', 680, 110);
  // Sparkle: a slowly changing TURING line in A minor pentatonic, thinned out by CHANCE.
  const turing = b.add('turing', 82, 190, { chg: 0.05, len: 8, rng: 1 });
  const quant = b.add('quant', 166, 190, { root: 9, scale: 2 });
  const chance = b.add('chance', 82, 270, { prob: 0.4 });
  const bell = b.add('synth', 166, 270, { wave: 3, oct: 1, cut: 0.5, res: 1, env: 0.2, dec: 1.2 });
  const bellVca = b.add('vca', 240, 270, { base: 0.3 });
  b.wire(clock, 'o16', roots, 'clk');
  b.wire(roots, 'pit', chord, 'in');
  b.wire(roots, 'gate', env, 'in');
  b.wire(chord, 'o0', slew, 'in');
  b.wire(slew, 'out', oscA, 'cv');
  b.wire(chord, 'o1', oscB, 'cv');
  b.wire(chord, 'o3', oscC, 'cv');
  b.wire(drift, 'out', oscC, 'cv');
  b.wire(oscA, 'saw', mixer, 'i0');
  b.wire(oscB, 'tri', mixer, 'i1');
  b.wire(oscC, 'sin', mixer, 'i2');
  b.wire(noise, 'out', mixer, 'i3');
  b.wire(mixer, 'out', vca, 'in');
  b.wire(env, 'out', vca, 'cv');
  b.wire(breath, 'out', env, 'cv_a');
  b.wire(breath, 'out', env, 'cv_r');
  b.wire(vca, 'out', filter, 'in');
  b.wire(sweep, 'out', filter, 'cv');
  b.wire(filter, 'out', delay, 'in');
  b.wire(clock, 'o4', turing, 'clk');
  b.wire(turing, 'out', quant, 'in');
  b.wire(turing, 'gate', chance, 'in');
  b.wire(quant, 'out', bell, 'pit');
  b.wire(chance, 'a', bell, 'gate');
  b.wire(bell, 'out', bellVca, 'in');
  b.wire(bellVca, 'out', delay, 'in');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  // Labels: what each part does.
  b.label(roots, 'CHORD ROOTS');
  b.label(oscA, 'ROOT GLIDE');
  b.label(oscB, 'THIRD');
  b.label(oscC, 'SEVENTH');
  b.label(drift, 'DRIFT');
  b.label(noise, 'AIR');
  b.label(mixer, 'PAD MIX');
  b.label(env, 'PAD SWELL');
  b.label(breath, 'BREATH');
  b.label(vca, 'PAD AMP');
  b.label(filter, 'PAD FILTER');
  b.label(sweep, 'CUT SWEEP');
  b.label(turing, 'BELL NOTES');
  b.label(quant, 'A MIN PENTA');
  b.label(chance, 'BELL GATES');
  b.label(bell, 'BELLS');
  b.label(bellVca, 'BELL LEVEL');
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
  const melody = b.melody(82, 122, 'STABS', { scale: 1, root: 2, oct: 3, gate: 0.25 });
  const stab = b.add('synth', 256, 156, { wave: 0, cut: 0.38, res: 7, env: 0.45, dec: 0.12 });
  const lfo = b.add('lfo', 192, 236, { rate: 0.12, shape: 1, depth: 0.3 });
  const delay = b.add('delay', 334, 160, { time: 0.375, fb: 0.62, mix: 0.5 });
  const reverb = b.add('reverb', 398, 160, { size: 0.85, mix: 0.45 });
  const sub = b.add('synth', 82, 250, { wave: 3, oct: -1, cut: 0.5, env: 0, dec: 0.3 });
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
  // The minor stab chord: CHORD's minor third and fifth play two more voices.
  const chord = b.add('chord', 440, 226, { type: 1 });
  b.wire(melody, 'pit', chord, 'in');
  for (const [i, out] of ['o1', 'o2'].entries()) {
    const voice = b.label(b.add('synth', 520, 146 + i * 86, { wave: 0, cut: 0.38, res: 7, env: 0.45, dec: 0.12 }), ['STAB 3RD', 'STAB 5TH'][i]);
    b.wire(chord, out, voice, 'pit');
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
  // Labels: what each part does.
  b.label(melody, 'STABS');
  b.label(stab, 'STAB ROOT');
  b.label(sub, 'SUB BASS');
  b.label(lfo, 'STAB FILTER');
  b.label(chord, 'MINOR CHORD');
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

// An original bossa nova song over ii-V-I-vi in C (Dm7 G7 Cmaj7 Am7), 20 bars long.
// The ARRANGER plays the form: INTRO, A, B, A, OUTRO, four bars each.
// - P1 picks the DRUM MACHINE pattern: A is the sparse intro and outro groove
//   (kick on 1 and 3), B the full bossa kick, x..xx..xx..xx..x. Both have 8th-note shaker.
// - G1 and G2 open the VCAs of the two tunes: the A melody and the B (answer) melody,
//   each four bars chained as patterns A-D in its own MELODY.
// - C1 is the reverb mix: drier in the song, washing out in the outro.
// The one EUCLID plays the rim clave, the most famous Euclidean rhythm: 5 hits over 16
// steps, turned by 6, x..x..x...x..x.. (Toussaint). The DRUM MACHINE's 16TH output clocks
// everything else.
function euclidBossa() {
  const b = new Builder();
  const bass = (root: number, fifth: number) => phrase([[0, root, 5], [6, fifth, 2], [8, root, 5], [14, fifth, 2]]);
  const bank = (pats: object[]) => ({ pats, pr: ['', '', '', ''], rt: ['', '', '', ''], e: 0 });
  const shaker = [0, 2, 4, 6, 8, 10, 12, 14];
  const drums = b.add('drums', 10, 30, { adv: 1, bpm: 128, kit: 3, vol: 0.9 }, bank([
    gridSteps({ name: 'INTRO', rows: [[0, 8], [], shaker, [], []] }, 5),
    gridSteps({ name: 'BOSSA', rows: [[0, 3, 4, 7, 8, 11, 12, 15], [], shaker, [], []] }, 5),
    [], [],
  ]));
  // Sections: lengths in bars, then per lane a value per section.
  //                     INTRO  A  B  A  OUTRO
  const arranger = b.add('arranger', 10, 190, {}, {
    l: [4, 4, 4, 4, 4, 0, 0, 0],
    c: [
      [0, 1, 1, 1, 0, 0, 0, 0], // P1: drum pattern
      [0, 0, 0, 0, 0, 0, 0, 0], // P2
      [0, 1, 0, 1, 0, 0, 0, 0], // G1: tune A
      [0, 0, 1, 0, 0, 0, 0, 0], // G2: tune B
      [0.25, 0.25, 0.25, 0.25, 1, 0, 0, 0], // C1: reverb mix
      [0, 0, 0, 0, 0, 0, 0, 0], // C2
    ],
  });
  const euclid = b.add('euclid', 186, 30, { steps: 16, hits: 5, rot: 6 });
  const rim = b.add('snare', 260, 30, { kit: 2, tune: 190, snap: 0.2, dec: 0.05 });
  // scale degrees in C major: 0 C, 1 D, 2 E, 3 F, 4 G, 5 A, 6 B, 7 C
  const bassLine = b.add('melody', 10, 320, { adv: 1, chain: 4, scale: 0, root: 0, oct: 2, gate: 0.9 },
    bank([bass(1, 5), bass(4, 1), bass(0, 4), bass(5, 2)]));
  const tuneA = b.add('melody', 186, 110, { adv: 1, chain: 4, scale: 0, root: 0, oct: 4, gate: 0.8 }, bank([
    phrase([[0, 5, 2], [3, 4, 2], [6, 3, 3], [10, 2, 2], [13, 1, 3]]),
    phrase([[0, 3, 8], [10, 6, 2], [13, 4, 3]]),
    phrase([[0, 2, 8], [10, 4, 2], [13, 6, 3]]),
    phrase([[0, 7, 5], [6, 5, 8]]),
  ]));
  const tuneB = b.add('melody', 186, 250, { adv: 1, chain: 4, scale: 0, root: 0, oct: 4, gate: 0.8 }, bank([
    phrase([[0, 3, 2], [2, 5, 2], [4, 7, 4], [10, 5, 2], [12, 3, 4]]),
    phrase([[0, 6, 3], [4, 4, 2], [6, 3, 2], [8, 1, 6]]),
    phrase([[0, 2, 2], [3, 4, 2], [6, 6, 4], [12, 7, 4]]),
    phrase([[0, 5, 6], [8, 4, 2], [10, 2, 6]]),
  ]));
  const bassVoice = b.add('synth', 186, 390, { wave: 2, cut: 0.3, res: 1, env: 0.2, dec: 0.4 });
  const leadA = b.add('synth', 356, 110, { wave: 3, cut: 0.5, res: 1, env: 0.15, dec: 0.6 });
  const leadB = b.add('synth', 356, 250, { wave: 3, cut: 0.55, res: 1, env: 0.15, dec: 0.6 });
  const vcaA = b.add('vca', 430, 110);
  const vcaB = b.add('vca', 430, 250);
  const delay = b.add('delay', 490, 110, { time: 0.05 + (0.95 * 3) / 6, fb: 0.3, mix: 0.25 });
  const mixer = b.add('mixer', 334, 30, { l0: 0.8, l1: 0.5, l2: 0.8, l3: 0.6 });
  const reverb = b.add('reverb', 410, 30, { size: 0.5, mix: 0.15 });
  const speaker = b.add('speaker', 470, 30);
  for (const m of [euclid, bassLine, tuneA, tuneB, arranger, delay]) b.wire(drums, 'sync', m, 'clk');
  b.wire(arranger, 'o0', drums, 'pat');
  b.wire(arranger, 'o2', vcaA, 'cv');
  b.wire(arranger, 'o3', vcaB, 'cv');
  b.wire(arranger, 'o4', reverb, 'cv');
  b.wire(euclid, 'out', rim, 'in');
  b.play(bassLine, bassVoice);
  b.play(tuneA, leadA);
  b.play(tuneB, leadB);
  b.wire(leadA, 'out', vcaA, 'in');
  b.wire(leadB, 'out', vcaB, 'in');
  b.wire(vcaA, 'out', delay, 'in');
  b.wire(vcaB, 'out', delay, 'in');
  b.wire(drums, 'out', mixer, 'i0');
  b.wire(rim, 'out', mixer, 'i1');
  b.wire(bassVoice, 'out', mixer, 'i2');
  b.wire(delay, 'out', mixer, 'i3');
  b.wire(mixer, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  // Labels: what each part does.
  b.label(euclid, 'RIM 5 OF 16');
  b.label(rim, 'RIMSHOT');
  b.label(bassLine, 'BASSLINE');
  b.label(tuneA, 'TUNE A');
  b.label(tuneB, 'TUNE B');
  b.label(bassVoice, 'BASS');
  b.label(leadA, 'LEAD A');
  b.label(leadB, 'LEAD B');
  b.label(vcaA, 'A LEVEL');
  b.label(vcaB, 'B LEVEL');
  return b.data;
}

// FM electric piano, DX7-style: the modulator OSC bends the carrier's pitch at audio
// rate, which adds bell-like overtones. A second envelope fades that FM depth during
// each note, so notes start bright and "tiny" and mellow out, like a struck tine.
// Play it on KEYS, from the computer keyboard (A-K) or a MIDI keyboard.
// Play KEYS with one hand and the PADS (keys 1-4) with the other. Held: 1 the delay,
// 2 a big reverb wash, 3 a brighter, bell-like tone. 4 latches a different tone: the
// carrier's square wave in place of its sine, hollow and woody.
function fmPiano() {
  const b = new Builder();
  const keys = b.add('keys', 82, 30, { oct: 4 });
  const pads = b.add('pads', 82, 104, { adv: 1, m0: 1, m1: 1, m2: 1, m3: 2 });
  const mod = b.add('osc', 256, 30, { oct: 1 });
  const depth = b.add('vca', 330, 30);
  const atten = b.add('atten', 390, 30, { amt: 2.5 });
  // FMA 2: OSC's FM is the same depth for every note; this matches the old sound around C4.
  const carrier = b.add('osc', 450, 30, { adv: 1, fma: 2 });
  const vca = b.add('vca', 534, 30);
  // A crossfade between the carrier's waves, run by pad 4: channel 1 (SIN) is 1 - CV,
  // channel 2 (SQR, a little lower to match its loudness) gets the same CV, normalled.
  const tone = b.add('vca', 534, 112, { adv: 1, base: 1, amt: -1, base1: 0, amt1: 0.7 });
  const bright = b.add('env', 330, 100, { a: 0, d: 0.7, s: 0.1, r: 0.45 });
  const amp = b.add('env', 450, 112, { a: 0.05, d: 0.8, s: 0.2, r: 0.6 });
  // Both effects start dry-ish; a held pad's CV of 1 adds half the MIX range.
  const delay = b.add('delay', 594, 30, { adv: 1, time: 0.36, fb: 0.45, mix: 0 });
  const reverb = b.add('reverb', 654, 30, { size: 0.85, mix: 0.15 });
  const speaker = b.add('speaker', 654, 100);
  b.wire(keys, 'pit', mod, 'cv');
  b.wire(keys, 'pit', carrier, 'cv');
  b.wire(keys, 'gate', bright, 'in');
  b.wire(keys, 'gate', amp, 'in');
  b.wire(mod, 'sin', depth, 'in');
  b.wire(bright, 'out', depth, 'cv');
  b.wire(depth, 'out', atten, 'in');
  b.wire(atten, 'out', carrier, 'fm');
  b.wire(carrier, 'sin', tone, 'in');
  b.wire(carrier, 'sqr', tone, 'in1');
  b.wire(tone, 'sum', vca, 'in');
  b.wire(amp, 'out', vca, 'cv');
  b.wire(vca, 'out', delay, 'in');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', speaker, 'in');
  b.wire(pads, 'c0', delay, 'cv_mix');
  b.wire(pads, 'c1', reverb, 'cv');
  // Added to the brightness envelope: more FM while the pad is held.
  b.wire(pads, 'c2', depth, 'cv');
  b.wire(pads, 'c3', tone, 'cv');
  // Labels: what each part does.
  b.label(pads, 'PERFORM');
  b.label(mod, 'MODULATOR');
  b.label(depth, 'FM DEPTH');
  b.label(atten, 'FM AMOUNT');
  b.label(carrier, 'CARRIER');
  b.label(vca, 'AMP');
  b.label(tone, 'SINE / SQUARE');
  b.label(bright, 'BRIGHTNESS');
  b.label(amp, 'AMP ENV');
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
// plays the roots; CHORD (DIA, in F) gives each root its own third and seventh.
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
  const melody = b.notes(82, 122, [0, _, _, _, 5, _, _, _, 3, _, _, _, 4, _, _, _],
    { scale: 0, root: 5, oct: 3, gate: 1 });
  const synth = b.add('synth', 256, 156, { wave: 2, cut: 0.38, res: 2, env: 0.2, dec: 0.8 });
  const crush = b.add('crush', 334, 160, { bits: 8, rate: 3, lvl: 0.8 });
  const reverb = b.add('reverb', 398, 160, { size: 0.6, mix: 0.35 });
  const wow = b.add('lfo', 192, 236, { rate: 0.15, depth: 0.15 });
  b.wire(clock, 'o16', beats, 'clk');
  b.wire(clock, 'o16', melody, 'clk');
  [kick, snare, hat].forEach((d, i) => {
    b.wire(beats, 'o' + i, d, 'in');
    b.wire(d, 'out', mixer, 'i' + i);
  });
  b.play(melody, synth);
  b.wire(wow, 'out', synth, 'cv');
  // CHORD stacks thirds in F major on each bass note: its 3rd and 7th play two more voices.
  const chord = b.add('chord', 256, 244, { type: 7, key: 5 });
  b.wire(melody, 'pit', chord, 'in');
  for (const [i, out] of ['o1', 'o3'].entries()) {
    const voice = b.label(b.add('synth', 386, 240 + i * 86, { wave: 2, cut: 0.38, res: 2, env: 0.2, dec: 0.8 }), ['THIRD', 'SEVENTH'][i]);
    b.wire(chord, out, voice, 'pit');
    b.wire(melody, 'gate', voice, 'gate');
    b.wire(wow, 'out', voice, 'cv');
    b.wire(voice, 'out', crush, 'in');
  }
  b.wire(synth, 'out', crush, 'in');
  b.wire(crush, 'out', reverb, 'in');
  b.wire(reverb, 'out', mixer, 'i3');
  b.wire(mixer, 'out', speaker, 'in');
  // Labels: what each part does.
  b.label(melody, 'BASS NOTES');
  b.label(synth, 'ROOT');
  b.label(wow, 'TAPE WOW');
  b.label(chord, 'F MAJOR');
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
  const osc = b.add('osc', 216, 30);
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
  b.wire(osc, 'sqr', filter, 'in');
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
  // Labels: what each part does.
  b.label(snh, 'RANDOM');
  b.label(chance, 'GATES 70%');
  b.label(osc, 'MELODY');
  b.label(env, 'PLUCK');
  b.label(synth, 'BASS');
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
  const sweep = b.add('lfo', 356, 118, { rate: 0.22, shape: 1, depth: 0.45 });
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
  // Labels: what each part does.
  b.label(sweep, 'CUT SWEEP');
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

// Everything at once: a 32-bar deep house track in A minor, arranged.
// - The ARRANGER plays the form: INTRO, GROOVE, LEAD, BREAK, DROP, OUTRO. P1 picks the
//   DRUM MACHINE pattern, G1 and G2 bring the bass and the lead in and out, C1 opens the
//   chord filter, C2 sends more to the reverb.
// - One MELODY plays the chord roots in a stab rhythm, a bar each (Am7 Fmaj7 Cmaj7 G7,
//   chained as patterns A-D). CHORD (DIA, in C) turns each root into four notes for
//   four SYNTH voices, which share a FILTER (advanced: C1 at CUT, scaled by AMT).
// - The bass is the same root pitch CV, two octaves down, with its own rhythm: a TRIG
//   SEQ plays its gates on the offbeats. Pitch and gate need not come from one place.
// - The lead is a TURING machine snapped to A minor pentatonic by QUANT.
// - DELAY follows the clock: dotted 8th echoes. SCOPE shows the chords and the C1 lane.
function showcase() {
  const b = new Builder();
  const bank = (pats: unknown[], rt: string[] = ['', '', '', '']) => ({ pats, pr: ['', '', '', ''], rt, e: 0 });
  const clock = b.add('clock', 10, 20, { bpm: 122 });
  //                     INTRO GROOVE LEAD BREAK DROP OUTRO
  const arranger = b.add('arranger', 80, 20, {}, {
    l: [4, 4, 8, 4, 8, 4, 0, 0],
    c: [
      [0, 1, 1, 3, 2, 0, 0, 0], // P1: drum pattern A-D
      [0, 0, 0, 0, 0, 0, 0, 0], // P2
      [0, 1, 1, 0, 1, 0, 0, 0], // G1: bass
      [0, 0, 1, 1, 1, 0, 0, 0], // G2: lead
      [0.25, 0.5, 0.75, 0.25, 1, 0.25, 0, 0], // C1: chord filter
      [0.25, 0.25, 0.25, 0.75, 0.25, 0.75, 0, 0], // C2: reverb
    ],
  });
  // DRUM MACHINE rows: BD, SD, CH, OH, CP, then accents.
  const four = [0, 4, 8, 12], off = [2, 6, 10, 14], sixteenths = [0, 1, 3, 4, 5, 7, 8, 9, 11, 12, 13, 15];
  const drums = b.add('drums', 250, 20, { adv: 1, kit: 1, vol: 0.8 }, bank([
    gridSteps({ name: 'INTRO', rows: [four, [], off, [], []] }, 5),
    gridSteps({ name: 'GROOVE', rows: [four, [], sixteenths, off, [4, 12]] }, 5),
    gridSteps({ name: 'DROP', rows: [four, [15], sixteenths, off, [4, 12, 15]] }, 5),
    gridSteps({ name: 'BREAK', rows: [[], [], off, [], [12]] }, 5),
  ], ['', '', '1111111111111113', '']));
  const mixer = b.add('mixer', 430, 20, { l0: 0.8, l1: 1, l2: 0.7, vol: 0.8 });
  const reverb = b.add('reverb', 500, 20, { size: 0.7, mix: 0.15 });
  const speaker = b.add('speaker', 560, 20);
  const scope = b.add('scope', 500, 90, { tim: 0.35 });

  // Chord roots in C major degrees (0 C ... 5 A ... 7 C), on the stab rhythm x..x..x...x.....
  const stab = (deg: number) => ({ n: Array.from({ length: 16 }, (_, i) => ([0, 3, 6, 10].includes(i) ? deg : -1)) });
  const roots = b.add('melody', 10, 180, { adv: 1, chain: 4, scale: 0, root: 0, oct: 3, gate: 0.35 },
    bank([stab(5), stab(3), stab(7), stab(4)]));
  const chord = b.add('chord', 180, 180, { type: 7, key: 0 });
  const voices = [0, 1, 2, 3].map((i) => b.label(b.add('synth', 270 + i * 70, 180, { wave: 0, cut: 0.6, res: 3, env: 0.3, dec: 0.35 }), ['ROOT', '3RD', '5TH', '7TH'][i]));
  const stabMix = b.add('mixer', 550, 180, { l0: 1, l1: 1, l2: 1, l3: 1, vol: 0.8 });
  const filter = b.add('filter', 620, 180, { adv: 1, cut: 0.3, res: 4, amt: 1 });
  const delay = b.add('delay', 690, 180, { time: 0.05 + (0.95 * 3) / 6, fb: 0.45, mix: 0.35 });

  const bassSeq = b.add('beats', 10, 320, {}, gridSteps({ name: 'BASS', rows: [off] }, 4));
  const bass = b.add('synth', 180, 320, { wave: 2, oct: -2, cut: 0.3, res: 2, env: 0.3, dec: 0.25 });
  const bassVca = b.add('vca', 250, 320);
  const turing = b.add('turing', 310, 320, { chg: 0.05, len: 8, rng: 1 });
  const quant = b.add('quant', 380, 320, { root: 9, scale: 2 });
  const lead = b.add('synth', 450, 320, { wave: 2, oct: 1, cut: 0.6, res: 1, env: 0.3, dec: 0.3 });
  const leadVca = b.add('vca', 520, 320, { amt: 0.4 });

  for (const m of [arranger, drums, roots, bassSeq, turing, delay]) b.wire(clock, 'o16', m, 'clk');
  b.wire(arranger, 'o0', drums, 'pat');
  b.wire(arranger, 'o2', bassVca, 'cv');
  b.wire(arranger, 'o3', leadVca, 'cv');
  b.wire(arranger, 'o4', filter, 'cv');
  b.wire(arranger, 'o5', reverb, 'cv');
  b.wire(roots, 'pit', chord, 'in');
  voices.forEach((v, i) => {
    b.wire(chord, 'o' + i, v, 'pit');
    b.wire(roots, 'gate', v, 'gate');
    b.wire(v, 'out', stabMix, 'i' + i);
  });
  b.wire(stabMix, 'out', filter, 'in');
  b.wire(filter, 'out', delay, 'in');
  b.wire(roots, 'pit', bass, 'pit');
  b.wire(bassSeq, 'o0', bass, 'gate');
  b.wire(bass, 'out', bassVca, 'in');
  b.wire(turing, 'out', quant, 'in');
  b.wire(quant, 'out', lead, 'pit');
  b.wire(turing, 'gate', lead, 'gate');
  b.wire(lead, 'out', leadVca, 'in');
  b.wire(leadVca, 'out', delay, 'in');
  b.wire(drums, 'out', mixer, 'i0');
  b.wire(delay, 'out', reverb, 'in');
  b.wire(reverb, 'out', mixer, 'i1');
  b.wire(bassVca, 'out', mixer, 'i2');
  b.wire(mixer, 'out', speaker, 'in');
  b.wire(filter, 'out', scope, 'a');
  b.wire(arranger, 'o4', scope, 'b');
  // Labels: what each part does.
  b.label(roots, 'CHORD ROOTS');
  b.label(stabMix, 'STAB MIX');
  b.label(filter, 'STAB FILTER');
  b.label(bassSeq, 'BASS RHYTHM');
  b.label(bass, 'BASS');
  b.label(bassVca, 'BASS LEVEL');
  b.label(turing, 'LEAD NOTES');
  b.label(lead, 'LEAD');
  b.label(leadVca, 'LEAD LEVEL');
  b.label(mixer, 'MAIN MIX');
  return b.data;
}

// Brings older patches up to date. Before pitch became a voltage, MELODY and KEYS sent NOTE cables. Rewire those as PIT
// and GATE cables. Two of them into one voice would now add their pitches together, so
// only the first source keeps its cables there; returns how many sources were unplugged.
export function migrate(old: PatchData) {
  // BIG MIXER became MIXER with its BIG layout.
  const data = { ...old, mods: old.mods.map((m) => (m.type === 'mixer8' ? { ...m, type: 'mixer', p: { ...m.p, adv: 1 } } : m)) };
  const type = new Map(data.mods.map((m) => [m.id, m.type]));
  // OSC had one OUT and a WAV knob; now each wave has its own output.
  const wave = new Map(data.mods.map((m) => [m.id, Math.round(m.p.wave ?? 0)]));
  data.cables = data.cables.map((c) => (c.ap === 'out' && type.get(c.a) === 'osc'
    ? { ...c, ap: ['saw', 'sqr', 'tri', 'sin'][wave.get(c.a)!] ?? 'saw' } : c));
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

// MATHS on its own makes a bouncing ball (after the "Bouncing Ball" patch in the MATHS
// manual); an OSC, a VCA and the speaker just make it audible, and a SCOPE visible.
// - CH. 1 cycles slowly: a 1 s rise (silence, the ball is thrown), then a 3.7 s fall.
//   Its EOR is high while it falls, and into CH. 4's CYC makes CH. 4 cycle: the bounces.
// - CH. 1's OUT, turned negative, goes into CH. 4's BOTH: early on CH. 1 is high, so
//   CH. 4 cycles slowly; as CH. 1 falls the bounces come faster and faster.
// - Pitch is the SUM bus: CH. 3 scales CH. 1 (high bounces, high notes) and a little of
//   CH. 4 adds a chirp to each bounce.
// - The QUAD VCA multiplies two contours: its channel 1 opens with each bounce (CH. 4)
//   and feeds channel 2, which follows CH. 1, so the bounces also get quieter.
// A voice in a box: OSC -> FILTER -> VCA with an envelope, inside a SUBMODULE. Its IN,
// OUT and KNOB modules give the box PIT and GATE jacks, a CUT knob and an audio OUT, so
// outside it plays like one module. OPEN it (or double-click it) to see the patch inside.
function subVoice() {
  const inner = new Builder();
  const pit = inner.label(inner.add('subin', 10, 30, { type: 1, slot: 1 }), 'PIT');
  const gate = inner.label(inner.add('subin', 10, 100, { type: 2, slot: 2 }), 'GATE');
  const cut = inner.label(inner.add('subknob', 10, 170, { val: 0.3, slot: 1 }), 'CUT');
  const osc = inner.add('osc', 90, 30);
  const filter = inner.add('filter', 170, 30, { cut: 0.2, res: 6 });
  const vca = inner.add('vca', 240, 30);
  const env = inner.add('env', 90, 100, { a: 0.05, d: 0.5, s: 0.2, r: 0.4 });
  const out = inner.label(inner.add('subout', 310, 30, { slot: 1 }), 'OUT');
  inner.wire(pit, 'out', osc, 'cv');
  inner.wire(gate, 'out', env, 'in');
  inner.wire(osc, 'saw', filter, 'in');
  inner.wire(filter, 'out', vca, 'in');
  inner.wire(env, 'out', filter, 'cv');
  inner.wire(env, 'out', vca, 'cv');
  inner.wire(cut, 'out', filter, 'cv');
  inner.wire(vca, 'out', out, 'in');

  const b = new Builder();
  const clock = b.add('clock', 10, 30, { bpm: 110 });
  const melody = b.melody(82, 30, 'ARP', { oct: 3, gate: 0.6 });
  const voice = b.label(b.add('sub', 256, 40, {}, { key: 'subvoice', d: inner.data }), 'VOICE');
  const delay = b.add('delay', 336, 30, { time: 0.41, fb: 0.4, mix: 0.3 });
  const speaker = b.add('speaker', 396, 30, { vol: 1 });
  b.wire(clock, 'o16', melody, 'clk');
  b.wire(melody, 'pit', voice, 'i1');
  b.wire(melody, 'gate', voice, 'i2');
  b.wire(voice, 'o1', delay, 'in');
  b.wire(delay, 'out', speaker, 'in');
  return b.data;
}

function mathsBounce() {
  const b = new Builder();
  const maths = b.add('maths', 10, 30, {
    cy1: 1, rise1: 0.7, fall1: 0.83, shp1: 0.5, att1: -0.4,
    rise4: 0.15, fall4: 0.5, shp4: 0.8, att4: 0.08,
    att2: 0, att3: 0.5,
  });
  const osc = b.add('osc', 190, 30, { oct: 1 });
  const vca = b.add('vca', 190, 100, { adv: 1, base: 0, amt: 1, base1: 0, amt1: 1 });
  const speaker = b.add('speaker', 320, 30);
  // The SCOPE shows the sound itself, zoomed in 4x: each bounce a burst that fades.
  const scope = b.add('scope', 320, 100, { tim: 1, amp: 4 });
  b.wire(maths, 'eor', maths, 'cyc4');
  b.wire(maths, 'out1', maths, 'cboth4');
  b.wire(maths, 'uni1', maths, 'in3');
  b.wire(maths, 'sum', osc, 'cv');
  b.wire(osc, 'sin', vca, 'in');
  b.wire(maths, 'uni4', vca, 'cv');
  b.wire(vca, 'out', vca, 'in1');
  b.wire(maths, 'uni1', vca, 'cv1');
  b.wire(vca, 'out1', speaker, 'in');
  b.wire(vca, 'out1', scope, 'a');
  return b.data;
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
  { name: 'MATHS BOUNCE', build: mathsBounce },
  { name: 'SUBMODULE VOICE', build: subVoice },
  { name: 'SHOWCASE', build: showcase },
  { name: 'EMPTY', build: () => ({ mods: [], cables: [] }) },
];
