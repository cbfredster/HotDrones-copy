# Decisions log

Calls made while building the isometric 3D version, newest step last. Each entry says what was decided and why,
so a later session (human or agent) doesn't undo working code. Mirrored into Entire as brain memories
(`entire brain recall "<topic>"`).

## Step 0 — setup

- **Branch:** all work is on `iso-3d`, cut from `main` at `ba8b5f2`.
- **Baseline is reproducible here.** Before changing anything, `npm run experiment` was run on a clean export of
  `ba8b5f2` (Node 22) and its `results/` compared byte-for-byte with the committed files. That is the reference
  the `--legacy` check in step 3 is measured against.
- **Entire** was not installed in the cloud container, and `entire.io` / `docs.entire.io` are blocked by its
  network policy, so the CLI (v0.13.4) was installed from the Go module proxy
  (`go install github.com/entireio/cli/cmd/entire@v0.13.4`) and its usage read from `entire agent-help`.
  - `entire enable --agent claude-code --telemetry=false`: anonymous usage analytics are **off** by default.
    Turn them on with `entire configure --telemetry` if the team wants them.
  - Plugin commands have moved since the brief was written: `entire graph init-agents` is now
    `entire graph setup`, and code search is `entire graph query --query "..."`. "Brain checkpoints" are
    `entire brain remember "<text>" --kind decision` from the official `brain` plugin.
  - `entire brain setup --no-backfill --no-daemon`: built the local brain without spending agent tokens or
    installing a background service (pointless in a throwaway container).
  - Checkpoints (full agent transcripts) upload to `origin` on push. The repo is private, so only collaborators
    can read them. **If the repo is made public for judging, the `refs/entire/*` checkpoint refs become public
    too** — review with `entire checkpoint explain` first, or move them with
    `entire configure --local --checkpoint-remote github:<owner>/<private-repo>`.
  - **Checkpoint backend is `git-branch`, not the default `git-refs`.** The cloud session's git gateway only
    accepts pushes to `refs/heads/*`: `refs/entire/checkpoints/*` (and tags, see step 1) are refused with a 403.
    `entire configure --checkpoint-backend branch` stores checkpoints on the `entire/checkpoints/v1` branch,
    which does get through. Once nobody needs to push from a cloud session, move back with
    `entire configure --checkpoint-backend refs`.
  - This session started before the hooks existed, so it is linked to commits with
    `entire session attach <session-id> --force` on the newest *unpushed* commit (which adds the
    `Entire-Checkpoint` trailer), followed by `git commit --amend --no-edit` to restore the environment's
    commit signature, then `git push`.

## Step 1 — freeze the 2D version

