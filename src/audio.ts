export const ac = new AudioContext();

let noise: AudioBuffer | null = null;

export function noiseBuffer() {
  if (!noise) {
    noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noise;
}

// A white-noise source that plays from t for dur seconds.
export function noiseSrc(t: number, dur: number) {
  const s = ac.createBufferSource();
  s.buffer = noiseBuffer();
  s.start(t, Math.random() * 1.2);
  s.stop(t + Math.min(dur, 0.75));
  return s;
}

// Exponential decay from peak to silence.
export function decay(param: AudioParam, t: number, peak: number, len: number) {
  param.setValueAtTime(peak, t);
  param.exponentialRampToValueAtTime(0.001, t + len);
}

export function cutHz(v: number) {
  return 40 * 2 ** (v * 9);
}
