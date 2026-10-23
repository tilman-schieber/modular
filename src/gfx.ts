// Sweetie-16 palette plus a near-black for outlines, and a darker green (moss) for
// title bars, so white text reads on it.
export const C = {
  ink: '#1a1c2c', plum: '#5d275d', red: '#b13e53', orange: '#ef7d57',
  yellow: '#ffcd75', lime: '#a7f070', green: '#38b764', teal: '#257179',
  navy: '#29366f', blue: '#3b5dc9', sky: '#41a6f6', cyan: '#73eff7',
  white: '#f4f4f4', silver: '#94b0c2', slate: '#566c86', dark: '#333c57',
  black: '#0c0d18', moss: '#257d43',
};

// 3x5 bitmap font.
const FONT: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'], D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'], H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'], J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'], L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'], N: ['##.', '#.#', '#.#', '#.#', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'], P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'], R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'], T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'], V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'], X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'], Z: ['###', '..#', '.#.', '#..', '###'],
  '0': ['###', '#.#', '#.#', '#.#', '###'], '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'], '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'], '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'], '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'], '9': ['###', '#.#', '###', '..#', '##.'],
  '.': ['...', '...', '...', '...', '.#.'], ',': ['...', '...', '...', '.#.', '#..'],
  '-': ['...', '...', '###', '...', '...'], '+': ['...', '.#.', '###', '.#.', '...'],
  '#': ['#.#', '###', '#.#', '###', '#.#'], '/': ['..#', '..#', '.#.', '#..', '#..'],
  ':': ['...', '.#.', '...', '.#.', '...'], ';': ['...', '.#.', '...', '.#.', '#..'], '%': ['#.#', '..#', '.#.', '#..', '#.#'],
  '>': ['#..', '.#.', '..#', '.#.', '#..'], '<': ['..#', '.#.', '#..', '.#.', '..#'],
  '!': ['.#.', '.#.', '.#.', '...', '.#.'], '?': ['##.', '..#', '.#.', '...', '.#.'],
  '(': ['.#.', '#..', '#..', '#..', '.#.'], ')': ['.#.', '..#', '..#', '..#', '.#.'],
  "'": ['.#.', '.#.', '...', '...', '...'], '=': ['...', '###', '...', '###', '...'],
  '_': ['...', '...', '...', '...', '###'], '&': ['.#.', '#.#', '.#.', '#.#', '.##'],
};

// Each glyph is a flat list of horizontal runs: x, y, width.
const GLYPHS = new Map<string, number[]>();
for (const [ch, rows] of Object.entries(FONT)) {
  const runs: number[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < 3) {
      if (row[x] !== '#') { x++; continue; }
      const s = x;
      while (x < 3 && row[x] === '#') x++;
      runs.push(s, y, x - s);
    }
  });
  GLYPHS.set(ch, runs);
}

export function textWidth(s: string, scale = 1) {
  return s.length ? (s.length * 4 - 1) * scale : 0;
}

export class Gfx {
  ox = 0;
  oy = 0;
  private last = '';

  constructor(public ctx: CanvasRenderingContext2D) {}

  rect(x: number, y: number, w: number, h: number, c: string) {
    if (c !== this.last) { this.ctx.fillStyle = c; this.last = c; }
    this.ctx.fillRect(x + this.ox, y + this.oy, w, h);
  }

  px(x: number, y: number, c: string) { this.rect(x, y, 1, 1, c); }

  frame(x: number, y: number, w: number, h: number, c: string) {
    this.rect(x, y, w, 1, c);
    this.rect(x, y + h - 1, w, 1, c);
    this.rect(x, y + 1, 1, h - 2, c);
    this.rect(x + w - 1, y + 1, 1, h - 2, c);
  }

  text(s: string, x: number, y: number, c: string, scale = 1) {
    let cx = x;
    for (const ch of s.toUpperCase()) {
      const gl = GLYPHS.get(ch);
      if (gl) {
        for (let i = 0; i < gl.length; i += 3) {
          this.rect(cx + gl[i] * scale, y + gl[i + 1] * scale, gl[i + 2] * scale, scale, c);
        }
      }
      cx += 4 * scale;
    }
  }

  textC(s: string, cx: number, y: number, c: string, scale = 1) {
    this.text(s, cx - Math.floor(textWidth(s, scale) / 2), y, c, scale);
  }

  // Pixel disc: includes points with dx²+dy² <= r²+r, which gives round small circles.
  disc(cx: number, cy: number, r: number, c: string) {
    for (let dy = -r; dy <= r; dy++) {
      const dx = Math.floor(Math.sqrt(r * r + r - dy * dy));
      this.rect(cx - dx, cy + dy, dx * 2 + 1, 1, c);
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, c: string) {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
}
