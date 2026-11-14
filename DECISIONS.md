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
