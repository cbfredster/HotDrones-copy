import { FUEL, Terrain, Tile } from "./terrain";

/** Versioned, self-contained initial inputs. Never fetch providers while replaying. */
export interface GeoScenario {
  readonly version: 1;
  readonly w: 64;
  readonly h: 64;
  readonly centre: { readonly lat: number; readonly lon: number };
  readonly sizeM: number;
  readonly elevationM: readonly number[];
  readonly landCover: readonly number[];
  readonly ignition: readonly number[];
  readonly base: number;
  readonly target: number;
  readonly wind: { readonly angle: number; readonly speed: number };
  readonly preburnTicks: number;
  readonly metadata: {
    readonly label: string;
    readonly retrievedAt: string;
    readonly elevation: string;
    readonly landCover: string;
    readonly attribution: readonly string[];
    readonly details?: string;
  };
}

export type GeoArea = Pick<GeoScenario, "centre" | "sizeM" | "w" | "h">;
const EARTH_R = 6_371_008.8;
const DEG = Math.PI / 180;
export const GEO_SIZES = [2000, 4000, 8000] as const;
export const GEO_CELLS = 64 * 64;

/** Local equirectangular metres, east/right and south/down. Centres are integer grid coordinates. */
export function gridToGeo(area: GeoArea, x: number, y: number) {
  const eastM = ((x + 0.5) / area.w - 0.5) * area.sizeM;
  const northM = (0.5 - (y + 0.5) / area.h) * area.sizeM;
  return {
    lat: area.centre.lat + northM / (EARTH_R * DEG),
    lon: area.centre.lon + eastM / (EARTH_R * DEG * Math.cos(area.centre.lat * DEG)),
  };
}

/** Inverse of gridToGeo; bounds edges are -0.5 and 63.5, not cell centres. */
export function geoToGrid(area: GeoArea, lat: number, lon: number) {
  const northM = (lat - area.centre.lat) * EARTH_R * DEG;
  const eastM = (lon - area.centre.lon) * EARTH_R * DEG * Math.cos(area.centre.lat * DEG);
  return {
    x: (eastM / area.sizeM + 0.5) * area.w - 0.5,
    y: (0.5 - northM / area.sizeM) * area.h - 0.5,
  };
}

