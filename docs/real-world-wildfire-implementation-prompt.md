# Implementation prompt: simulate wildfire at a real location

Paste the text below into a new Codex Astra conversation with Ultra reasoning and this repository open.

---

Implement real-world location selection and location-based wildfire simulation in **HotDrones**. Work through implementation, integration and verification; a proposal or scaffold alone is insufficient.

## Objective

A user should be able to search for a real place or enter latitude/longitude, choose a manageable area around it, load its actual terrain and land cover, place an ignition, and watch the existing wildfire and firefighting-drone simulation operate there.

The selected location must materially determine the terrain, vegetation/fuel and water distribution. Renaming a procedural map, seeding random terrain from coordinates, or displaying a geographic basemap behind an unrelated simulation does not meet the objective.

Deliver a complete, practical first version using the existing app. This remains an illustrative wildfire simulation, not a calibrated operational forecast. Preserve the existing procedural mode.

## Start with repository inspection

1. Read `AGENTS.md` and `.entire/agent-guide.md`, and follow their current workflow. Use Brain and Graph as instructed. If a command is unavailable, disclose that and use the guide's direct-inspection fallback for that query; do not install or repair those tools automatically.
2. Check `git status --short` before editing. Preserve all existing uncommitted work, including integration/audio changes. Inspect current source rather than assuming this prompt describes the latest revision.
3. Read `README.md`, `DECISIONS.md`, and relevant source. Establish baseline checks and distinguish existing failures from regressions.
4. Briefly state the implementation plan and selected data sources, then proceed. Resolve routine implementation choices yourself. Ask only for information or authorization that is essential and unavailable from the repository.

The inspected architecture provides useful starting points; verify these relationships yourself:

- Strict TypeScript, Vite, Three.js, and a Node HTTP/WebSocket server; vanilla DOM UI, no existing React application.
- `src/main.ts`: controls, `startRun`, new-run/reset and replay wiring, renderer/minimap lifecycle, integration hooks.
- `src/sim/config.ts`: defaults, currently a 64×64 grid, and `legacyConfig` for exact historical reproduction.
- `src/sim/terrain.ts`: procedural generation and `Terrain`, with `Float32Array` heights, `Uint8Array` tile types, a protected `village` and `base`.
- `src/sim/world.ts`: constructs terrain synchronously, initializes environment, seeds fires, preburns, then initializes drones. Fire/wind and agents have separate RNG streams; procedural generation currently consumes the fire RNG before environment initialization.
- `src/sim/environment.ts`: wind, fuel, slope, fire, smoke and ignitions. Wind angles describe the direction the wind blows **towards**. Default ignition placement assumes a protected village.
- `src/sim/judge.ts`: validated, recorded runtime actions and replay.
- `src/render/iso/` and `src/render/renderer.ts`: Three.js view and minimap. Simulation x → Three.js X, simulation y → Three.js Z, simulation height → Three.js Y multiplied by `V_SCALE` in `src/render/iso/util.ts`. Renderers must never consume simulation RNGs.
- `src/integrations/scenarios.ts`, `src/integrations/index.ts`, `server/store.ts`, `server/challenge.ts`, `server/index.ts`: scenario save/load, headless comparisons and APIs. Scenarios currently rely on config + seed + judge actions. Server config sanitization fixes map dimensions and will not automatically support a new geographic payload. The challenge board currently evaluates swarm, central and greedy, although the simulator also supports CBBA and unified modes.
- `BASIC/` is a frozen baseline. Preserve it and its results.

## Required user experience

- Add a clear choice between **Procedural** and **Real location**, styled consistently with the current interface.
- Support place-name search with disambiguated results and explicit coordinate entry. Do not require browser geolocation. Show the chosen centre and area footprint in a useful preview; an interactive map is preferred if it fits the app cleanly.
- Offer bounded physical area sizes. Keep 64×64 as the initial simulation resolution unless inspection justifies a change. A user chooses a local area, not an entire country at full resolution.
- Provide loading stages, cancel/retry, actionable failures and visible source/coverage information. A failed or cancelled load must leave the current scenario usable. Prevent stale responses from an earlier selection from replacing a newer selection.
- Before starting, allow placement of ignition on valid combustible ground and valid placement of the drone base and protected target. Supply deterministic defaults where sensible, and explain placements that represent hypothetical response assets.
- Start the selected ignition at a clearly defined initialization stage. Do not silently add the existing random ignitions as well. Make any preburn behaviour explicit and reproducible.
- Keep play/pause/step, wind controls, drone settings, coordination modes, judge tools, selection, fog, minimap and end-card replay working. New run, changing coordination mode and replay must retain the selected geographic scenario until the user changes it.
- Display location, north/orientation, physical extent or scale, and relevant data dates. Where tile area is known, show burnt area in hectares alongside existing tile metrics. Do not relabel simulation ticks as real elapsed seconds without a defensible time model.

