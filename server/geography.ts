// Network access is deliberately outside src/sim. Only these fixed providers are fetched.
import { GeoTIFF } from "geotiff";
import { defaultGeoScenario, geoBounds, gridToGeo, validateGeoArea, validateGeoScenario, type GeoScenario } from "../src/sim/geography";

export interface PlaceResult { label: string; lat: number; lon: number }
export interface GeographyRequest { lat: number; lon: number; sizeM: number; label?: string }
export class GeoProviderError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const DEM_GRID = 17;
const USER_AGENT = "HotDrones/0.1 (educational wildfire illustration)";
const WORLD_COVER = "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/";
const KNOWN_CLASSES = new Set([10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100]);
export const GEO_ATTRIBUTION = [
  "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium; CC BY 4.0; https://doi.org/10.5281/zenodo.7254221",
  "Elevation: Open-Meteo / Copernicus DEM GLO-90, 2021 release; https://open-meteo.com/en/docs/elevation-api; https://doi.org/10.5270/ESA-c5d3d65",
  "produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved",
  "Contains modified Copernicus data (2021). Resampled elevation and land cover; https://creativecommons.org/licenses/by/4.0/",
];

function aborted(signal?: AbortSignal) { signal?.throwIfAborted(); }
function combinedSignal(parent: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** Shared concurrency gate includes TIFF's internally parallel range requests. */
class Gate {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    aborted(signal);
    if (this.active >= this.limit) {
      if (this.waiters.length >= 20) throw new GeoProviderError(429, "Geographic provider queue is full; retry shortly.");
      await new Promise<void>((resolve, reject) => {
        const resume = () => { signal?.removeEventListener("abort", cancel); resolve(); };
        const cancel = () => { const i = this.waiters.indexOf(resume); if (i >= 0) this.waiters.splice(i, 1); reject(signal?.reason); };
        this.waiters.push(resume);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    } else this.active++;
    try { aborted(signal); return await fn(); }
    finally { const next = this.waiters.shift(); if (next) next(); else this.active--; }
  }
}

export function bilinearElevation(samples: readonly number[], sampleWidth = DEM_GRID): number[] {
  if (samples.length !== sampleWidth * sampleWidth || samples.some((v) => !Number.isFinite(v))) throw new GeoProviderError(502, "Elevation provider returned incomplete coverage; try another area.");
  const output: number[] = [];
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const sx = x * (sampleWidth - 1) / 63, sy = y * (sampleWidth - 1) / 63;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(sampleWidth - 1, x0 + 1), y1 = Math.min(sampleWidth - 1, y0 + 1);
    const fx = sx - x0, fy = sy - y0;
    const top = samples[y0 * sampleWidth + x0] * (1 - fx) + samples[y0 * sampleWidth + x1] * fx;
    const bottom = samples[y1 * sampleWidth + x0] * (1 - fx) + samples[y1 * sampleWidth + x1] * fx;
    output.push(Math.round((top * (1 - fy) + bottom * fy) * 100) / 100);
  }
  return output;
}

export function worldCoverTile(lat: number, lon: number) {
  const south = Math.floor(lat / 3) * 3, west = Math.floor(lon / 3) * 3;
  const name = `${south >= 0 ? "N" : "S"}${Math.abs(south).toString().padStart(2, "0")}${west >= 0 ? "E" : "W"}${Math.abs(west).toString().padStart(3, "0")}`;
  return { south, west, url: `${WORLD_COVER}ESA_WorldCover_10m_2021_v200_${name}_Map.tif` };
}

export interface ProviderOptions {
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  loadTimeoutMs?: number;
}

/** Factory keeps deterministic mocked tests independent of live providers and global caches. */
export function createGeographyProvider(options: ProviderOptions = {}) {
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const network = new Gate(4), loads = new Gate(2);
  const searchCache = new Map<string, { time: number; value: PlaceResult[] }>();
  const terrainCache = new Map<string, { time: number; value: GeoScenario }>();
  const calls: number[] = [];

  function throttle() {
    const t = now();
    while (calls.length && calls[0] <= t - 86_400_000) calls.shift();
    // Deliberately below free Open-Meteo limits, shared by all users of this process.
    if (calls.length >= 4500 || calls.filter((v) => v > t - 3_600_000).length >= 900 || calls.filter((v) => v > t - 60_000).length >= 90) {
      throw new GeoProviderError(429, "The application's geographic provider allowance is busy; retry later or use a bundled example.");
    }
    calls.push(t);
  }

  async function bytes(url: string, signal: AbortSignal | undefined, limit: number, headers: Record<string, string> = {}, range = false): Promise<ArrayBuffer> {
    return network.run(signal, async () => {
      aborted(signal);
      if (!range) throttle();
      const timed = combinedSignal(signal, options.requestTimeoutMs ?? 12_000);
      try {
        const response = await fetcher(url, { signal: timed, headers: { "User-Agent": USER_AGENT, ...headers }, redirect: "error" });
        if (response.status === 429) { await response.body?.cancel(); throw new GeoProviderError(429, "The data provider rate limit was reached; retry later or use a bundled example."); }
        if (!response.ok) { await response.body?.cancel(); throw new GeoProviderError(502, `Geographic provider returned HTTP ${response.status}; check coverage or retry.`); }
        if (range && response.status !== 206) { await response.body?.cancel(); throw new GeoProviderError(502, "Land-cover provider did not honour a range request; full raster downloads are disabled."); }
        if (range) {
          const expected = /^bytes=(\d+)-(\d+)$/.exec(headers.Range ?? "");
          const received = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(response.headers.get("content-range") ?? "");
          if (!expected || !received || expected[1] !== received[1] || expected[2] !== received[2]) { await response.body?.cancel(); throw new GeoProviderError(502, "Land-cover provider returned an invalid raster range."); }
        }
        if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new GeoProviderError(502, "Geographic provider response exceeds the safety limit."); }
        const reader = response.body?.getReader();
        if (!reader) throw new GeoProviderError(502, "Empty geographic provider response.");
        const chunks: Uint8Array[] = []; let length = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > limit) { await reader.cancel(); throw new GeoProviderError(502, "Geographic provider response exceeds the safety limit."); }
          chunks.push(part.value);
        }
        const result = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        return result.buffer;
      } catch (error) {
        aborted(signal);
        if (timed.aborted) throw new GeoProviderError(504, "Geographic data request timed out; retry or use a bundled example.");
        if (error instanceof GeoProviderError) throw error;
        throw new GeoProviderError(502, `Could not reach the geographic data provider: ${error instanceof Error ? error.message : String(error)}. Retry or use a bundled example.`);
      }
    });
  }

  async function json(url: string, signal?: AbortSignal): Promise<any> {
    try { return JSON.parse(new TextDecoder().decode(await bytes(url, signal, 100_000))); }
    catch (e) { if (e instanceof SyntaxError) throw new GeoProviderError(502, "Geographic provider returned invalid JSON."); throw e; }
  }

  async function searchPlaces(query: string, signal?: AbortSignal): Promise<PlaceResult[]> {
    aborted(signal);
    if (typeof query !== "string" || query.trim().length < 2 || query.length > 100) throw new GeoProviderError(400, "Enter a place name between 2 and 100 characters.");
    const key = query.trim().toLowerCase(), cached = searchCache.get(key);
    if (cached && now() - cached.time < 86_400_000) return structuredClone(cached.value);
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.search = new URLSearchParams({ name: query.trim(), count: "8", language: "en", format: "json" }).toString();
    const result = await json(url.href, signal);
    if (result.results !== undefined && !Array.isArray(result.results)) throw new GeoProviderError(502, "Place provider returned invalid results.");
    const value: PlaceResult[] = (result.results ?? []).slice(0, 8).filter((r: any) => typeof r.name === "string" && Number.isFinite(r.latitude) && Number.isFinite(r.longitude)).map((r: any) => ({
      label: [r.name, r.admin1, r.country].filter((s) => typeof s === "string").join(", ").slice(0, 200), lat: r.latitude, lon: r.longitude,
    }));
    aborted(signal); searchCache.set(key, { time: now(), value });
    while (searchCache.size > 64) searchCache.delete(searchCache.keys().next().value!);
    return structuredClone(value);
  }

  async function elevation(area: { centre: { lat: number; lon: number }; sizeM: number; w: 64; h: 64 }, signal: AbortSignal): Promise<number[]> {
    const points: { lat: number; lon: number }[] = [];
    for (let y = 0; y < DEM_GRID; y++) for (let x = 0; x < DEM_GRID; x++) points.push(gridToGeo(area, x * 63 / (DEM_GRID - 1), y * 63 / (DEM_GRID - 1)));
    const samples: number[] = [];
    for (let start = 0; start < points.length; start += 100) {
      const batch = points.slice(start, start + 100), url = new URL("https://api.open-meteo.com/v1/elevation");
      url.search = new URLSearchParams({ latitude: batch.map((p) => p.lat.toFixed(6)).join(","), longitude: batch.map((p) => p.lon.toFixed(6)).join(",") }).toString();
      const data = await json(url.href, signal);
      if (!Array.isArray(data.elevation) || data.elevation.length !== batch.length || data.elevation.some((v: unknown) => typeof v !== "number" || !Number.isFinite(v) || v < -500 || v > 9000)) throw new GeoProviderError(502, "Elevation provider returned incomplete or invalid coverage; choose another area or retry.");
      samples.push(...data.elevation);
    }
    return bilinearElevation(samples);
  }

  async function landCover(area: { centre: { lat: number; lon: number }; sizeM: number; w: 64; h: 64 }, signal: AbortSignal): Promise<number[]> {
    const groups = new Map<string, { i: number; lat: number; lon: number }[]>();
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const point = gridToGeo(area, x, y), url = worldCoverTile(point.lat, point.lon).url;
      const group = groups.get(url) ?? []; group.push({ i: y * 64 + x, ...point }); groups.set(url, group);
    }
    if (groups.size > 4) throw new GeoProviderError(400, "Footprint crosses too many source tiles; choose a smaller area.");
    let requestedBytes = 0, requests = 0;
    const result = new Array<number>(4096).fill(0);
    for (const [url, points] of groups) {
      const cache = new Map<string, ArrayBuffer>();
      const source = {
        fileSize: null,
        close: async () => {},
        async fetchSlice(slice: { offset: number; length: number }, sourceSignal?: AbortSignal) {
          const [data] = await this.fetch([slice], sourceSignal); return { ...slice, data };
        },
        async fetch(slices: { offset: number; length: number }[], _sourceSignal?: AbortSignal): Promise<ArrayBuffer[]> {
          const output: ArrayBuffer[] = [];
          // Serial within a source; the shared gate still bounds parallel parsing calls.
          for (const slice of slices) {
            aborted(signal);
            const key = `${slice.offset}:${slice.length}`;
            let data = cache.get(key);
            if (!data) {
              if (!Number.isSafeInteger(slice.offset) || slice.offset < 0 || !Number.isSafeInteger(slice.length) || slice.length < 1 || slice.length > 2_000_000 || ++requests > 160 || (requestedBytes += slice.length) > 16_000_000) throw new GeoProviderError(502, "Land-cover window exceeds the bounded processing budget; select a smaller area.");
              data = await bytes(url, signal, slice.length, { Range: `bytes=${slice.offset}-${slice.offset + slice.length - 1}` }, true);
              if (data.byteLength !== slice.length) throw new GeoProviderError(502, "Land-cover provider returned a truncated raster range.");
              cache.set(key, data);
            }
            output.push(data);
          }
          return output;
        },
      };
      const tiff = await GeoTIFF.fromSource(source, {}, signal);
      const image = await tiff.getImage(0); // full 10 m data, never averaged overviews for class IDs
      if (image.getSamplesPerPixel() !== 1 || image.getBytesPerPixel() !== 1 || image.getWidth() > 40_000 || image.getHeight() > 40_000 || image.getTileWidth() * image.getTileHeight() > 4_000_000) throw new GeoProviderError(502, "Unexpected WorldCover raster format or oversized decoding block.");
      const [originX, originY] = image.getOrigin(), [scaleX, scaleY] = image.getResolution();
      if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || scaleX <= 0 || scaleY >= 0) throw new GeoProviderError(502, "Invalid WorldCover raster transform.");
      const pixelPoints = points.map((p) => ({ ...p, x: Math.floor((p.lon - originX) / scaleX), y: Math.floor((p.lat - originY) / scaleY) }));
      const left = Math.min(...pixelPoints.map((p) => p.x)), top = Math.min(...pixelPoints.map((p) => p.y)), right = Math.max(...pixelPoints.map((p) => p.x)) + 1, bottom = Math.max(...pixelPoints.map((p) => p.y)) + 1;
      if (left < 0 || top < 0 || right > image.getWidth() || bottom > image.getHeight() || (right - left) * (bottom - top) > 4_000_000) throw new GeoProviderError(502, "Land-cover footprint exceeds raster coverage or processing budget.");
      const raster = await image.readRasters({ window: [left, top, right, bottom], samples: [0], interleave: true, signal });
      const values = raster as Uint8Array;
      for (const point of pixelPoints) {
        const value = values[(point.y - top) * (right - left) + point.x - left];
        if (!KNOWN_CLASSES.has(value)) throw new GeoProviderError(422, "WorldCover has missing land-cover coverage here; choose another terrestrial area. Missing data is never treated as forest or water.");
        result[point.i] = value;
      }
    }
    return result;
  }

  async function loadGeography(request: GeographyRequest, signal?: AbortSignal): Promise<GeoScenario> {
    aborted(signal);
    if (!request || typeof request !== "object") throw new GeoProviderError(400, "Provide latitude, longitude and area size.");
    const area = { centre: { lat: request.lat, lon: request.lon }, sizeM: request.sizeM, w: 64 as const, h: 64 as const };
    try { validateGeoArea(area); } catch (e) { throw new GeoProviderError(400, e instanceof Error ? e.message : "Invalid geographic footprint."); }
    const label = typeof request.label === "string" && request.label.trim() ? request.label.trim().slice(0, 160) : `${request.lat.toFixed(5)}, ${request.lon.toFixed(5)}`;
    const key = `${request.lat},${request.lon},${request.sizeM}`, cached = terrainCache.get(key);
    if (cached && now() - cached.time < 86_400_000) return validateGeoScenario({ ...cached.value, metadata: { ...cached.value.metadata, label } });
    const timed = combinedSignal(signal, options.loadTimeoutMs ?? 45_000);
    const pending = new AbortController();
    const workSignal = AbortSignal.any([timed, pending.signal]);
    try { return await loads.run(timed, async () => {
        const [elevationM, landCoverData] = await Promise.all([elevation(area, workSignal), landCover(area, workSignal)]);
        aborted(timed);
        const bounds = geoBounds(area);
        let value: GeoScenario;
        try { value = defaultGeoScenario({
          version: 1, ...area, elevationM, landCover: landCoverData,
          metadata: {
            label, retrievedAt: new Date(now()).toISOString(),
            elevation: "Copernicus DEM GLO-90 / Open-Meteo, 2021 release, 90 m source",
            landCover: "ESA WorldCover 2021 v200, 10 m source (historical)",
            attribution: GEO_ATTRIBUTION,
            details: `Elevation: 17×17 point lattice (${(area.sizeM * 63 / 64 / 16).toFixed(1)} m spacing), bilinear interpolation to cell centres; WorldCover: nearest full-resolution class at each cell centre; no missing-data infill. WGS84 bounds ${JSON.stringify(bounds)}. DEM heights above EGM2008 geoid; surface model, may include canopy/buildings. Main DEM acquisition 2011–2015, older gap fills possible. Hypothetical response assets.`,
          },
        }); } catch (e) { throw new GeoProviderError(422, e instanceof Error ? e.message : "No suitable combustible ground for the scenario; choose another area."); }
        terrainCache.set(key, { time: now(), value });
        while (terrainCache.size > 16) terrainCache.delete(terrainCache.keys().next().value!);
        return validateGeoScenario(value);
    }); } catch (e) {
      // A core failure cancels its sibling provider operation as well.
      pending.abort();
      aborted(signal);
      if (timed.aborted) throw new GeoProviderError(504, "Geographic load timed out; retry, choose a smaller footprint or use a bundled example.");
      if (e instanceof GeoProviderError) throw e;
      throw new GeoProviderError(502, `Could not read geographic terrain: ${e instanceof Error ? e.message : String(e)}. Retry or choose another area.`);
    }
  }
  return { searchPlaces, loadGeography };
}

const provider = createGeographyProvider();
export const searchPlaces = provider.searchPlaces;
export const loadGeography = provider.loadGeography;
