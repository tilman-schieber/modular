import { ac } from './audio';

// One shared Web MIDI connection: every input is merged into one stream that modules
// subscribe to, and clock messages can be sent to every output.
// Listeners get the raw message and its arrival time on the audio clock.
type Listener = (data: Uint8Array, t: number) => void;

class MidiHub {
  access: MIDIAccess | null = null;
  private listeners = new Set<Listener>();
  private pending: Promise<boolean> | null = null;

  get enabled() { return this.access !== null; }

  enable() {
    if (!navigator.requestMIDIAccess) return Promise.resolve(false);
    this.pending ??= navigator.requestMIDIAccess().then((access) => {
      this.access = access;
      const listen = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = (msg) => {
            if (!msg.data) return;
            const t = toAudioTime(msg.timeStamp);
            for (const fn of this.listeners) fn(msg.data, t);
          };
        }
      };
      listen();
      access.onstatechange = listen;
      return true;
    }).catch(() => {
      // Permission denied or no MIDI: allow asking again later.
      this.pending = null;
      return false;
    });
    return this.pending;
  }

  // Returns an unsubscribe function.
  on(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  // Send to every output, at audio time t (or right away).
  send(data: number[], t?: number) {
    if (!this.access) return;
    const at = t === undefined ? undefined : toPerfTime(t);
    for (const out of this.access.outputs.values()) out.send(data, at);
  }
}

const toAudioTime = (perf: number) => ac.currentTime + (perf - performance.now()) / 1000;
const toPerfTime = (t: number) => performance.now() + (t - ac.currentTime) * 1000;

export const midi = new MidiHub();