## Geographic data: implement a genuine working path

Choose and implement accessible sources for geocoding, elevation and land cover. Prefer a path that runs without paid credentials and without introducing a separate GIS service. Add only justified dependencies. Keep provider access replaceable, but avoid building an elaborate plugin framework.

Research current primary documentation before selecting endpoints, libraries and usage limits. Useful candidates, not mandatory choices:

- Open-Meteo geocoding: https://open-meteo.com/en/docs/geocoding-api
- Open-Meteo elevation: https://open-meteo.com/en/docs/elevation-api
- ESA WorldCover land cover and public Cloud Optimized GeoTIFF access: https://esa-worldcover.org/en/data-access
- OpenStreetMap/Overpass for supplementary mapped features where useful: https://dev.overpass-api.de/overpass-doc/en/
- If selecting public Nominatim, read and implement its policy, including application-wide throttling, identification, caching and the prohibition on autocomplete: https://operations.osmfoundation.org/policies/nominatim/

Required properties:

- Load actual elevation and actual land-cover data for arbitrary supported terrestrial coordinates, rather than only hardcoded demo locations. Explain the supported coverage. Presets may supplement coordinate selection.
- Bound area, point counts, requests, concurrency, response size and processing cost. Use batching or raster windows/range requests where appropriate, rather than thousands of individual requests or entire large raster downloads per scenario. Never download a global dataset as part of normal setup.
- Fetch and normalize data before constructing the simulation. Geographic network access must never occur inside a tick. Use the existing same-origin server for provider access where appropriate, with timeouts, cancellation, caching, clear error states and server-side credentials if needed. Do not expose an unrestricted URL proxy.
- Respect source licensing, attribution and redistribution requirements, including any data included in fixtures or exported scenarios. Record dataset/version, source resolution, acquisition or retrieval date, and any interpolation or missing-data treatment. Historical land cover must not be presented as a live observation.
- Map source classes explicitly to model fuel classes. Do not equate every unmapped area with forest or treat missing coverage as water. Built-up areas, crops, shrubland, wetlands, snow and bare ground need documented approximations or limited model extensions. Keep such extensions scoped and preserve legacy behaviour.
- Preserve real coastlines, water and terrain structure as far as grid resolution permits. If using OSM geometry, handle polygon holes, multipolygons and clipping with an appropriate library. Sparse OSM features alone do not establish complete land-cover classification.
- Handle missing elevation, coastal cells, no combustible land, no natural refill water and no nearby settlement. Do not carve fictional lakes or a village into imported geography. A hypothetical base, protected target or refill station may be represented separately and clearly labelled; otherwise provide a clear unsupported-scenario message.
- Core geographic data failure must not silently become a procedural map labelled as the selected location. Keep procedural mode available and provide a genuinely sourced bundled example for an offline demo if redistribution permits. Never invent provenance for fixtures.

Live weather is optional after the core path works. Manual wind is sufficient for this version. If weather import is added, snapshot it for replay, show its timestamp and source, and correctly convert meteorological wind-from bearings into simulation wind-towards angles. Do not add temperature/humidity controls that have no effect on the model.

## Coordinate and simulation contracts

