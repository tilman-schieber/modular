import { ac } from './audio';

// Records an input between two times on the audio clock, to the sample, and hands
// back each take as a WAV. The AudioWorklet cuts the takes itself, so a take started
// by a trigger begins exactly on that trigger.
const PROCESSOR = `
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.from = Infinity; this.to = Infinity;
    this.port.onmessage = (e) => {
      if (e.data.start !== undefined) { this.from = e.data.start; this.to = Infinity; }
      if (e.data.stop !== undefined) this.to = e.data.stop;
    };
  }
  process(inputs) {
    const ch = inputs[0], n = 128, t0 = currentTime, t1 = t0 + n / sampleRate;
    if (this.from < t1 && this.to > t0) {
      const a = Math.max(0, Math.round((this.from - t0) * sampleRate));
      const b = Math.min(n, Math.round((this.to - t0) * sampleRate));
      if (b > a) {
        // nothing plugged in records silence
        const l = ch[0] ? ch[0].slice(a, b) : new Float32Array(b - a);
        const r = ch[1] ? ch[1].slice(a, b) : l.slice();
        this.port.postMessage([l, r]);
      }
    }
    if (this.to <= t1 && this.from !== Infinity) {
      this.port.postMessage('done');
      this.from = this.to = Infinity;
    }
    return true;
  }
}
registerProcessor('tap', Tap);
`;

let ready: Promise<void> | null = null;

export class Recorder {
  // Patch the signal to record into this.
  in = ac.createGain();
  private node: AudioWorkletNode | null = null;
  // The tap feeds a silent gain into the destination so every browser keeps it running.
  private mute = ac.createGain();
  private chunks: [Float32Array, Float32Array][] = [];
  // Start/stop messages sent before the worklet has loaded wait here.
  private queue: object[] = [];
  private from = 0;
  recording = false;

  constructor(private done: (wav: Blob) => void) {
    this.mute.gain.value = 0;
    this.mute.connect(ac.destination);
    ready ??= ac.audioWorklet.addModule(URL.createObjectURL(new Blob([PROCESSOR], { type: 'text/javascript' })));
    void ready.then(() => {
      const node = new AudioWorkletNode(ac, 'tap', { channelCount: 2, channelCountMode: 'explicit' });
      node.port.onmessage = (e) => {
        if (e.data !== 'done') { this.chunks.push(e.data); return; }
        if (this.chunks.length) this.done(encodeWav(this.chunks, ac.sampleRate));
        this.chunks = [];
      };
      this.in.connect(node).connect(this.mute);
      this.node = node;
      for (const msg of this.queue) node.port.postMessage(msg);
      this.queue = [];
    });
  }

  // Seconds recorded so far in this take.
  get seconds() {
    const now = ac.currentTime;
    return this.recording ? Math.max(0, now - this.from) : 0;
  }

  private send(msg: object) {
    if (this.node) this.node.port.postMessage(msg);
    else this.queue.push(msg);
  }

  start(t: number) {
    if (this.recording) return;
    this.recording = true;
    this.from = t;
    this.chunks = [];
    this.send({ start: t });
  }

  stop(t: number) {
    if (!this.recording) return;
    this.recording = false;
    this.send({ stop: t });
  }

  destroy() {
    this.in.disconnect();
    this.node?.disconnect();
    this.mute.disconnect();
  }
}

export const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function encodeWav(chunks: [Float32Array, Float32Array][], rate: number) {
  const frames = chunks.reduce((n, c) => n + c[0].length, 0);
  const buf = new ArrayBuffer(44 + frames * 4);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + frames * 4, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true); // stereo
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 4, true); // bytes per second
  v.setUint16(32, 4, true); // bytes per frame
  v.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, frames * 4, true);
  let o = 44;
  for (const [l, r] of chunks) {
    for (let i = 0; i < l.length; i++) {
      v.setInt16(o, Math.max(-1, Math.min(1, l[i])) * 0x7fff, true);
      v.setInt16(o + 2, Math.max(-1, Math.min(1, r[i])) * 0x7fff, true);
      o += 4;
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
