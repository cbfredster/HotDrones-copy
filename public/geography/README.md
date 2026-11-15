# Geographic example provenance

These JSON files contain **genuinely sourced**, normalized initial inputs. They were
loaded uncached through `server/geography.ts` on 15 November 2026. They are not
synthetic test fixtures. Provider access is unnecessary when loading or replaying
these snapshots. `scripts/fetch-geo-examples.ts` explicitly regenerates them; it is
never run by install, build, startup, or tests.

| File | Centre (WGS84) | Square extent | Sampled elevation | Observed WorldCover classes |
| --- | --- | --- | --- | --- |
| `loch-lomond.json` | 56.075, -4.63 | 4 km | 7–388.14 m | 10 tree cover, 30 grassland, 50 built-up, 80 permanent water |
| `sierra-nevada.json` | 37.123, -3.48 | 4 km | 1084.19–1780.47 m | 10 tree cover, 20 shrubland, 30 grassland, 40 cropland, 50 built-up, 60 bare/sparse, 80 permanent water |

Elevation comes from [Open-Meteo's elevation API](https://open-meteo.com/en/docs/elevation-api),
which documents Copernicus DEM 2021 GLO-90, approximately 90 m source resolution.
The source is a surface model: canopy and buildings may be included. Main
acquisition was 2011–2015 with possible older gap-fill data; 2021 is a release
year, and the retrieval date is **not** an observation date. Heights use EGM2008.
We sampled a 17×17 lattice of points from the first to last simulation cell
centres (246.1 m spacing for these 4 km examples), in three requests of at most
100 points, then interpolated bilinearly to 64×64 cell centres. This is coarser
than the source DEM; subgrid terrain is not represented.

Land cover comes from [ESA WorldCover 2021 v200](https://esa-worldcover.org/en/data-access),
using these publicly readable Cloud Optimized GeoTIFFs:

- [Loch Lomond source tile N54W006](https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N54W006_Map.tif)
- [Sierra Nevada source tile N36W006](https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_N36W006_Map.tif)

Only small byte ranges for each footprint were retrieved, with full-resolution
windows decoded locally by GeoTIFF.js. Class IDs are sampled at simulation cell
centres using nearest categorical sampling. Small streams, roads, and patches
can disappear at this grid resolution. No missing coverage is invented or
reclassified as water. No ponds, village, or settlement are carved into the data.
Initial ignitions, response bases/refill stations, and protected targets are
**hypothetical simulation placements**, not observed incidents or assets.

WorldCover is historical land cover, not a live fire or vegetation observation.
The simulator approximates its classes as documented in the project README and
`landCoverToTile`; these are uncalibrated model inputs.

Attribution travels with each JSON snapshot and is preserved by scenario sharing:

© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021)
processed by ESA WorldCover consortium.

Elevation: Open-Meteo / Copernicus DEM GLO-90. Produced using Copernicus WorldDEM-90
© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under
COPERNICUS by the European Union and ESA; all rights reserved.

The [WorldCover dataset](https://doi.org/10.5281/zenodo.7254221) and
[Open-Meteo API data](https://open-meteo.com/en/licence) permit redistribution and
modification with attribution under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Copernicus GLO-90 has its own free and open licence, with the above required
notice; see the [official Copernicus licensing and citation guidelines](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM).
Changes consist of resampling, interpolation, and conversion into the bounded
geographic snapshot format. The data providers do not endorse this simulation.

Primary provider and library documentation consulted during implementation:

- [Open-Meteo geocoding](https://open-meteo.com/en/docs/geocoding-api) (GeoNames place labels)
- [Open-Meteo elevation](https://open-meteo.com/en/docs/elevation-api)
- [Open-Meteo terms](https://open-meteo.com/en/terms) (free service is noncommercial;
  600 calls/minute, 5,000/hour, 10,000/day)
- [ESA WorldCover data access and attribution](https://esa-worldcover.org/en/data-access)
- [GeoTIFF.js source and API](https://github.com/geotiffjs/geotiff.js)

The server enforces four simultaneous provider requests and two location loads,
12 seconds per request and 45 seconds per whole load, at most 160 raster ranges
and 16 MB of requested raster data per load, no full-file fallback, and a
4-million-cell decoded window limit. Completed search results (64) and terrain
snapshots (16) are cached for 24 hours; they are not replay storage. Free
Open-Meteo calls have process-wide caps of 90/minute, 900/hour, and 4,500/day;
multi-process deployments must apply a shared quota at their ingress. These
limits are deliberately below the documented provider limits, but other
applications using the same IP may still cause provider 429 responses.
