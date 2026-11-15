// Sidebar panels: run stats + chart, the selected drone, and the tile inspector.
// Read-only views of world state.
import { BASE_ID, inBlackout } from "../sim/comms";
import { Fire } from "../sim/environment";
import { burntHectares, gridToGeo } from "../sim/geography";
import { FUEL, TILE_NAMES, Tile } from "../sim/terrain";
import type { Drone } from "../sim/drone";
import { FEATURE_NAMES } from "../sim/unified";
import { World } from "../sim/world";
import { $ } from "./dom";

const FIRE_NAMES = ["unburnt", "burning", "burnt"];

export function updateStats(world: World) {
  const m = world.metrics();
  const alive = world.drones.filter((d) => d.alive).length;
  const status = m.villageLost ? `<b class="bad">LOST (t=${m.villageLostAt})</b>` : `<b class="good">safe</b>`;
  const done = m.extinguishedAt >= 0 ? `<b class="good">fire out at t=${m.extinguishedAt}</b>` : `<b>${m.burning} tiles burning</b>`;
  $("stats").innerHTML = `
    <span>Tick</span><b>${m.tick}</b>
    <span>${world.initialGeo ? "Protected target" : "Village"}</span>${status}
    <span>Fire</span>${done}
    <span>Area burnt</span><b>${m.burnt} tiles${world.initialGeo ? ` · ${burntHectares(world.initialGeo, m.burnt).toFixed(2)} ha` : ""}</b>
    <span>Drones</span><b>${alive}/${world.drones.length} flying</b>
    <span>Water drops</span><b>${m.waterDropped}</b>
    <span>Base comms</span><b class="${world.baseOnline ? "good" : "bad"}">${world.baseOnline ? "online" : "down"}</b>${
      world.towers.length ? `\n    <span>Relay towers</span><b>${world.towers.filter((t) => t.alive).length}/${world.towers.length} standing</b>` : ""
    }
    <span>Comms groups</span><b>${world.network.components.length}</b>`;
  drawChart(world);
}

function drawChart(world: World) {
  const c = $<HTMLCanvasElement>("chart");
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, c.width, c.height);
  const hist = world.history;
  ctx.fillStyle = "#9aa0a6";
  ctx.font = "11px sans-serif";
  ctx.fillText("burning (orange) / burnt (grey)", 4, 12);
  if (hist.length < 2) return;
  const maxV = Math.max(10, ...hist.map((h) => h.burnt));
  const maxT = Math.max(200, hist[hist.length - 1].tick);
  const line = (key: "burning" | "burnt", colour: string) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    hist.forEach((h, k) => {
      const x = (h.tick / maxT) * c.width;
      const y = c.height - 2 - (h[key] / maxV) * (c.height - 4);
      k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
  };
  line("burnt", "#9aa0a6");
  line("burning", "#ff9f1c");
}

