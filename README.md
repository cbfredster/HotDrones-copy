# HotDrones

A swarm of firefighting drones that keeps working when communications fail.
Built for the **Neptune North "Actors work better together"** challenge at DurHack 2026.

A wildfire spreads across hilly coniferous forest towards a village. Ten drones carry water from lakes to the fire front. Hills, distance and blackout zones cut their radio links, and the home base can go offline. Every drone makes its own decisions from its own map. When drones can talk, they merge what they know and agree who fights where. When they can't, each one guesses where its lost teammates probably are and works around them.

## Run it

```bash
npm install
npm run dev          # the isometric 3D app (http://localhost:5173)
npm run experiment   # headless: 30 seeds x every condition -> results/ (about 2.5 min)
npm run typecheck
npm run experiment:legacy-check   # proves the sim still reproduces the frozen 2D results exactly
```

In the 3D view: drag to pan, wheel to zoom, **Q/E** rotate 90° (hills hide things), **R** resets the view,
**Space** plays/pauses, **.** steps one tick, **1–4** pick a judge tool, **B** shows the selected drone's own map.

Open `results/report.html` after running the experiments for the charts.

The original top-down 2D version is frozen in [`BASIC/`](BASIC/README.md) (tag `v-2d-basic`):

```bash
npm run dev:basic         # the 2D app on http://localhost:5174, side by side with the main app
npm run experiment:basic  # its experiments; results land in BASIC/results/
```

The original brief is in [`PROJECT_OVERVIEW.md`](PROJECT_OVERVIEW.md); calls made along the way are logged in [`DECISIONS.md`](DECISIONS.md).

## Sponsor integrations (all optional)

`npm run dev` also starts a small server (`server/`) for the integrations. With no keys the demo still runs:
each integration switches itself off and shows a grey status dot in the header. To switch them on:

```bash
cp .env.example .env     # then paste in the keys you have; .env is gitignored
npm run db:migrate       # once, after setting TIGER_DATABASE_URL
npm run dev
```

| Integration | Key in `.env` | What judges see | Without the key |
|---|---|---|---|
| Tiger Data | `TIGER_DATABASE_URL` | `dashboard.html`: live fire growth, connectivity, battery spread; experiment comparison | Live charts from server memory |
| Gemini | `GEMINI_API_KEY` | AI incident commander: sitreps labelled with how stale the base's picture is, typed commands behind a confirm chip, after-action report | Built-in sitreps and a basic command parser |
| ElevenLabs | `ELEVENLABS_API_KEY` | Dispatcher and drone radio voices; `npm run audio:generate` makes effects and music for `public/audio/` | Browser speech and synthesised sound |
| MongoDB Atlas | `MONGODB_URI` | Scenario share links (`?scenario=<id>`) and the "Challenge the swarm" board (`board.html`) | A local file on the server |
| Vultr | – | Hosting and big sweeps: see [`docs/deploy-vultr.md`](docs/deploy-vultr.md) | – |

Press **Sound** in the header to hear the swarm: drones that can reach each other play in time, and a group
that is cut off drifts out of time until it reconnects.

```bash
npm run experiment -- 30 --workers 8   # same results, on 8 threads
npm run experiment -- 30 --db          # also stream the runs into Tiger Data
npm run test:integrations              # end-to-end check, needs no keys
npm run build && npm start             # production: one server on http://localhost:8787
```

## Results (30 random maps per condition)

| Condition | Swarm (ours) | Central control | No coordination | No drones |
|---|---|---|---|---|
| Perfect comms (range ∞) | 935 burnt, village lost 20% | 1001 burnt, 17% | 2067 burnt, 57% | 3077, 100% |
| Normal comms (range 14) | **887 burnt, 13%** | 2281 burnt, 73% | 2163 burnt, 63% | 3077, 100% |
| Poor comms (range 6) | **1073 burnt, 20%** | 2808 burnt, 97% | 2175 burnt, 60% | 3077, 100% |
| Base offline at tick 120 | **890 burnt, 13%** | 2585 burnt, 83% | 2128 burnt, 63% | 3077, 100% |

**The pitch in one line:** with perfect comms, a central controller and our swarm do about equally well. As soon as comms degrade, central control collapses and the swarm barely notices.

Every approach faces exactly the same fires on each seed (fire randomness and drone randomness use separate generators), so the comparison is fair.

## How it works

```
src/sim/            the simulation: no graphics, runs in the browser AND in Node
  config.ts         every tunable number in one place
  rng.ts            seeded random numbers (reproducible runs)
  terrain.ts        hills (value noise), tile types, village, base
  environment.ts    the TRUE world: fire spread, severity, water, smoke, wind
  belief.ts         a drone's private fire map + tile-by-tile merging
  comms.ts          who can talk: range, 3D line of sight over hills, blackouts, relaying
  planner.ts        turning the believed fire front into task zones with threat scores
  tracker.ts        particle filter guessing where lost teammates are
  drone.ts          one drone: sensing, flying, battery, damage
  world.ts          the tick loop, the auction, the baselines, judge controls
  judge.ts          the one function judges' actions go through; records them for exact replays
src/render/iso/     isometric three.js renderer, one file per concern (terrain, trees, fire, smoke, drones...)
src/render/renderer.ts  the original top-down canvas renderer, now the corner minimap
src/ui/             panels, minimap, end card
src/main.ts         browser app: controls and the frame loop
scripts/experiment.ts  headless experiment runner -> CSV + HTML charts
```

