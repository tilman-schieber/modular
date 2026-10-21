import type { PatchData } from './patches';

// Share links carry the whole patch in the URL hash: #p=<base64url(deflate(json))>.
// Mods are stored as [type, x, y, params, state, midi cc map?]; cables refer to mods by index.
type PackedMod = [string, number, number, Record<string, number>, unknown, Record<string, number>?];
type Packed = { v: 1; m: PackedMod[]; c: [number, string, number, string][] };

function pack(data: PatchData): Packed {
  const index = new Map(data.mods.map((m, i) => [m.id, i]));
  const round = (p: Record<string, number>) =>
    Object.fromEntries(Object.entries(p).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
  return {
    v: 1,
    m: data.mods.map((m): PackedMod => (m.cc ? [m.type, m.x, m.y, round(m.p), m.s ?? null, m.cc] : [m.type, m.x, m.y, round(m.p), m.s ?? null])),
    c: data.cables.map((c) => [index.get(c.a)!, c.ap, index.get(c.b)!, c.bp]),
  };
}

function unpack(p: Packed): PatchData {
  return {
    mods: p.m.map(([type, x, y, params, s, cc], i) => ({ id: i + 1, type, x, y, p: params, s: s ?? undefined, cc })),
    cables: p.c.map(([a, ap, b, bp]) => ({ a: a + 1, ap, b: b + 1, bp })),
  };
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

function toBase64Url(bytes: Uint8Array) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

export async function encodePatch(data: PatchData) {
  const json = new TextEncoder().encode(JSON.stringify(pack(data)));
  return toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodePatch(code: string): Promise<PatchData> {
  const json = await pipe(fromBase64Url(code), new DecompressionStream('deflate-raw'));
  const p = JSON.parse(new TextDecoder().decode(json)) as Packed;
  if (p.v !== 1 || !Array.isArray(p.m) || !Array.isArray(p.c)) throw new Error('bad patch');
  return unpack(p);
}

export function hashCode() {
  const m = location.hash.match(/^#p=([\w-]+)$/);
  return m ? m[1] : null;
}