export function geoBounds(area: GeoArea) {
  const nw = gridToGeo(area, -0.5, -0.5);
  const se = gridToGeo(area, area.w - 0.5, area.h - 0.5);
  return { west: nw.lon, east: se.lon, north: nw.lat, south: se.lat };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function num(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

function text(value: unknown, max: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function validateGeoArea(value: unknown): GeoArea {
  const s = record(value, "Geographic area");
  const centre = record(s.centre, "Centre");
  const lat = num(centre.lat, -60, 75, "latitude (supported -60 to 75 degrees)");
  const lon = num(centre.lon, -180, 180, "longitude");
  if (s.w !== 64 || s.h !== 64) throw new Error("Geographic grid must be 64 × 64");
  const sizeM = num(s.sizeM, 2000, 8000, "area size");
  if (!(GEO_SIZES as readonly number[]).includes(sizeM)) throw new Error("Choose a 2, 4 or 8 km area");
  const area: GeoArea = { centre: { lat, lon }, sizeM, w: 64, h: 64 };
  const b = geoBounds(area);
  if (b.west < -180 || b.east > 180) throw new Error("Areas crossing the antimeridian are unsupported");
  if (b.south < -60 || b.north > 75) throw new Error("Area exceeds supported latitude coverage (-60 to 75 degrees)");
  return area;
}

/** Explicit WorldCover 2021 v200 class approximations using existing model fuels. */
export function landCoverToTile(value: number): Tile {
  switch (value) {
    case 10: case 95: return Tile.Forest; // tree cover and mangroves
    case 20: case 30: case 40: case 90: case 100: return Tile.Grass; // shrubs, grass, crops, herbaceous wetland, moss/lichen
    case 50: case 60: return Tile.Rock; // built-up and bare/sparse: no structural fire model
    case 70: return Tile.Sand; // snow/ice: inert, never refill water
    case 80: return Tile.Water; // permanent water only
    default: throw new Error(`Missing or unsupported WorldCover class ${value}; choose another area or retry`);
  }
}

function tileIndex(value: unknown, name: string): number {
  const n = num(value, 0, GEO_CELLS - 1, name);
  if (!Number.isInteger(n)) throw new Error(`Invalid ${name} cell`);
  return n;
}

export function validGeoPlacement(s: Pick<GeoScenario, "landCover" | "w" | "h">, index: number, kind: "ignition" | "base" | "target") {
  if (!Number.isInteger(index) || index < 0 || index >= s.w * s.h) return false;
  const tile = landCoverToTile(s.landCover[index]);
  if (kind === "base") {
    const x = index % s.w;
    const y = Math.floor(index / s.w);
    return tile !== Tile.Water && x >= 2 && y >= 2 && x < s.w - 2 && y < s.h - 2;
  }
  return FUEL[tile].ignite > 0;
}

/** Validate untrusted JSON, discard unknown keys, copy every buffer, and freeze the entire snapshot. */
export function validateGeoScenario(value: unknown): GeoScenario {
  const s = record(value, "Geographic scenario");
  const area = validateGeoArea(s);
  if (s.version !== 1) throw new Error("Unsupported geographic snapshot version");
  if (!Array.isArray(s.elevationM) || s.elevationM.length !== GEO_CELLS || !Array.isArray(s.landCover) || s.landCover.length !== GEO_CELLS) {
    throw new Error("Geographic elevation and land-cover arrays must contain 4096 cells");
  }
  const elevationM = s.elevationM.map((n) => num(n, -500, 9000, "elevation"));
  const landCover = s.landCover.map((n) => { const v = num(n, 10, 100, "land-cover class"); landCoverToTile(v); return v; });
  if (!Array.isArray(s.ignition) || s.ignition.length < 1 || s.ignition.length > 16) throw new Error("Choose between one and sixteen initial ignitions");
  const ignition = s.ignition.map((n) => tileIndex(n, "ignition"));
  if (new Set(ignition).size !== ignition.length) throw new Error("Initial ignition cells must be unique");
  const base = tileIndex(s.base, "base");
  const target = tileIndex(s.target, "protected target");
  const placements = { ...area, landCover };
  if (!validGeoPlacement(placements, base, "base")) throw new Error("Base must be on dry ground at least two cells from the edge");
  if (!validGeoPlacement(placements, target, "target")) throw new Error("Protected target must be on combustible ground");
  if (ignition.some((i) => !validGeoPlacement(placements, i, "ignition"))) throw new Error("Ignition must be on combustible ground");
  if (base === target || ignition.includes(base) || ignition.includes(target)) throw new Error("Base, target and ignitions must occupy distinct cells");
  const wind = record(s.wind, "Initial wind");
  const angle = num(wind.angle, -Math.PI * 100, Math.PI * 100, "wind angle");
  const speed = num(wind.speed, 0, 1, "wind speed");
  const preburnTicks = num(s.preburnTicks, 0, 120, "preburn ticks");
  if (!Number.isInteger(preburnTicks)) throw new Error("Preburn ticks must be an integer");
  const meta = record(s.metadata, "Source metadata");
  const retrievedAt = text(meta.retrievedAt, 40, "retrieval date");
  if (!Number.isFinite(Date.parse(retrievedAt))) throw new Error("Invalid retrieval date");
  if (!Array.isArray(meta.attribution) || meta.attribution.length < 1 || meta.attribution.length > 8) throw new Error("Source attribution required");
  const metadata: GeoScenario["metadata"] = {
    label: text(meta.label, 160, "location label"), retrievedAt,
    elevation: text(meta.elevation, 500, "elevation source"), landCover: text(meta.landCover, 500, "land-cover source"),
    attribution: Object.freeze(meta.attribution.map((n) => text(n, 600, "attribution"))),
    ...(meta.details === undefined ? {} : { details: text(meta.details, 2000, "source details") }),
  };
  return Object.freeze({ version: 1, ...area, centre: Object.freeze(area.centre), elevationM: Object.freeze(elevationM),
    landCover: Object.freeze(landCover), ignition: Object.freeze(ignition), base, target, wind: Object.freeze({ angle, speed }),
    preburnTicks, metadata: Object.freeze(metadata) });
}

/** Deterministic placements; no settlement, lake, or new fuel is inserted into the geography. */
export function defaultGeoScenario(s: Omit<GeoScenario, "ignition" | "base" | "target" | "wind" | "preburnTicks">): GeoScenario {
  const used = new Set<number>();
  const nearest = (x: number, y: number, kind: "ignition" | "base" | "target") => {
    let best = -1;
    let distance = Infinity;
    for (let i = 0; i < GEO_CELLS; i++) {
      if (used.has(i) || !validGeoPlacement(s, i, kind)) continue;
      const d = Math.hypot(i % s.w - x, Math.floor(i / s.w) - y);
      if (d < distance) { best = i; distance = d; }
    }
    if (best < 0) throw new Error(`No suitable ${kind} ground in this area; choose a larger or different area`);
    used.add(best);
    return best;
  };
  const base = nearest(8, 55, "base");
  const target = nearest(40, 46, "target");
  const ignition = [nearest(20, 18, "ignition")];
  return validateGeoScenario({ ...s, base, target, ignition, wind: { angle: Math.PI / 4, speed: 0.5 }, preburnTicks: 0 });
}

/** Heights are in horizontal tile units, preserving physical gradients without location-specific normalisation. */
export function createTerrainFromGeo(s: GeoScenario): Terrain {
  const offset = Math.min(...s.elevationM);
  const cellM = s.sizeM / s.w;
  return { w: s.w, h: s.h,
    height: Float32Array.from(s.elevationM, (z) => (z - offset) / cellM),
    type: Uint8Array.from(s.landCover, landCoverToTile),
    village: [s.target], base: { x: s.base % s.w, y: Math.floor(s.base / s.w) },
    metresPerCell: cellM, elevationOffsetM: offset };
}

export function burntHectares(s: GeoScenario, tiles: number): number {
  return tiles * (s.sizeM / s.w) ** 2 / 10000;
}
