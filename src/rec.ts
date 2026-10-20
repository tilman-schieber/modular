import { ac } from './audio';

// Captures raw stereo samples from a node with an AudioWorklet and saves them as a WAV.
const PROCESSOR = `
class Tap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0];
    if (ch.length) this.port.postMessage([ch[0].slice(), (ch[1] || ch[0]).slice()]);
    return true;
  }
}
registerProcessor('tap', Tap);
`;

let ready: Promise<void> | null = null;

export class Recorder {
  private node: AudioWorkletNode | null = null;
  // The tap feeds a silent gain into the destination so every browser keeps it running.
  private mute = ac.createGain();
  private chunks: [Float32Array, Float32Array][] = [];
  private started = 0;

  constructor(private source: AudioNode) {
    this.mute.gain.value = 0;
    this.mute.connect(ac.destination);
  }

  get recording() { return this.node !== null; }
  get seconds() { return this.recording ? ac.currentTime - this.started : 0; }

  async start() {
    ready ??= ac.audioWorklet.addModule(URL.createObjectURL(new Blob([PROCESSOR], { type: 'text/javascript' })));
    await ready;
    this.chunks = [];
    this.started = ac.currentTime;
    const node = new AudioWorkletNode(ac, 'tap', { channelCount: 2, channelCountMode: 'explicit' });
    node.port.onmessage = (e) => this.chunks.push(e.data);
    this.source.connect(node);
    node.connect(this.mute);
    this.node = node;
  }

  // Stops and returns the recording as a WAV blob.
  stop() {
    if (!this.node) return null;
    this.source.disconnect(this.node);
    this.node.disconnect();
    this.node.port.onmessage = null;
    this.node = null;
    return encodeWav(this.chunks, ac.sampleRate);
  }
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
