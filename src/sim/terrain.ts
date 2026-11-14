import { Rng } from "./rng";

export enum Tile {
  Grass = 0,
  Forest = 1,
  Sand = 2,
  Rock = 3,
  Water = 4,
}

export const TILE_NAMES = ["grass", "forest", "sand", "rock", "water"];

// How readily each tile type catches fire (0 = never) and how long it burns.
export const FUEL: Record<Tile, { ignite: number; burnTicks: number }> = {
  [Tile.Grass]: { ignite: 1.0, burnTicks: 25 },
  [Tile.Forest]: { ignite: 0.85, burnTicks: 70 },
  [Tile.Sand]: { ignite: 0, burnTicks: 0 },
  [Tile.Rock]: { ignite: 0, burnTicks: 0 },
  [Tile.Water]: { ignite: 0, burnTicks: 0 },
};

export interface Terrain {
  w: number;
  h: number;
  height: Float32Array; // absolute terrain height per tile
  type: Uint8Array; // Tile enum per tile
  village: number[]; // tile indices of the protected village
  base: { x: number; y: number };
}

// Smooth value noise with several octaves -> rolling hills.
function makeNoise(rng: Rng, w: number, h: number, octaves: number): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const cell = Math.max(2, Math.floor(Math.min(w, h) / 2 ** (o + 1)));
    const gw = Math.ceil(w / cell) + 2;
    const gh = Math.ceil(h / cell) + 2;
    const grid = new Float32Array(gw * gh);
    for (let i = 0; i < grid.length; i++) grid[i] = rng.next();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const gx = x / cell;
        const gy = y / cell;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = smooth(gx - x0);
        const fy = smooth(gy - y0);
        const a = grid[y0 * gw + x0];
        const b = grid[y0 * gw + x0 + 1];
        const c = grid[(y0 + 1) * gw + x0];
        const d = grid[(y0 + 1) * gw + x0 + 1];
        out[y * w + x] += amp * lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
      }
    }
    total += amp;
    amp *= 0.5;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function percentile(arr: Float32Array, p: number): number {
  const s = Array.from(arr).sort((a, b) => a - b);
  return s[Math.floor(p * (s.length - 1))];
}

export function generateTerrain(rng: Rng, w: number, h: number, heightScale: number): Terrain {
  const raw = makeNoise(rng, w, h, 4);
  const veg = makeNoise(rng, w, h, 3);
  const height = new Float32Array(w * h);
  const type = new Uint8Array(w * h);

  const waterLevel = percentile(raw, 0.1);
  const rockLevel = percentile(raw, 0.93);
  const forestLevel = percentile(veg, 0.3); // ~70% coniferous forest

  for (let i = 0; i < w * h; i++) {
    height[i] = raw[i] * heightScale;
    if (raw[i] <= waterLevel) type[i] = Tile.Water;
    else if (raw[i] >= rockLevel) type[i] = Tile.Rock;
    else type[i] = veg[i] > forestLevel ? Tile.Forest : Tile.Grass;
  }
  // Water surfaces are flat.
  for (let i = 0; i < w * h; i++) if (type[i] === Tile.Water) height[i] = waterLevel * heightScale;

  // Sandy shores next to water.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (type[i] === Tile.Water || type[i] === Tile.Rock) continue;
      if (raw[i] > waterLevel + 0.03) continue;
      if (neighbours4(x, y, w, h).some((j) => type[j] === Tile.Water)) type[i] = Tile.Sand;
    }
  }

  // Guarantee at least two water sources: carve small ponds if the noise made none.
  let waterCount = 0;
  for (let i = 0; i < w * h; i++) if (type[i] === Tile.Water) waterCount++;
  if (waterCount < 20) {
    for (let p = 0; p < 2; p++) carvePond(rng, type, height, w, h, waterLevel * heightScale);
  }

  // Village: a 3x3 cluster of grass near the lower-middle of the map.
  const village: number[] = [];
  const vc = findLand(type, w, h, Math.floor(w * 0.55), Math.floor(h * 0.72));
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = clamp(vc.x + dx, 0, w - 1);
      const y = clamp(vc.y + dy, 0, h - 1);
      const i = y * w + x;
      type[i] = Tile.Grass;
      village.push(i);
    }
  }

  // Home base: bottom-left area on dry land, away from the village.
  const base = findLand(type, w, h, Math.floor(w * 0.12), Math.floor(h * 0.88));

  return { w, h, height, type, village, base };
}

function carvePond(rng: Rng, type: Uint8Array, height: Float32Array, w: number, h: number, level: number) {
  const cx = 5 + rng.int(w - 10);
  const cy = 5 + rng.int(h - 10);
  for (let y = cy - 2; y <= cy + 2; y++) {
    for (let x = cx - 2; x <= cx + 2; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > 5) continue;
      type[y * w + x] = Tile.Water;
      height[y * w + x] = Math.min(height[y * w + x], level);
    }
  }
}

function findLand(type: Uint8Array, w: number, h: number, sx: number, sy: number) {
  // Spiral outwards from (sx, sy) until a flammable land tile is found.
  for (let r = 0; r < Math.max(w, h); r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = sx + dx;
        const y = sy + dy;
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const t = type[y * w + x];
        if (t === Tile.Grass || t === Tile.Forest) return { x, y };
      }
    }
  }
  return { x: sx, y: sy };
}

export function neighbours4(x: number, y: number, w: number, h: number): number[] {
  const out: number[] = [];
  if (x > 0) out.push(y * w + x - 1);
  if (x < w - 1) out.push(y * w + x + 1);
  if (y > 0) out.push((y - 1) * w + x);
  if (y < h - 1) out.push((y + 1) * w + x);
  return out;
}

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/**
 * Sites for relay towers: the highest dry ground, spread out, away from the map edge,
 * the base and the village. Deterministic (no randomness), so it needs no RNG stream.
 */
export function pickTowerSites(t: Terrain, count: number): { x: number; y: number }[] {
  const sites: { x: number; y: number }[] = [];
  if (count <= 0) return sites;
  const v = t.village[4] ?? t.village[0];
  const keepOut = [
    { x: t.base.x, y: t.base.y, r: 12 },
    { x: v % t.w, y: Math.floor(v / t.w), r: 5 },
  ];
  const order: number[] = [];
  for (let i = 0; i < t.w * t.h; i++) order.push(i);
  order.sort((a, b) => t.height[b] - t.height[a] || a - b); // highest first, index breaks ties
  const margin = 4;
  const spacing = Math.max(8, Math.min(t.w, t.h) / 3.5);
  for (const i of order) {
    if (sites.length >= count) break;
    const x = i % t.w;
    const y = Math.floor(i / t.w);
    if (t.type[i] === Tile.Water) continue;
    if (x < margin || y < margin || x >= t.w - margin || y >= t.h - margin) continue;
    if (keepOut.some((k) => Math.hypot(k.x - x, k.y - y) < k.r)) continue;
    if (sites.some((s) => Math.hypot(s.x - x, s.y - y) < spacing)) continue;
    sites.push({ x, y });
  }
  return sites;
}