- `Project Overview:` → `PROJECT_OVERVIEW.md` (a colon in a filename breaks checkout on Windows).
- `BASIC/` is an exact copy of the app at `ba8b5f2` (`index.html`, `src/`, `scripts/`, `results/`,
  `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `README.md`). The only edit is the
  "frozen snapshot" note at the top of `BASIC/README.md`. It keeps its own `package.json` so
  `cd BASIC && npm install && npm run dev` works standalone.
- `npm run dev:basic` is `vite BASIC --port 5174 --strictPort`. Vite is the root install; BASIC has no runtime
  dependencies, so nothing needs installing inside it. `--strictPort` makes a port clash fail loudly instead of
  silently moving the 2D app to another port mid-demo. Vite looks for its config in the directory it is
  pointed at, so the root `vite.config.ts` (proxy, extra pages) never applies to BASIC.
- `npm run experiment:basic` is `cd BASIC && tsx scripts/experiment.ts`: the script writes to `results/`
  relative to the working directory, so output lands in `BASIC/results/` and the root results are untouched
  (checked with checksums).
- Added `npm run typecheck:basic` so the snapshot can be type-checked from the root.
- Tag `v-2d-basic` points at the step 1 commit (`d2fdf0c`). **It exists only in the cloud container:** the
  session's git gateway refuses tag pushes. Publish it from any normal clone with
  `git fetch origin && git tag -a v-2d-basic d2fdf0c -m "Frozen top-down 2D version (BASIC/)" && git push origin v-2d-basic`.

## Step 2 — isometric 3D renderer

- **three.js r187**, WebGLRenderer. Everything is built from primitives (boxes, cones, a lathe for the
  domes); no textures, no external assets. Flat-shaded Lambert + one shadow-casting sun + a sky fill.
- **Layout:** `src/render/iso/` is split by concern so several people can work at once — `scene`, `camera`,
  `terrain`, `trees` (+ boulders), `structures` (village, helipad, mast), `fire` (flames, embers), `smoke`,
  `drones`, `particles` (water, steam, sparks, wreck smoke), `overlays` (links, domes, selection), `picking`,
  and `index.ts`, the only file the app imports.
- **Coordinates:** sim x → X, sim y → Z, height → Y × `V_SCALE` (0.4, in `util.ts`). Tiles are centred on
  integer coordinates, like the 2D view. The same scale is applied to terrain, drone altitude, the mast tip,
  link endpoints and smoke. `BASE_MAST_HEIGHT` (6) now lives in `sim/comms.ts` and is used by both
  `World.buildNet` and the renderer, so the drawn mast tip *is* the base's comms node.
- **Renderers only read.** No `world.rng` / `world.agentRng` anywhere under `src/render` or `src/ui`; cosmetic
  randomness is `hash01(tile, salt)` or a hash-seeded `CosmeticRng`.
- **One write path:** `applyJudgeAction(world, action)` in `src/sim/judge.ts`. Every control, and later the AI
  commander, goes through it; it validates, applies, and appends `{tick, action}` to `world.judgeLog`
  (same-tick slider spam is coalesced). `world.initialCfg` is the config before any judge touched it.
  `ReplayCursor` / `runScenario` replay a log; the end card's **Replay** button uses it and was checked to
  reproduce a run with 9 judge actions exactly (identical metrics and log).
- **Diff, don't redraw:** each tile's look is packed into one integer key (fire state, wetness level, fog
  level, fuel level). Once per rendered tick the key array is diffed and only changed tiles are restyled.
  Extinguished = `Burnt` with wetness ≥ 0.5 (wet, dark blue), distinct from burnt-out charcoal.
- **Loop:** ticks-per-second control, logarithmic 2–720 (720 = the old maximum of 12 ticks/frame at 60 fps),
  default 20, single-step, and drone positions interpolated between ticks. `World.finished` is untouched;
  the sim keeps running after the village is lost (banner only).
- **Picking:** raycast against the two terrain InstancedMeshes (`instanceId` = tile index), then the 2D app's
  tool logic. Drones are picked in screen space first, because they fly above the tile they are over.
  Checked: 600/600 projected tile centres pick the right tile; a drag never fires a tool.
- **Selection:** a click within 26 px of a drone (or 2 tiles of one) selects it; any other click opens the
  tile inspector. The 2D app used 3 tiles, which would have swallowed most inspector clicks near the swarm.
- **Cosmetic liberties, deliberately small:** drones sharing a sim position are drawn 0.2 tiles apart, and
  drones that are charging park on pad slots. Links are drawn to where the drone is drawn.
- **Minimap:** `src/render/renderer.ts` is reused unchanged apart from an exported colour table and a
  `compact` flag (drones as dots). "Auto" shows the opposite of the main view: the selected drone's map
  while the 3D view shows the truth, and the truth while the 3D view shows a drone's map.
- **Performance (measured headless):** 0.43 ms of JS per frame mid-fire, 0.58 ms per sim tick, ~50 draw
  calls, ~470k triangles including the shadow pass; ~50 fps on a *software* rasteriser. Not measured on a
  physical laptop GPU.

## Step 3 — spec gaps in the sim

Every item is a `Config` option. `legacyConfig` (in `src/sim/config.ts`) is the single place that lists the
"off" value of each, and **`npm run experiment:legacy-check` proves the sim has not drifted**: it runs the
sweep with `--legacy` and requires `results/legacy/summary.csv` to equal `BASIC/results/summary.csv` byte for
byte (passed: 25 of 25 conditions identical). Anything new must add its off-value to `legacyConfig`.

| Option | 3D default | Legacy | Why this default |
|---|---|---|---|
| `smokeModel` | `"massed"` | `"legacy"` | Spec: "must have multiple tiles for it to be smoky". |
| `smokeMassTiles` | 5 | – | See below. |
| `smokeBlocksComms` | `true` | `false` | Spec: smoke between drones is "infinite distance". Toggle kept. |
| `descentDrain` | 0.0003 | 0 | Spec: durability drops "going up or going down". Half the climb cost (`climbDrain` 0.0006, formerly a literal). |
| `spawnInLine` | `true` | `false` | Spec: "number of drones to start with in a line". 0.8 tiles apart, centred on the base; uses no random numbers. |
| `droneCount` | 10 | 10 | Slider 1–30, applied on New run. |
| `regrowth` | `true` | `false` | Spec: burnt tiles regrow "after a certain timestep and neighbouring conditions". |
| `regrowAfter` / `regrowChance` | 400 / 0.004 | – | Slow enough not to change short runs: outcomes over 12 seeds were identical with it on or off. |
| `towers` | 0 | 0 | Not in the original brief; added because step 6 asks for a "towers" condition. Slider 0–4. |

- **Massed smoke.** A burning tile's emission is scaled by `min(1, burningTilesIn3x3 / smokeMassTiles)²`.
  Measured with tiles pinned at maximum severity: one tile peaks at 0.13 at any wind speed (thick is 0.8; the
  old model reached 3.24), a pair at 0.52, and it takes four or more clustered tiles to make thick smoke in
  any wind. A fire front two or more tiles deep smokes exactly as before.
- **Regrowth** has its own RNG stream (`seed * 104729 + 71`), so switching it on cannot change which tiles the
  fire reaches. A burnt tile needs a healthy (unburnt, flammable) 4-neighbour to regrow. With regrowth on,
  `burntCount()` is the cumulative area ever burnt, so the headline metric cannot shrink.
- **"Towers" = relay towers** (my reading; say if you meant something else). Fixed masts on the highest dry
  ground, placed deterministically (no RNG), with ids below `BASE_ID`. They relay only: no map, no claims, no
  decisions. A tower is destroyed for good when its tile burns, so judges can cut the network by burning one.
- **`linkBlockReason(a, b, …)`** in `comms.ts` mirrors `canLink` check for check and returns
  `{reason: "hill" | "smoke" | "blackout", x, y, z}` or null. `canLink` is unchanged. Checked on 282,048
  pair-ticks: it is non-null exactly when a pair is in range and `canLink` is false.
- `World.networkNodes` keeps the nodes the current network was built from, so the renderer's dashed
  "broken link" lines are computed from the same positions as the solid ones (every in-range pair is one or
  the other, never both). `World.commsNodes()` replaces the private `buildNet()`.
- **Visuals:** dashed links coloured by cause (hill amber, smoke white, blackout purple) with a marker where
  the line is cut; red-and-white towers that char and lean when burnt; light-green ground and saplings on
  regrown tiles for 360 ticks; ▲ / ▼ on a drone's label while it pays the climb / descent cost; smoke puffs
  that are wisps over lone fires.
- Root `results/` still holds the original (legacy-default) numbers; they are regenerated in step 6.

## Step 4 — sponsor and MLH integrations

Everything is outside `src/sim/`. The one sim-side addition is `src/sim/judge.ts` (`applyJudgeAction` plus the
recorded action log), which is the single write path the ground rules ask for.

- **Layout.** `server/` is a small Node + TypeScript server (HTTP API and a WebSocket at `/ws`). `npm run dev`
  starts it next to Vite, which proxies `/api` and `/ws`; `npm run build && npm start` serves `dist/` from the
  same process. `src/integrations/` is the browser side. `main.ts` calls four hooks (`onRun`, `afterTick`,
  `afterJudge`, `frame`) and nothing else.
- **One event stream** (`src/integrations/events.ts`), derived by diffing world state after each tick: run
  started/finished, fire spotted *on the base's map*, drone state changes, crashes (with cause), water drops,
  links lost and regained (to the base, and to everyone), network split and healed, base offline/online, tower
  lost, village threatened/lost, fire out, judge actions. It only reads the world and has no DOM or network
  imports, so the server and the experiment runner use the same code.
- **Everything is optional.** Keys live in a gitignored `.env` (`.env.example` is committed) and only the server
  reads them. An integration with no key switches itself off, the header shows a status dot for each, and the
  browser falls back: built-in sitreps and a small command parser instead of Gemini; pre-generated clips, then
  the browser's own speech, and synthesised effects instead of ElevenLabs; a local JSON file instead of
  MongoDB; server memory instead of Tiger Data. `npm run test:integrations` runs the whole thing end to end
  with no keys at all.
- **No network call blocks a tick.** `src/integrations/api.ts` never throws: a failed call resolves to null.
  Telemetry is batched to the server about once a second.
- **Tiger Data** (`server/tiger.ts`, `server/sql/schema.sql`): hypertables `drone_telemetry`, `fire_metrics` and
  `events`, with `time = run start + tick seconds` so `time_bucket` works for live and experiment runs alike;
  continuous aggregates, a columnstore policy and a retention policy. `dashboard.html` reads only the
  aggregates. The schema also runs on plain Postgres (views stand in for the aggregates), which is how the tests
  exercise it (PGlite) without a Tiger account. **Not yet run against a real Tiger Cloud service.**
- **Gemini commander** (`server/gemini.ts`, `src/integrations/commander.ts`, `baseKnowledge.ts`): it is given
  only the base's picture: zones from `computeZones` on the base's belief map, the drones in the base's comms
  group now, and the last status heard from the rest. Every sitrep is labelled with how stale that picture is.
  Commands use function calling, mapped onto judge actions, and each one waits behind a confirm chip. It never
  steers a drone. The model is `GEMINI_MODEL`, defaulting to `gemini-flash-latest` rather than a pinned version
  name, so it keeps working when the Flash model is renamed. **Not yet run with a real key.**
- **Audio.** Radio voices play one at a time through a band-pass and squelch filter. The score crossfades calm /
  tense / critical stems with the threat level. The swarm composition (`audio/swarm.ts`): each drone is a voice
  pitched by its id on a minor pentatonic scale; drones that can reach each other share a clock; a cut-off group
  keeps its own clock, drifts and detunes, and snaps back with a chime when it reconnects; fire drives the
  percussion. Sound starts only after the Sound button, because browsers require a user gesture.
- **Scenarios** (`server/store.ts`, `server/challenge.ts`): seed + config + recorded judge actions replay a run
  exactly (checked in the integration test). Saving gives a `?scenario=<id>` link and queues a headless run in
  every mode for the "Challenge the swarm" board (`board.html`), ranked by how badly the swarm did. Saved config
  is sanitised on the server (map size and tick limit cannot be changed) so a saved scenario cannot stall it.
- **Experiment runner.** `--workers N` runs the sweep on worker threads; rows are written in sweep order, so the
  files are byte-identical to a single-threaded run (checked against the legacy results). `--db` streams each
  run into Tiger Data, one `fire_metrics` row per 10 ticks and drone telemetry every 50.
- **Vultr.** `Dockerfile`, `docker-compose.yml` (app + Caddy for HTTPS, and an on-demand `sweep` service) and
  `docs/deploy-vultr.md`. **Written but not built or deployed here** (no Docker in the cloud session).
- **`npm run audio:generate`** writes ElevenLabs sound effects, music stems and per-drone radio calls to
  `public/audio/` with a manifest, to be committed. **Not run: it needs `ELEVENLABS_API_KEY`.** Until it is,
  `public/audio/manifest.json` is empty and every sound is synthesised in the browser.
- **Not done in step 4:** Solana (step 4 has no Solana item; step 6 lists it as a prize) and Entire checkpoints
  for this part of the work (the `entire` CLI was not present in this session, and the agent guide says not to
  install tools automatically).

## Opening cloud cover

- The app opens with the map hidden under a layer of chunky low-poly clouds (`src/render/iso/clouds.ts`) and a
  "Start simulation" card. The sim is paused until the user starts it; the clouds then part from the middle
  outwards over 2.6 s and the run starts when they have gone. Play, Step and Space all start it too.
- Only on page load. **New run** after that does not bring the clouds back, so judges can restart quickly.
  A `?scenario=<id>` link that loads while the clouds are up stays covered until Start.
- The reveal is timed by the wall clock, not frame time, so a slow laptop does not drag it out.
- Drone labels, the minimap and the transport bar are hidden while covered, because they are HTML on top of
  the canvas and would show through the clouds.
- `?intro=0` skips it and auto-plays as before (for development and headless checks).
- Purely cosmetic: positions come from `hash01`, nothing reads or writes the sim, and the experiments are untouched.
- Shapes are deliberately irregular: two lumpy puff shapes (icosahedra with jittered vertices), each puff stretched
  and tilted differently, and three kinds of cloud (flat banks, heaps, tall towers) with uneven gaps, over a low
  flat deck that guarantees the map stays hidden. Kept at icosahedron detail 1 to hold the triangle count down.
- **Clouds fill the whole screen, corners included.** They are laid out over the ground the camera actually
  sees (the screen's corners projected onto the cloud deck, plus 14% padding), not a square around the map, and
  are re-laid if the window changes shape while covered. The camera is locked (no drag, zoom, Q/E/R or the
  camera buttons) until the clouds have parted, because the layout is for the home view.
- While fully covered, the map layers are not drawn (saves roughly 450k triangles) and the background is
  cloud-coloured, so any gap between puffs still reads as cloud. Both fade back as the clouds part.

## Step 5 — CBBA mode

- `cbba` is a fourth `Mode`; `swarm` is untouched. Algorithm in `src/sim/cbba.ts`, wired in `World.cbbaPlan()`
  (every `decisionInterval` ticks, per connected group) and `World.decideCbba()` (fly the first zone in the
  path). Settings: `cbbaBundleSize` 3, `cbbaHorizon` 90 ticks, `cbbaRounds` 6. Only read in `cbba` mode, so
  `legacyConfig` needs no new entries; **the legacy check still passes (25/25 identical)**.
- **Tasks are zone slots** (`zoneId#k`), each worth `value / slots`, slightly less for later slots. Zones come
  from each drone's own belief map, so two drones can disagree about a zone's value; bids still compare.
- **Path score:** time-discounted value, `value * exp(-t / cbbaHorizon)`, with one load per zone and a refill
  detour before every zone after the first. Marginal gain at the best insertion point is the bid.
- **Consensus in a connected group** (messages relay, so a group is one consensus domain, like map merging):
  members are authoritative about their own bundles; hearsay about absent drones is passed on newest-first and
  forgotten after 5 x `trackerTimescale`; an outbid drone releases that task and everything after it. Build
  and consensus alternate until no bundle changes or `cbbaRounds` is reached.
- **Out of contact:** an absent winner's bid is scaled by `exp(-age / trackerTimescale)` and the particle
  filter's confidence that it is near the zone (the same rule as swarm mode). The trackers and heartbeats used
  by swarm mode now also run in `cbba` mode.
- **Empty bundle** (every slot held by a better bid): reinforce the zone with the best value per current holder,
  rather than idling.
- **Speed:** the best-water-source search scans every water tile, so detours are cached per planning step
  (keyed on whole tiles). That made it ~10x faster with identical results: ~1.3 ms/tick average with 10 drones
  (swarm: 0.7), worst tick ~10 ms even with 30 drones. Deterministic: same seed, same metrics.
- **Experiments:** `npm run experiment` now includes `cbba` (not with `--legacy`). The Challenge board still
  replays scenarios in the original three modes only.
- **First numbers (12 seeds, current defaults):** CBBA 691 tiles burnt, village lost 2/12; swarm 980, 3/12;
  central 2212, 9/12; greedy 1233, 6/12. Same ordering with comms range 6 and with the base offline at tick 120.
- Not done: fire forecasting inside each drone (the optional half of step 5).