function droneHtml(world: World, id: number): string {
  const d = world.drones[id];
  const contacts = world.network.componentOf.get(d.id);
  const mates =
    contacts === undefined
      ? []
      : world.network.components[contacts].filter((x) => x !== d.id).map((x) => (x === BASE_ID ? "base" : `#${x}`));
  const lost = [...d.trackers.entries()].map(([tid, tr]) => `#${tid} (±${tr.spread().toFixed(1)})`);
  const rows = d.lastScores
    .map((s) => `<tr><td>${s.zone === d.zone ? "▶ " : ""}${s.zone}</td><td>${s.score.toFixed(2)}</td><td>${s.taken.toFixed(2)}</td></tr>`)
    .join("");
  return `
    <div class="stats">
      <span>Drone</span><b>#${d.id} — ${d.state}</b>
      <span>Battery</span><b>${Math.round(Math.max(0, d.battery) * 100)}%</b>
      <span>Damage</span><b>${Math.round(d.damage * 100)}%</b>
      <span>Water</span><b>${d.water.toFixed(1)} / ${world.cfg.waterCapacity}</b>
      <span>Can reach</span><b>${mates.length ? mates.join(", ") : "nobody"}</b>
      <span>Guessing</span><b>${lost.length ? lost.join(", ") : "—"}</b>
    </div>
    ${
      world.cfg.mode === "central"
        ? `<p class="hint">Central mode: follows base's orders (${d.orders ? "zone " + d.orders.zone : "none"}).</p>`
        : world.cfg.mode === "unified" && world.unified
        ? unifiedHtml(world, d)
        : world.cfg.mode === "cbba"
        ? `<table><tr><th>Plan</th><th>Zone</th><th>Winning bid</th></tr>${
            d.cbba.path.map((id, k) => `<tr><td>${k === 0 ? "▶ now" : `then ${k + 1}`}</td><td>${id.replace("#", " slot ")}</td><td>${(d.cbba.table.get(id)?.bid ?? 0).toFixed(2)}</td></tr>`).join("") ||
            `<tr><td colspan="3">No zone won: reinforcing the busiest one</td></tr>`
          }</table>
           <p class="hint">CBBA: each drone plans a bundle of zones (this load, then the next refills) and the swarm agrees on one winner per zone slot. Outbid on one zone, a drone drops it and everything planned after it.</p>`
        : `<table><tr><th>Zone</th><th>Bid</th><th>Already taken by</th></tr>${rows}</table>
           <p class="hint">"Already taken" counts teammates with better bids, plus a probability for out-of-contact teammates the drone thinks are still there.</p>`
    }`;
}

function unifiedHtml(world: World, d: Drone): string {
  const u = world.unified!;
  const ag = u.agent(d.id);
  const nd = u.node(d.id);
  const st = u.stats();
  const plan =
    d.cbba.path.map((id, k) => `<tr><td>${k === 0 ? "▶ now" : `then ${k + 1}`}</td><td>${id.replace("#", " slot ")}</td><td>${(d.cbba.table.get(id)?.bid ?? 0).toFixed(2)}</td></tr>`).join("") ||
    `<tr><td colspan="3">No zone won: reinforcing the busiest one</td></tr>`;
  const att = ag.attention.slice(0, 3).map((a) => `#${a.id} ${(a.a * 100).toFixed(0)}%`).join(", ") || "—";
  const theta = FEATURE_NAMES.map((n, k) => `${n} ${ag.theta[k] >= 0 ? "+" : ""}${ag.theta[k].toFixed(2)}`).join(", ");
  const saving = st.fullSyncBytes > 0 ? (st.fullSyncBytes / Math.max(1, st.bytesSent)).toFixed(0) + "×" : "—";
  return `<table><tr><th>CBBA plan</th><th>Zone</th><th>Winning bid</th></tr>${plan}</table>
    <div class="stats">
      <span>DTN store</span><b>${nd.store.size} bundles carried</b>
      <span>Sent / suppressed</span><b>${nd.entriesSent} / ${nd.entriesSuppressed} changes (IB)</b>
      <span>CI fusions</span><b>${nd.fusions} agree, ${nd.conflicts} conflicts</b>
      <span>Attention</span><b>${att}</b>
      <span>Policy θ</span><b>${theta}</b>
      <span>Last reward</span><b>${ag.lastReward.toFixed(2)} (${ag.updates} updates)</b>
      <span>Swarm bandwidth</span><b>${(st.bytesSent / 1024).toFixed(0)} KB, ${saving} less than map sync</b>
    </div>
    <p class="hint">Unified stack: CBBA assigns zones; observations travel as DTN bundles (store-carry-forward), only changes worth their bits (event trigger + Information Bottleneck); maps fuse by Covariance Intersection; a graph-attention policy learned online scales zone values; distributed MPC plans each step around teammates, smoke and fire.</p>`;
}

