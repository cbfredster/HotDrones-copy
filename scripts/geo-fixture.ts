// Synthetic unit-test inputs, deliberately not an observed place or an offline geographic demo.
import { validateGeoScenario, type GeoScenario } from "../src/sim/geography";

export function syntheticGeography(): GeoScenario {
  return validateGeoScenario({
    version: 1, w: 64, h: 64, centre: { lat: 45, lon: 6 }, sizeM: 4000,
    elevationM: Array.from({ length: 4096 }, (_, i) => 200 + (i % 64) * 2 + Math.floor(i / 64)),
    landCover: Array.from({ length: 4096 }, (_, i) => i % 64 < 3 ? 80 : i % 7 === 0 ? 30 : 10),
    ignition: [18 * 64 + 20], base: 55 * 64 + 8, target: 46 * 64 + 40,
    wind: { angle: Math.PI / 4, speed: 0.5 }, preburnTicks: 0,
    metadata: { label: "Synthetic persistence fixture", retrievedAt: "2026-11-15T00:00:00Z",
      elevation: "Synthetic planar slope, not provider data", landCover: "Synthetic WorldCover class pattern",
      attribution: ["HotDrones synthetic unit fixture; no geographic observations"] },
  });
}
