// Synthetic GeoTIFF and mocked HTTP only: no live-provider availability required.
import assert from "node:assert/strict";
import { writeArrayBuffer } from "geotiff";
import { bilinearElevation, createGeographyProvider, GeoProviderError, worldCoverTile } from "../server/geography";

const request = { lat: 56.05, lon: -4.6, sizeM: 4000, label: "Synthetic provider test" };
const width = 256;
function fixture(cover = 10) {
  return writeArrayBuffer(new Uint8Array(width * width).fill(cover), {
    width, height: width, SamplesPerPixel: 1, BitsPerSample: [8], SampleFormat: [1],
    ModelPixelScale: [3 / width, 3 / width, 0], ModelTiepoint: [0, 0, 0, -6, 57, 0],
    GeographicTypeGeoKey: 4326, GTModelTypeGeoKey: 2, GTRasterTypeGeoKey: 1,
  });
}
const tiff = fixture();
let calls = 0, elevations = 0, ranges = 0;
const mockFetch: typeof fetch = async (input, init) => {
  calls++;
  const url = new URL(String(input));
  if (url.hostname === "geocoding-api.open-meteo.com") return Response.json({ results: [{ name: "Test", admin1: "Region", country: "Country", latitude: 56.05, longitude: -4.6 }] });
  if (url.pathname === "/v1/elevation") {
    elevations++;
    const lat = url.searchParams.get("latitude")!.split(",").map(Number), lon = url.searchParams.get("longitude")!.split(",").map(Number);
    assert(lat.length <= 100);
    return Response.json({ elevation: lat.map((n, i) => 10 * n + lon[i]) });
  }
  assert.equal(url.hostname, "esa-worldcover.s3.eu-central-1.amazonaws.com");
  ranges++;
  const header = new Headers(init?.headers).get("range")!;
  const [, first, last] = /^bytes=(\d+)-(\d+)$/.exec(header)!;
  const start = Number(first), end = Number(last);
  return new Response(tiff.slice(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${tiff.byteLength}` } });
};

assert.equal(worldCoverTile(-1, -1).url, "https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_S03W003_Map.tif");
assert.equal(bilinearElevation([0, 63, 63, 126], 2)[63 * 64 + 63], 126);
assert.equal(bilinearElevation([0, 63, 63, 126], 2)[20 * 64 + 10], 30);
assert.throws(() => bilinearElevation([0, NaN, 2, 3], 2), /incomplete coverage/);
const provider = createGeographyProvider({ fetch: mockFetch });
assert.deepEqual(await provider.searchPlaces("Test"), [{ label: "Test, Region, Country", lat: 56.05, lon: -4.6 }]);
const searched = calls;
await provider.searchPlaces("TEST"); assert.equal(calls, searched, "search cache is application wide per provider");
const snapshot = await provider.loadGeography(request);
assert.equal(snapshot.elevationM.length, 4096); assert.equal(snapshot.landCover.length, 4096);
assert(snapshot.landCover.every((v) => v === 10));
assert.equal(elevations, 3); assert(ranges > 0 && ranges < 160);
assert(snapshot.elevationM[0] > snapshot.elevationM[63 * 64], "north is first row");
assert(snapshot.elevationM[63] > snapshot.elevationM[0], "east is right");
const cachedCalls = calls;
const cached = await provider.loadGeography({ ...request, label: "Different label" });
assert.equal(calls, cachedCalls); assert.equal(cached.metadata.label, "Different label");
assert.notEqual(cached.elevationM, snapshot.elevationM, "callers own independent immutable snapshots");
assert.deepEqual(cached.elevationM, snapshot.elevationM);

await assert.rejects(() => provider.loadGeography({ ...request, lat: 89 }), /latitude|coverage/);
await assert.rejects(() => provider.searchPlaces("x"), /2 and 100/);
const cancelled = new AbortController(); cancelled.abort();
await assert.rejects(() => provider.loadGeography(request, cancelled.signal), { name: "AbortError" });
await assert.rejects(() => provider.searchPlaces("Test", cancelled.signal), { name: "AbortError" });

const rateLimited = createGeographyProvider({ fetch: async () => new Response("", { status: 429 }) });
await assert.rejects(() => rateLimited.searchPlaces("Test"), (e: unknown) => e instanceof GeoProviderError && e.status === 429);
const partial = createGeographyProvider({ fetch: async (input, init) => new URL(String(input)).pathname === "/v1/elevation" ? Response.json({ elevation: [null] }) : mockFetch(input, init) });
await assert.rejects(() => partial.loadGeography(request), /incomplete or invalid coverage/);
const malformed = createGeographyProvider({ fetch: async () => new Response("not json") });
await assert.rejects(() => malformed.searchPlaces("Test"), /invalid JSON/);
const oversized = createGeographyProvider({ fetch: async () => new Response("", { headers: { "content-length": "999999999" } }) });
await assert.rejects(() => oversized.searchPlaces("Test"), /safety limit/);
const fullFile = createGeographyProvider({ fetch: async (input, init) => String(input).endsWith(".tif") ? new Response(tiff) : mockFetch(input, init) });
await assert.rejects(() => fullFile.loadGeography(request), /range request/);
const missingData = fixture(0);
const missing = createGeographyProvider({ fetch: async (input, init) => {
  if (!String(input).endsWith(".tif")) return mockFetch(input, init);
  const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get("range")!)!;
  return new Response(missingData.slice(Number(a), Number(b) + 1), { status: 206, headers: { "content-range": `bytes ${a}-${b}/${missingData.byteLength}` } });
} });
await assert.rejects(() => missing.loadGeography(request), /missing land-cover coverage/);

const hanging: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
});
const slow = createGeographyProvider({ fetch: hanging, requestTimeoutMs: 10 });
// Keep a referenced timer while AbortSignal.timeout uses its unref'd internal timer.
const keepAlive = setTimeout(() => {}, 1000);
await assert.rejects(() => slow.searchPlaces("Test"), (e: unknown) => e instanceof GeoProviderError && e.status === 504);
clearTimeout(keepAlive);
const abort = new AbortController();
const pending = createGeographyProvider({ fetch: hanging }).loadGeography(request, abort.signal);
abort.abort();
await assert.rejects(() => pending, { name: "AbortError" });
let active = 0, maximumActive = 0;
const concurrent = createGeographyProvider({ fetch: async (input, init) => {
  maximumActive = Math.max(maximumActive, ++active);
  try { await new Promise((resolve) => setTimeout(resolve, 1)); return await mockFetch(input, init); }
  finally { active--; }
} });
await Promise.all([0, 0.001, 0.002].map((offset) => concurrent.loadGeography({ ...request, lat: request.lat + offset })));
assert(maximumActive <= 4, "TIFF internals and DEM batches share a bounded network gate");
assert(maximumActive > 1, "independent providers can load concurrently");
console.log("Geographic providers: bounded mocked DEM + real GeoTIFF decoding, cache, timeout, rate-limit, cancellation, partial, malformed, missing and oversized responses passed.");