function tileHtml(world: World, tile: number): string {
  const { terrain, env, cfg } = world;
  const x = tile % terrain.w;
  const y = Math.floor(tile / terrain.w);
  const type = terrain.type[tile] as Tile;
  const fire = env.fire[tile];
  const tags: string[] = [];
  if (terrain.village.includes(tile)) tags.push(world.initialGeo ? "hypothetical protected target" : "village");
  if (Math.round(world.base.x) === x && Math.round(world.base.y) === y) tags.push("home base");
  if (type === Tile.Water) tags.push("water source");
  const tower = world.towers.find((t) => t.x === x && t.y === y);
  if (tower) tags.push(tower.alive ? "relay tower" : `relay tower (burnt down at t=${tower.lostAt})`);

  let fireText: string;
  if (fire === Fire.Burning) {
    fireText = `<b class="bad">burning</b> · severity ${env.severity[tile].toFixed(1)} · ${Math.ceil(env.burnLeft[tile])} ticks of fuel left`;
  } else if (fire === Fire.Burnt) {
    fireText = env.wetness[tile] >= 0.5 ? "<b>extinguished</b> (wet)" : "<b>burnt out</b>";
  } else {
    fireText = FUEL[type].ignite > 0 ? '<b class="good">unburnt</b>' : "<b>cannot burn</b>";
    if (env.regrownAt[tile] >= 0) fireText += ` · regrew at t=${env.regrownAt[tile]}`;
  }

  const smoke = env.smoke[tile];
  const smokeText = smoke > cfg.thickSmoke * 1.5 ? "dense" : smoke > cfg.thickSmoke ? "thick" : smoke > 0.05 ? "light" : "clear";

  // What the base believes about this tile, and how old that belief is.
  const seen = world.base.belief.lastSeen[tile];
  const baseView =
    seen < 0 ? "never seen" : `${FIRE_NAMES[world.base.belief.fire[tile]]}, ${world.tick - seen} ticks old`;

  const zs = cfg.zoneSize;
  const zone = Math.floor(y / zs) * Math.ceil(terrain.w / zs) + Math.floor(x / zs);

  return `
    <div class="stats">
      <span>Tile</span><b>(${x}, ${y}) — ${TILE_NAMES[type]}${tags.length ? " · " + tags.join(", ") : ""}</b>
      <span>Height</span><b>${terrain.height[tile].toFixed(2)} tile units${world.initialGeo ? ` · ${world.initialGeo.elevationM[tile].toFixed(1)} m source elevation` : ""}</b>
      ${world.initialGeo ? `<span>Coordinates</span><b>${gridToGeo(world.initialGeo, x, y).lat.toFixed(5)}, ${gridToGeo(world.initialGeo, x, y).lon.toFixed(5)}</b><span>WorldCover 2021</span><b>Class ${world.initialGeo.landCover[tile]}</b>` : ""}
      <span>Fire</span><span>${fireText}</span>
      <span>Wetness</span><b>${Math.round(env.wetness[tile] * 100)}%</b>
      <span>Smoke</span><b>${smoke.toFixed(2)} (${smokeText})</b>
      <span>Radio</span><b class="${inBlackout(world.blackouts, x, y) ? "bad" : ""}">${inBlackout(world.blackouts, x, y) ? "inside a blackout zone" : "normal"}</b>
      <span>Task zone</span><b>${zone}</b>
      <span>Base's map says</span><b>${baseView}</b>
    </div>`;
}

let lastHtml = "";

/** Fill the "Selected" panel: a drone if one is selected, else the inspected tile, else a hint. */
export function updateSelection(world: World, drone: number | null, tile: number | null) {
  let title = "Selected";
  let html = `<p class="hint">Click a drone, or any tile, on the map.</p>`;
  if (drone !== null && world.drones[drone]) {
    title = "Selected drone";
    html = droneHtml(world, drone);
  } else if (tile !== null) {
    title = "Tile inspector";
    html = tileHtml(world, tile);
  }
  if (html === lastHtml) return;
  lastHtml = html;
  $("selectedTitle").textContent = title;
  $("droneInfo").className = "";
  $("droneInfo").innerHTML = html;
}