- Define one explicit geographic-to-grid transform and its inverse, including cell centres, bounds, axis orientation, metres per cell, elevation datum/offset and supported latitude/longitude range. Handle or clearly reject antimeridian and polar cases.
- Sample elevation with a suitable continuous interpolation method and categorical land cover with a suitable categorical method. Validate finite values, array sizes, class IDs and coverage.
- The model uses tiles as horizontal units. Convert elevation metres into compatible simulation units, preserving physical slopes. Retain original elevations/offsets for inspection where useful. Do not normalize each location independently into arbitrary hills or feed raw elevation metres into tile-based height calculations.
- Keep any visual height exaggeration separate from physical simulation values and consistent across terrain, drones and radio links. Audit slope, radio line of sight, altitude, climb cost and camera bounds.
- Explain how changes in metres per cell affect the existing tile-based spread, travel, sensing and radio parameters. Use a coherent documented approximation and do not claim physical calibration that has not been implemented.
- Load a validated, immutable initial geographic scenario through a clean extension to world creation. Keep `src/sim` usable synchronously in Node and the browser, without DOM, network or renderer imports.
- Avoid shared mutable terrain buffers between runs. Preserve the existing procedural RNG sequence exactly, including terrain generation draws. New geographic setup should have explicit deterministic RNG ownership independent of UI/render timing.
- Audit the existing assumptions around protected targets, including `village[4]`, ignition placement, planner threat scores, structures and tower placement. Retain valid invariants or adapt consumers coherently; do not introduce undefined coordinates for locations without a settlement.
- Keep runtime interventions on the existing recorded judge-action path. Initial setup belongs in the initial scenario snapshot.

## Deterministic persistence and integration

Geographic scenarios must replay from the **exact initial inputs**, without re-fetching providers. Coordinates plus a seed are insufficient.

Introduce a bounded, versioned, serializable geographic scenario representation. Persist the normalized initial terrain/fuel, geographic metadata, asset placements, initial ignition/wind inputs and other required initial state, either inline or through a durable immutable snapshot stored with the scenario. Use a stable content hash if helpful. A short-lived provider cache is not durable replay storage. Restore typed arrays explicitly and validate deserialized data.

Thread this representation through browser new-run/reset/mode-change, end-card replay, scenario save/share/load, both file and Mongo persistence, and server headless challenge execution. All modes compared on the challenge board must receive the same initial snapshot. Keep all existing simulator coordination modes usable with geographic terrain; expanding the board's mode set is not required.

Maintain compatibility with existing procedural scenarios, existing public APIs where practical, optional integrations and the no-keys demo. Add proper server validation and resource limits for the geographic payload rather than trusting client-supplied arrays, dimensions or references. Preserve integration run/reset hooks, including audio and telemetry lifecycle behaviour.

## Verification and completion criteria

Add focused tests using the repository's existing style, introducing a small dedicated test command if needed. Automated tests must be deterministic and independent of live provider availability.

Cover:

1. Geographic/grid coordinate round trips, axis orientation, boundary cells and supported-range validation.
2. Elevation scaling and slope direction; categorical land-cover mapping and missing-data behaviour.
3. Valid and invalid ignition/base/target placements, and handling of no-water/noncombustible areas.
4. Identical initial inputs + seed + judge log produce identical terrain, fire state and final metrics; replay and mode changes do not mutate or discard the snapshot.
5. Save/load and server challenge runs retain the geographic snapshot, work without provider access during replay, and reject oversized or malformed payloads. Existing procedural scenario documents still load.
6. Provider timeouts, rate-limit failures, partial results, cancellation and stale-response ordering, using mocked responses.

Demonstrate two geographically distinct real areas with contrasting terrain or cover. Distinguish synthetic unit fixtures from genuinely sourced examples. If network access permits, exercise at least one uncached end-to-end location load and record the result; if blocked, report the precise limit and validate against documented fixtures without claiming live success.

Run the relevant checks, including:

```bash
npm run typecheck
npm run build
npm run test:integrations
npm run experiment:legacy-check
```

Run new geographic tests and any other existing checks affected by your changes. Inspect the browser flow with available browser tooling, including loading, cancelling, ignition, play/step, mode switching and replay. If a check or browser tool is unavailable, disclose that explicitly. Do not update frozen expected results to make regressions pass.

Update README/setup documentation and record durable architectural decisions in the repository's established format. Include provider setup, attribution, supported coverage, resolution/unit assumptions, offline demo behaviour and known model limits.

Finish with a concise account of what works, how to use it, files changed, checks actually executed, and any material limitations. Complete the authorized implementation without stopping for routine approval. Do not commit, push or deploy unless separately requested.
