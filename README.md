# Pixel Modular

A modular synthesizer in the browser, drawn as pixel art. Place modules, patch them
with cables, press space.

**Live:** https://gh.tschieber.de/modular/

- A one-module DRUM MACHINE (808/909/lo-fi kick, snare, hats, clap) with its own tempo,
  or separate drum modules driven by a step sequencer
- Pitch is a voltage (1 per octave) and gates are exactly timed triggers, as on a real
  modular: sequencers and KEYS send PIT and GATE, QUANT snaps CV to a scale, SLEW glides,
  CHORD turns one pitch into the four notes of a chord (fixed types or diatonic)
- An ARRANGER for whole songs: sections some bars long, with lanes that pick sequencer
  patterns (the PAT jacks), bring parts in and out, and set levels per section
- Synth voices, oscillators, noise, LFO, envelope, VCA, filter, delay (clock-synced with
  a cable at CLK), reverb, ring mod, mixer (click a channel number to mute, shift+click to solo)
- Shift+click an effect to bypass it; audio and CV cables show the signal flowing through them
- Utilities: TURING machine, LOGIC, sequential switch, CV MIX, SCOPE with a tuner
- Modules stay simple; the + in a title bar opens an advanced layout (CLOCK: tap tempo,
  clock in, reset and division outs; sequencers: reset, per-step chance and ratchets,
  patterns A-D with chaining and a PAT input; FILTER: LP/HP/BP outputs at once, key
  tracking and a CV depth knob; MIXER: 8 channels with pan)
- Play live from the computer keyboard or a MIDI keyboard (velocity, mod wheel, pitch bend, aftertouch, sustain)
- MIDI clock in and out, and MIDI learn: Alt+click a knob, then move a control
- A RECORDER module: records any signal to WAV, by hand or started and stopped exactly by triggers
- Undo/redo, and share links that carry the whole patch

```sh
npm install
npm run dev
```
