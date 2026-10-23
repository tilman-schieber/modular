import { C, textWidth, type Gfx } from './gfx';
import { CAT, TYPEC, type Knob, type Mod, type Port } from './mod';

export function drawButton(g: Gfx, x: number, y: number, w: number, label: string, col: string, text = C.ink) {
  g.rect(x, y, w, 9, C.black);
  g.rect(x + 1, y + 1, w - 2, 7, col);
  g.rect(x + 1, y + 1, w - 2, 1, C.white);
  g.textC(label, x + Math.floor(w / 2), y + 2, text);
}

export function drawJack(g: Gfx, p: Port) {
  const cx = p.x + 4, cy = p.y + 4;
  if (p.dir === 'out') {
    const pw = Math.max(13, textWidth(p.label) + 2);
    g.rect(cx - Math.floor(pw / 2), p.y - 2, pw, p.label ? 19 : 13, C.ink);
  }
  g.disc(cx, cy, 4, C.black);
  g.disc(cx, cy, 3, TYPEC[p.type]);
  g.rect(cx - 1, cy - 1, 3, 3, C.black);
  g.px(cx - 2, cy - 2, C.white);
  if (p.label) g.textC(p.label, cx, p.y + 11, C.silver);
}

export function drawKnob(g: Gfx, m: Mod, k: Knob) {
  const cx = k.x + 5, cy = k.y + 5;
  const cap = CAT[m.cat].cap;
  g.disc(cx, cy + 1, 5, C.black);
  g.disc(cx, cy, 5, C.black);
  g.disc(cx, cy, 4, cap);
  g.px(cx - 2, cy - 3, C.white);
  g.px(cx - 3, cy - 2, C.white);
  const n = (m.p[k.id] - k.min) / (k.max - k.min);
  const a = (-135 + 270 * n) * (Math.PI / 180);
  g.line(cx, cy, cx + Math.round(Math.sin(a) * 4), cy - Math.round(Math.cos(a) * 4), C.black);
  g.textC(m.knobLabel(k), cx, k.y + 13, k.names ? cap : C.silver);
  // A MIDI-mapped knob gets a small blue mark.
  if (m.cc[k.id] !== undefined) g.rect(k.x + 10, k.y - 1, 2, 2, C.sky);
}

const GRAY = 'grayscale(1) brightness(0.6)';

// A labelled module's name bar sits on top of its title bar, in a light tint of the
// title bar's colour (so a plum SEQUENCE title gets a pale plum label).
export const LABEL_H = 10;

const tints = new Map<string, string>();
function tint(hex: string) {
  let t = tints.get(hex);
  if (!t) {
    t = '#' + [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16);
      return Math.round(v + (0xf4 - v) * 0.55).toString(16).padStart(2, '0');
    }).join('');
    tints.set(hex, t);
  }
  return t;
}

export function fitLabel(text: string, w: number) {
  let t = text;
  while (t && textWidth(t) > w - 7) t = t.slice(0, -1);
  return t;
}

export function drawModule(g: Gfx, m: Mod, closeHover: boolean, advHover = false) {
  const { w, h } = m;
  // A bypassed effect is drawn grayed out.
  if (m.bypassed) g.ctx.filter = GRAY;
  const bar = CAT[m.cat].bar;
  if (m.label) {
    const y = -LABEL_H;
    g.rect(2, y + 2, w, LABEL_H, C.black); // drop shadow
    g.rect(0, y, w, LABEL_H + 1, C.black);
    g.rect(1, y + 1, w - 2, LABEL_H - 1, tint(bar));
    g.rect(1, y + 1, w - 2, 1, C.white);
    g.text(fitLabel(m.label, w), 4, y + 3, C.ink);
  }
  g.rect(2, 2, w, h, C.black); // drop shadow
  g.rect(0, 0, w, h, C.black);
  g.rect(1, 1, w - 2, h - 2, C.dark);
  g.rect(1, 1, 1, h - 2, C.slate);
  g.rect(1, h - 2, w - 2, 1, C.ink);
  g.rect(w - 2, 1, 1, h - 2, C.ink);
  g.rect(1, 1, w - 2, 9, bar);
  g.rect(1, 1, w - 2, 1, C.white);
  g.rect(1, 10, w - 2, 1, C.black);
  g.text(m.title, 4, 3, C.white);
  // advanced-layout toggle: "+" opens it, "-" closes it
  if (m.advName) {
    const ax = w - 17;
    g.rect(ax, 2, 7, 7, advHover ? C.white : C.ink);
    g.rect(ax + 1, 5, 5, 1, advHover ? C.ink : C.white);
    if (!m.isAdv) g.rect(ax + 3, 3, 1, 5, advHover ? C.ink : C.white);
  }
  // close "x"
  const xc = closeHover ? C.white : C.ink;
  for (let i = 0; i < 5; i++) {
    g.px(w - 8 + i, 3 + i, xc);
    g.px(w - 4 - i, 3 + i, xc);
  }
  m.drawBody(g);
  for (const p of m.ports) drawJack(g, p);
  for (const k of m.knobs) drawKnob(g, m, k);
  if (!m.bypassed) return;
  if (g.ctx.filter !== GRAY) {
    // no canvas filters in this browser: dim it instead
    g.ctx.globalAlpha = 0.55;
    g.rect(0, 0, w, h, C.ink);
    g.ctx.globalAlpha = 1;
  }
  g.ctx.filter = 'none';
}

// Signal flowing along a cable, from its output end: dots that move along it and
// glow with the level (0..1).
export function drawFlow(g: Gfx, x0: number, y0: number, x1: number, y1: number, level: number, phase: number) {
  if (level < 0.02) return;
  const pts = cablePoints(x0, y0, x1, y1), gap = 8, off = Math.floor(phase) % gap;
  g.ctx.globalAlpha = Math.min(1, 0.25 + level);
  for (let i = off; i < pts.length; i += gap) g.rect(pts[i][0], pts[i][1], 2, 2, C.white);
  g.ctx.globalAlpha = 1;
}

export function cablePoints(x0: number, y0: number, x1: number, y1: number) {
  const d = Math.hypot(x1 - x0, y1 - y0);
  const sag = Math.min(70, 6 + d * 0.3);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 + sag;
  const n = Math.max(2, Math.ceil((d + sag) * 1.5));
  const pts: [number, number][] = [];
  let lx = NaN, ly = NaN;
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const x = Math.round(u * u * x0 + 2 * u * t * cx + t * t * x1);
    const y = Math.round(u * u * y0 + 2 * u * t * cy + t * t * y1);
    if (x === lx && y === ly) continue;
    pts.push([x, y]);
    lx = x; ly = y;
  }
  return pts;
}

export function plug(g: Gfx, x: number, y: number, col: string) {
  g.rect(x - 3, y - 3, 7, 7, C.black);
  g.rect(x - 2, y - 2, 5, 5, col);
  g.px(x - 2, y - 2, C.white);
}

export function drawCable(g: Gfx, x0: number, y0: number, x1: number, y1: number, col: string, lit: boolean) {
  const pts = cablePoints(x0, y0, x1, y1);
  for (const [x, y] of pts) g.rect(x - 1, y - 1, 4, 4, C.black);
  for (const [x, y] of pts) g.rect(x, y, 2, 2, lit ? C.white : col);
  plug(g, x0, y0, col);
  plug(g, x1, y1, col);
}
