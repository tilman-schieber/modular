# Pixel Modular

A modular synthesizer in the browser, drawn as pixel art. Place modules, patch them
with cables, press space.

**Live:** https://gh.tschieber.de/modular/

- A one-module DRUM MACHINE (808/909/lo-fi kick, snare, hats, clap) with its own tempo,
  or separate drum modules driven by a step sequencer
- Pitch is a voltage (1 per octave) and gates are exactly timed triggers, as on a real
  modular: sequencers and KEYS send PIT and GATE, QUANT snaps CV to a scale, SLEW glides
- Synth voices, oscillators, noise, LFO, envelope, VCA, filter, delay, reverb, ring mod, mixer
- Utilities: TURING machine, LOGIC, sequential switch, CV MIX, SCOPE with a tuner
- Modules stay simple; the + in a title bar opens an advanced layout (CLOCK: tap tempo,
  clock in, reset and division outs; sequencers: reset, per-step chance and ratchets,
  patterns A-D with chaining; MIXER: 8 channels with pan)
- Play live from the computer keyboard or a MIDI keyboard (velocity, mod wheel, pitch bend, aftertouch, sustain)
- MIDI clock in and out, and MIDI learn: Alt+click a knob, then move a control
- Undo/redo, WAV recording, and share links that carry the whole patch

```sh
npm install
npm run dev
```
