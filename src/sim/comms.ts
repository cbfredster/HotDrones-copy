import { Config } from "./config";
import { Environment } from "./environment";
import { Terrain } from "./terrain";

export interface Blackout {
  x: number;
  y: number;
  r: number;
}

export interface CommsNode {
  id: number; // drones use their id; the base uses BASE_ID
  x: number;
  y: number;
  z: number; // absolute altitude
  range: number;
}

export const BASE_ID = -1;

/** The base's antenna sits this far above the terrain (sim height units). */
export const BASE_MAST_HEIGHT = 6;

// Height of the terrain at a fractional position (bilinear).
export function terrainHeightAt(t: Terrain, x: number, y: number) {
  const cx = Math.max(0, Math.min(t.w - 1.001, x));
  const cy = Math.max(0, Math.min(t.h - 1.001, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const fx = cx - x0;
  const fy = cy - y0;
  const h = t.height;
  const w = t.w;
  const a = h[y0 * w + x0];
  const b = h[y0 * w + x0 + 1];
  const c = h[(y0 + 1) * w + x0];
  const d = h[(y0 + 1) * w + x0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

export function inBlackout(blackouts: Blackout[], x: number, y: number) {
  for (const b of blackouts) if ((x - b.x) ** 2 + (y - b.y) ** 2 <= b.r * b.r) return true;
  return false;
}

// Can a and b talk directly? Needs: in range, clear 3D line of sight over the hills,
// neither inside a blackout zone, and (optionally) no thick smoke in between.
export function canLink(
  a: CommsNode,
  b: CommsNode,
  terrain: Terrain,
  env: Environment,
  blackouts: Blackout[],
  cfg: Config,
): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist > Math.min(a.range, b.range)) return false;
  if (inBlackout(blackouts, a.x, a.y) || inBlackout(blackouts, b.x, b.y)) return false;
  const steps = Math.max(2, Math.ceil(dist * 2));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    const lineZ = a.z + (b.z - a.z) * t;
    if (terrainHeightAt(terrain, x, y) > lineZ) return false; // a hill is in the way
    if (cfg.smokeBlocksComms && env.smokeAt(x, y) > cfg.thickSmoke * 1.5) return false;
  }
  return true;
}

export type LinkBlock = "hill" | "smoke" | "blackout";

export interface BlockedLink {
  reason: LinkBlock;
  /** Where the link is cut: the hill or smoke on the line, or the endpoint inside a blackout zone. */
  x: number;
  y: number;
  z: number;
}

/**
 * Why can't a and b talk, although they are within radio range?
 * Returns null if they can link, or if they are simply out of range.
 * A read-only companion to canLink (same checks, in the same order), used by renderers
 * to draw broken links by cause. It must never be used to decide who is connected.
 */
export function linkBlockReason(
  a: CommsNode,
  b: CommsNode,
  terrain: Terrain,
  env: Environment,
  blackouts: Blackout[],
  cfg: Config,
): BlockedLink | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist > Math.min(a.range, b.range)) return null;
  if (inBlackout(blackouts, a.x, a.y)) return { reason: "blackout", x: a.x, y: a.y, z: a.z };
  if (inBlackout(blackouts, b.x, b.y)) return { reason: "blackout", x: b.x, y: b.y, z: b.z };
  const steps = Math.max(2, Math.ceil(dist * 2));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    const lineZ = a.z + (b.z - a.z) * t;
    if (terrainHeightAt(terrain, x, y) > lineZ) return { reason: "hill", x, y, z: lineZ };
    if (cfg.smokeBlocksComms && env.smokeAt(x, y) > cfg.thickSmoke * 1.5) return { reason: "smoke", x, y, z: lineZ };
  }
  return null;
}

/** Relay towers use ids below BASE_ID: tower k is node -2 - k. */
export const towerNodeId = (k: number) => -2 - k;
export const isTowerId = (id: number) => id < BASE_ID;

export interface Network {
  links: [number, number][]; // pairs of node ids with a direct link
  componentOf: Map<number, number>; // node id -> component index
  components: number[][]; // node ids per component (relaying = multi-hop)
}

export function buildNetwork(
  nodes: CommsNode[],
  terrain: Terrain,
  env: Environment,
  blackouts: Blackout[],
  cfg: Config,
): Network {
  const links: [number, number][] = [];
  const adj = new Map<number, number[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (canLink(nodes[i], nodes[j], terrain, env, blackouts, cfg)) {
        links.push([nodes[i].id, nodes[j].id]);
        adj.get(nodes[i].id)!.push(nodes[j].id);
        adj.get(nodes[j].id)!.push(nodes[i].id);
      }
    }
  }
  // Connected components: messages can hop through intermediate drones.
  const componentOf = new Map<number, number>();
  const components: number[][] = [];
  for (const n of nodes) {
    if (componentOf.has(n.id)) continue;
    const comp: number[] = [];
    const stack = [n.id];
    componentOf.set(n.id, components.length);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(id);
      for (const m of adj.get(id)!) {
        if (!componentOf.has(m)) {
          componentOf.set(m, components.length);
          stack.push(m);
        }
      }
    }
    components.push(comp);
  }
  return { links, componentOf, components };
}
