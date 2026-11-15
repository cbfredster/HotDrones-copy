# Real-location wildfire scenarios

Run `npm install && npm run dev`, select **Terrain → Real location**, search a place and choose a disambiguated result, or enter latitude/longitude directly. Choose a 2, 4 or 8 km square and press **Load / retry area**. No geolocation permission or paid credentials are needed. The footprint link opens OpenStreetMap; the in-app preview is the actual classified terrain, north up.

Select **I Ignition**, **B Base** or **T Target** and click the preview to move the corresponding marker. Ignition and target must occupy combustible cells; the base must be dry and at least two cells from an edge. Placements cannot overlap. The target is a hypothetical vulnerable response asset, not a detected settlement. Base, target and relay towers are hypothetical assets and do not change the imported terrain. With no natural permanent-water cells, the base supplies water through an explicitly hypothetical refill station. An area without suitable combustible ground is rejected.

Set the initial wind (direction **towards**, 0° east, 90° south) and preburn, then **Apply location**. This replaces the world and pauses at tick 0. The ignition starts before the selected preburn, with no additional random ignitions. Preburn steps the environment before drones are initialized. With 0 preburn the ignition is visible immediately. Play, Step, judge controls and all five coordination modes work as before. New run, mode changes and end-card Replay retain the snapshot; changing the source to Procedural explicitly releases it. Runtime interventions still use recorded judge actions.

Search/load requests are cancellable, have timeouts and ignore superseded responses. Loading, failure and cancellation leave the existing world usable until Apply. Choose a bundled example to work offline, or retry after a provider failure. A data failure never produces a procedural map carrying the chosen location's name.

## Data and coverage

