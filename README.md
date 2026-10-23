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
- Synth voices, oscillators (all four waves at once), noise, LFO, envelope, VCA, filter, delay (clock-synced with
  a cable at CLK), reverb, ring mod, mixer (click a channel number to mute, shift+click to solo)
- Shift+click an effect to bypass it; audio and CV cables show the signal flowing through them
- Utilities: TURING machine, LOGIC, sequential switch, CV MIX, SCOPE with a tuner
- PADS to play by hand (click or keys 1-4): each pad triggers, gates while held or latches
  on and off, to fire fills or bring parts in and out during a performance
- Modules stay simple; the + in a title bar opens an advanced layout (CLOCK: tap tempo,
  clock in, reset and division outs; sequencers: reset, per-step chance and ratchets,
  patterns A-D with chaining and a PAT input; FILTER: LP/HP/BP outputs at once, key
  tracking and a CV depth knob; MIXER: 8 channels with pan; VCA: a quad VCA and mixer
  with lin/exp response, bipolar CV, normalled CV jacks and outputs, and a SUM out; LFO: all
  waves at once plus random, clock sync, reset and unipolar; NOISE: white, pink, brown and
  blue outs, dust and a sample and hold; OSC: pulse width and PWM, FM depth, hard sync and
  a sub octave; PADS: presses quantized to a clock, CV outs and MIDI mapping)
- An ADVANCED menu with models of real hardware modules: MATHS (after Make Noise MATHS),
  two function generators for envelopes, LFOs and slew, plus attenuverters and SUM, INV and OR buses
  (example patch: MATHS BOUNCE)
- Press ? (or the ? button) and hover anything for help; ?, Esc or a right-click leaves help mode
- Play live from the computer keyboard or a MIDI keyboard (velocity, mod wheel, pitch bend, aftertouch, sustain)
- MIDI clock in and out, and MIDI learn: Alt+click a knob, then move a control
- A RECORDER module: records any signal to WAV, by hand or started and stopped exactly by triggers
- Undo/redo, and share links that carry the whole patch

```sh
npm install
npm run dev
```