### Each tick

1. **Environment:** wind drifts; fire spreads, intensifies and burns out; smoke drifts downwind and fades.
2. **Sense:** each drone observes tiles within its sensor radius. Thick smoke shrinks that radius.
3. **Network:** work out which drones (and the base) can reach each other.
4. **Share:** everyone in the same connected group merges fire maps and plans.
5. **Track:** each drone updates its guesses about teammates it can't hear.
6. **Act:** each drone refuels or recharges if needed, otherwise picks and flies to a target and drops water.

### The fire

Each tile is grass, forest, sand, rock or water. Only grass and forest burn. Every tick a burning tile can ignite each of its 8 neighbours with probability

`spreadBase × fuel × wind × slope × severity × (1 − wetness)`

- **wind:** `exp(strength × speed × cos(angle between wind and spread direction))`, so fire races downwind;
- **slope:** `exp(0.25 × height difference)`, so fire runs uphill;
- **severity** rises the longer a tile burns (1 to 3). Hotter fires spread faster and need more water;
- **wetness:** water dropped on unburnt ground makes it hard to ignite for a while (firebreaks);
- **embers:** very hot fires occasionally throw a spot fire a few tiles downwind.

The fire burns for 60 ticks before the drones are called out, so they face an established fire.

### What a drone knows

Drones **never read the true world**. Each has a `BeliefMap`: for every tile, what it believes (unburnt / burning / burnt) and *when it last saw it*. It learns from its own sensor and from other drones. Maps are merged **tile by tile, newest observation wins**, so partial maps from different drones combine correctly. In the UI, *Show selected drone's map* displays one drone's belief, darkened where it is out of date.

### Who can talk to whom

Two nodes can talk if they are within radio range, neither is in a blackout zone, and the straight 3D line between them (at flying altitude) clears the hills. Messages relay through other drones, so a whole connected group shares information. Smoke does not block radio by default, because in reality it barely affects it, but there is a toggle. The base has a taller mast and a longer range. Docking at base swaps maps by cable even when base radio is down.

### Choosing what to fight: the auction

1. **Task zones.** The drone finds the *front* on its own map (burning tiles next to unburnt fuel) and groups it into 6×6 zones. Burning tiles in the middle of the fire are ignored because they'll burn out anyway.
2. **Threat score** for each front tile: `severity × closeness to the village × wind pushing it towards the village × fuel ahead`. A zone's value is the sum, with a bonus for small spot fires that can be fully put out. Zones are worth 1 to 4 drones ("slots") depending on size.
3. **Bid** = `zone value ÷ time to make an impact` (including a detour to refill if the drone is empty), plus a small stickiness bonus for its current zone so drones don't dither.
4. **Consensus.** Drones in contact share claims: who is going where, with what bid. A drone takes the best zone that isn't already full of teammates with *higher* bids. This is a consensus-based auction in the style of CBAA (Choi, Brunet & How, 2009). Higher bids always win and ties go to the lower ID, so drones that can talk settle on a conflict-free split.

### When a teammate goes quiet: the particle filter

When a drone stops hearing from a teammate, it creates 40 guesses (particles) at the teammate's last known position. Each tick they fly towards the teammate's last known target with some randomness, so the cloud spreads the longer the silence lasts. When deciding whether a zone is already covered, a lost teammate counts as

`exp(−time since contact / 120) × fraction of guesses near that zone`

A recently lost teammate is trusted to still be doing its job. One silent for a long time, or possibly crashed, gradually stops counting, and the drone covers its zone itself. When contact returns, the cloud collapses back to the real position. Select a drone in the UI to see its clouds.

### Staying alive

- **Battery** drains every tick, faster flying into a headwind or climbing. A drone heads home when it has just enough charge to make it back, with a safety margin.
- **Damage** builds up from flying over fire and through smoke. Above 70% the drone goes home for repair. At 100% it is destroyed.
- **Water:** 5 drops per load. Empty drones fly to the water source that minimises the detour to their target.
- **No fire on the map:** fly home to fetch the base's map. If that has none either, **scout** areas nobody has seen for a while.

### The baselines

- **Central control:** the base assigns every drone it can reach using the same scoring, so it's a strong baseline when comms are good. Drones out of contact finish their last order and fly home for new ones. Peer-to-peer map sharing is off.
- **No coordination:** each drone goes for its own best zone and ignores the others' plans. Maps are still shared, so this isolates the value of the auction itself.

## Judge controls (in the browser)

- **Start fire:** click to ignite a tile.
- **Comms blackout:** click to place a zone where radios don't work.
- **Crash drone:** click a drone to destroy it.
- **Cut base comms:** take the base offline.
- **Wind direction and speed** sliders; **comms range** slider; **smoke blocks comms** toggle.
- **Select a drone** to see its state, who it can reach, its top zone bids, and its guesses about lost teammates.

Seed 15 is a good demo: the swarm saves the village; central control and no coordination both lose it.

## Ideas for next steps

- Full CBBA (each drone plans a sequence of zones instead of one).
- Fire forecasting inside each drone: run the fire model forward from its belief and target where the fire *will be*.
- Real elevation data for a real wildfire-prone area.