| Input | Fixed source | Treatment |
| --- | --- | --- |
| Place names | [Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api), GeoNames | Explicit Search button, at most eight results, administrative region/country labels; coordinate entry also works. |
| Elevation | [Open-Meteo elevation](https://open-meteo.com/en/docs/elevation-api), Copernicus DEM GLO-90, 2021 release, 90 m source | 17×17 lattice spanning simulation cell centres, batches of at most 100 points, bilinear interpolation to 64×64. Original sampled/interpolated metres are stored. Surface heights above EGM2008 geoid can include buildings/canopy. |
| Land cover | [ESA WorldCover 2021 v200](https://esa-worldcover.org/en/data-access), 10 m source | Public AWS Cloud Optimized GeoTIFF byte ranges, bounded windows from full-resolution class raster; nearest source pixel at each simulation cell centre, no averaged categorical overviews. |

The first version supports footprints wholly within 60°S–75°N and ±180° longitude, excluding antimeridian crossings. Actual dataset availability and usable fuel can further restrict locations. Polar areas are deliberately rejected. Missing/invalid elevation, invalid classes, nodata and incomplete coverage fail explicitly; missing data is never inferred as forest or water. Source water cells retain DEM elevations (no synthetic flattening or shoreline carving). Fine shorelines, narrow streams and small settlements can be lost at cell-centre sampling resolution. This is a historical land-cover snapshot, not current vegetation, moisture, live weather or a live fire observation.

WorldCover is reduced to the existing model without extending procedural fuels:

| WorldCover ID | Source class | Model approximation |
| --- | --- | --- |
| 10, 95 | Tree cover, mangroves | Forest |
| 20, 30, 40 | Shrubland, grassland, cropland | Grass |
| 90, 100 | Herbaceous wetland, moss/lichen | Grass (wetness is not inferred) |
| 50, 60 | Built-up, bare/sparse vegetation | Inert rock; no structural fire model |
| 70 | Snow/ice | Inert sand palette; never a refill source |
| 80 | Permanent water | Water/refill source |
| 0 or unknown | Missing/unsupported | Reject scenario |

These are deliberately coarse fuel approximations. A protected target is placed on combustible ground because the existing model detects target loss when its cell burns; this does not simulate fire entering a real building.

## Coordinates and units

The square uses a local equirectangular transform with spherical radius 6,371,008.8 m and longitude scaled by cosine of centre latitude. Simulation x increases east and y south. Cell centres are integer coordinates 0…63; footprint edges are −0.5 and 63.5. `gridToGeo`, `geoToGrid` and `geoBounds` in `src/sim/geography.ts` define the transform and inverse. This small-area approximation is used consistently for physical extent, elevation sampling and hectare metrics; it is not survey-grade geodesy.

Metres per cell = area width / 64: 31.25, 62.5 or 125 m. Simulation height = (elevation metres − minimum elevation metres) / metres per cell. The snapshot retains absolute heights; terrain retains the offset. Height differences therefore preserve physical slopes. Geographic diagonal fire spread divides height difference by √2. Procedural behavior is unchanged. The existing renderer applies `V_SCALE=0.4` to terrain, drones and communication endpoints, a common visual compression separate from simulation height. Camera fitting uses the actual maximum scaled terrain height.

Travel speed, sensor radius, radio range, drone altitude, ember distance and fire spread remain tile-based heuristics. Choosing a larger footprint increases their effective distances in metres. Climb/descent cost uses compatible tile-height differences. Tick duration has no calibrated physical time model: ticks and playback ticks/s remain simulation units. Burnt hectares = burnt cell count × metres-per-cell² / 10,000, counting a cell once even with regrowth. The existing `villageLost` API metric represents the hypothetical protected target for geographic scenarios. This version is an illustrative comparison of coordination algorithms, not an operational forecast, aviation planner or physically calibrated spread model.

## Server, replay and limits

`server/geography.ts` contains replaceable provider access. Same-origin `/api/geography/search?q=…` and `/api/geography/load?lat=…&lon=…&sizeM=…` endpoints access fixed providers only; there is no URL proxy. `geotiff` is the only added runtime dependency, decoding windowed COGs rather than downloading full rasters. Network work finishes before synchronous `World` construction and never occurs inside a tick.

Limits include two concurrent loads, four concurrent outbound requests, bounded queues, 12 s request and 45 s load deadlines, 100 kB JSON responses, at most four land-cover source tiles, 160 range requests/16 MB per load, at most 2 MB per range and four million source pixels per raster window. The process shares conservative Open-Meteo quotas (90/min, 900/hour, 4,500/day). Search and terrain caches are bounded to 64 and 16 entries for 24 hours. A deployment with multiple server processes must coordinate quotas externally; current limits are per process. The free Open-Meteo service is for noncommercial use; review [current terms](https://open-meteo.com/en/terms) before a commercial deployment and replace provider endpoints/credentials server-side as required.

`GeoScenario` version 1 stores the entire initial 4,096-cell elevation and categorical arrays, grid/extent, placements, wind, preburn and source metadata. Validation checks dimensions, numeric ranges, class IDs, date/text bounds and placement suitability, drops unknown fields, copies arrays and freezes the resulting snapshot. Every world gets new typed terrain arrays. Geographic fire randomness starts from the seed independently of UI/provider timing; procedural terrain retains its original RNG draws.

Browser resets/replays, shared scenarios, file/Mongo storage and headless challenges carry these exact inputs. The challenge board compares its existing swarm/central/greedy modes with the same snapshot; CBBA and unified remain selectable in the simulator. There is no provider refetch during replay. The API caps scenario request bodies at 400 kB; normalized geographic snapshots fit comfortably. Legacy procedural scenario documents remain valid. Caches are temporary acceleration, never replay storage. `HOTDRONES_DATA_DIR` can isolate local scenario/voice cache files, particularly for tests.

## Offline examples and attribution

`public/geography/loch-lomond.json` and `sierra-nevada.json` are genuinely sourced, normalized snapshots fetched through the same live provider code on **15 November 2026**, with exact retrieval timestamps in each file. Their buttons work without provider access (the app itself must still be served). Loch Lomond combines water and forest on lower terrain; Sierra Nevada has higher relief with a contrasting cover mix. `scripts/fetch-geo-examples.ts` regenerates both with fresh provenance; regeneration is an explicit network operation. `scripts/geo-fixture.ts` is synthetic test data and is never presented as an offline real location.

Required dataset acknowledgement travels in each snapshot and is displayed in the UI:

> © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium

WorldCover data are [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); cite [WorldCover 2021 v200](https://doi.org/10.5281/zenodo.7254221). Elevation attribution: **Open-Meteo / Copernicus DEM GLO-90, 2021 release**, [Copernicus DEM DOI](https://doi.org/10.5270/ESA-c5d3d65). These snapshots contain modified/resampled Copernicus data. Retain the attribution and transformation details when redistributing them. Place-name results are attributed to GeoNames/Open-Meteo in the interface. No source claims the hypothetical assets, manual ignition or simulated outcomes.

The elevation snapshots also retain the required notice: “Produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.” See [example provenance and source licences](../public/geography/README.md). The DEM's main acquisition was 2011–2015, with possible older gap fills; the 2021 release and retrieval timestamps do not imply recent observations. At 4 km the 17×17 DEM sampling lattice has approximately 246 m spacing, coarser than its nominal 90 m source.

## Verification

`npm run test:geography` covers transforms/boundaries, slope scaling, class mapping and missing data, placements/no-water cases, deterministic replay, all five modes, immutable arrays, file persistence, mocked Mongo serialization, provider-free headless challenge replay, API malformed/oversized payloads, mocked provider errors/timeouts/cancellation and stale response ordering. Live-provider availability is not required. Mongo serialization tests use a mocked collection rather than a real Atlas account. Also run `npm run typecheck`, `npm run build`, `npm run test:integrations`, `npm run test:voice` and `npm run experiment:legacy-check`.

On the Linux implementation host, the legacy sweep reproduced all 25 frozen result rows exactly after newline normalization. The existing byte-comparison script exits 1 because the checked-out frozen CSV uses CRLF and the generated CSV uses LF. Frozen files and the comparison script were left unchanged.

Implementation verification on 15 November 2026: typecheck, production build, integrations, geographic tests and all 13 voice tests passed. Uncached server loads produced both bundled examples. Chromium exercised preview, rejected water ignition, valid placement, Apply, Step, coordination changes, fog/minimap/camera controls, exact end-card replay, cancellation/failure preservation, stale selection ordering, procedural defaults and play/pause. An additional uncached browser search and load succeeded for Balloch, Scotland. No browser JavaScript errors were observed. Browser checks used reduced rendering resolution with shadows disabled for the software-only test environment; GPU performance was not assessed. Temporary Playwright tooling was installed outside the repository, without adding a browser dependency to the project.
