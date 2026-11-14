// Shared helpers for the isometric renderer.
//
// Coordinate convention used by every layer:
//   sim x  -> three.js X        (1 tile = 1 unit, tile i is centred on integer coordinates)
//   sim y  -> three.js Z
//   height -> three.js Y, multiplied by V_SCALE
import { BufferAttribute, Color, InstancedBufferAttribute, InstancedMesh, Material, Matrix4, Quaternion, Vector3 } from "three";

/**
 * The ONE vertical scale. Terrain, drone altitude, the base mast, relay towers, link
 * endpoints and smoke all multiply their sim height by this, so a link that the sim's
 * line-of-sight test says clears a hill visibly clears it, and one that is blocked
 * visibly clips it.
 */
export const V_SCALE = 0.4;

/** Columns extend this far (world units) below the lowest terrain, so the map reads as a chunky slab. */
export const SLAB_DEPTH = 1.6;

/**
 * Deterministic cosmetic randomness in [0, 1): a hash of two integers.
 * Renderers must never call world.rng / world.agentRng (that would change the run),
 * so tree placement, colour jitter, flicker phases etc. all come from here.
 */
export function hash01(a: number, b = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca6b);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** A small cosmetic PRNG for particle bursts (seeded from tick/drone ids, never from the sim RNGs). */
export class CosmeticRng {
  private s: number;
  constructor(seed: number) {
    this.s = (seed >>> 0) || 1;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Colours are authored as sRGB hex and converted once to three's linear working space. */
export function rgb(hex: number): Color {
  return new Color(hex);
}

/** out = a + (b - a) * t, written into `out` (linear space). */
export function mixColor(out: Color, a: Color, b: Color, t: number): Color {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
  return out;
}

const _m = new Matrix4();
const _q = new Quaternion();
const _p = new Vector3();
const _s = new Vector3();
const _zAxis = new Vector3(0, 0, 1);
const _yAxis = new Vector3(0, 1, 0);
const _dir = new Vector3();

/** Write a translate * rotateY * scale matrix into instance `i`. */
export function setInstance(
  mesh: InstancedMesh,
  i: number,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  rotY = 0,
) {
  _p.set(x, y, z);
  _s.set(sx, sy, sz);
  if (rotY === 0) _q.identity();
  else _q.setFromAxisAngle(_yAxis, rotY);
  _m.compose(_p, _q, _s);
  mesh.setMatrixAt(i, _m);
}

/** Stretch a unit box (pivot at its centre, long axis Z) from a to b with the given thickness. */
export function setBeam(mesh: InstancedMesh, i: number, a: Vector3, b: Vector3, thickness: number) {
  _dir.subVectors(b, a);
  const len = _dir.length();
  if (len < 1e-6) {
    _m.makeScale(0, 0, 0);
    mesh.setMatrixAt(i, _m);
    return;
  }
  _dir.multiplyScalar(1 / len);
  _q.setFromUnitVectors(_zAxis, _dir);
  _p.addVectors(a, b).multiplyScalar(0.5);
  _s.set(thickness, thickness, len);
  _m.compose(_p, _q, _s);
  mesh.setMatrixAt(i, _m);
}

/** Hide an instance without changing the instance count. */
export function hideInstance(mesh: InstancedMesh, i: number) {
  _m.makeScale(0, 0, 0);
  mesh.setMatrixAt(i, _m);
}

/**
 * Upload only the first `used` items of a dynamic attribute instead of the whole buffer.
 * (Flames, smoke and particles allocate for the worst case but usually use a fraction.)
 */
export function uploadUsed(attr: BufferAttribute | null | undefined, used: number) {
  if (!attr || used <= 0) return; // nothing drawn: no upload (an empty range list would upload everything)
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, used * attr.itemSize);
  attr.needsUpdate = true;
}

/**
 * Per-instance opacity for an InstancedMesh (three only ships per-instance colour).
 * Adds an `instanceAlpha` attribute to the shader; the geometry must carry a matching
 * InstancedBufferAttribute, created with `addInstanceAlpha`.
 */
export function withInstanceAlpha<T extends Material>(mat: T): T {
  mat.transparent = true;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      "void main() {",
      "attribute float instanceAlpha;\nvarying float vInstanceAlpha;\nvoid main() {\n\tvInstanceAlpha = instanceAlpha;",
    );
    shader.fragmentShader = shader.fragmentShader
      .replace("void main() {", "varying float vInstanceAlpha;\nvoid main() {")
      .replace("#include <color_fragment>", "#include <color_fragment>\n\tdiffuseColor.a *= vInstanceAlpha;");
  };
  mat.customProgramCacheKey = () => "instanceAlpha";
  return mat;
}

export function addInstanceAlpha(mesh: InstancedMesh, capacity: number): InstancedBufferAttribute {
  const attr = new InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1);
  mesh.geometry.setAttribute("instanceAlpha", attr);
  return attr;
}

/** Dispose every geometry and material under an object (called when a run is replaced). */
export function disposeTree(root: { traverse: (cb: (o: any) => void) => void }) {
  root.traverse((o: any) => {
    o.geometry?.dispose?.();
    const m = o.material;
    if (Array.isArray(m)) m.forEach((x) => x.dispose?.());
    else m?.dispose?.();
  });
}
