// The village-lost banner and the end-of-run card. Both only read world state.
// (The sim keeps running after the village is lost; World.finished is unchanged.)
import { FUEL, Tile } from "../sim/terrain";
import { World } from "../sim/world";
import { $ } from "./dom";

export class RunOverlays {
  private bannerFor: World | null = null;
  private cardFor: World | null = null;
  private dismissedFor: World | null = null;

  constructor(handlers: { replay: () => void; newSeed: () => void }) {
    $("endReplay").onclick = handlers.replay;
    $("endNewSeed").onclick = handlers.newSeed;
    $("endClose").onclick = () => {
      this.dismissedFor = this.cardFor;
      $("endcard").hidden = true;
    };
  }

  /** Forget everything about the previous run. */
  reset() {
    this.bannerFor = this.cardFor = this.dismissedFor = null;
    $("banner").hidden = true;
    $("endcard").hidden = true;
  }

  update(world: World) {
    if (world.env.villageLost && this.bannerFor !== world) {
      this.bannerFor = world;
      const b = $("banner");
      b.innerHTML = `VILLAGE LOST <small>fire reached it at t=${world.env.villageLostAt} — the swarm fights on</small>`;
      b.hidden = false;
    }
    if (world.finished && this.cardFor !== world && this.dismissedFor !== world) {
      this.cardFor = world;
      this.showCard(world);
    }
  }

  private showCard(world: World) {
    const m = world.metrics();
    const type = world.terrain.type;
    let flammable = 0;
    for (let i = 0; i < type.length; i++) if (FUEL[type[i] as Tile].ignite > 0) flammable++;
    const out = m.extinguishedAt >= 0;
    const card = $("endcard");
    card.classList.toggle("saved", !m.villageLost);
    card.classList.toggle("lost", m.villageLost);
    $("endTitle").textContent = m.villageLost ? "Village lost" : out ? "Village saved" : "Time limit reached";
    $("endSub").textContent = out
      ? `The last fire went out ${m.extinguishedAt} ticks after the drones were called.`
      : `Still burning after ${m.tick} ticks (${m.burning} tiles alight).`;
    const modeName = { swarm: "Swarm", central: "Central control", greedy: "No coordination" }[world.cfg.mode] ?? world.cfg.mode;
    $("endStats").innerHTML = `
      <span>Burnt area</span><b>${m.burnt} tiles (${((100 * m.burnt) / Math.max(1, flammable)).toFixed(0)}% of what could burn)</b>
      <span>Village</span>${m.villageLost ? `<b class="bad">lost at t=${m.villageLostAt}</b>` : `<b class="good">safe</b>`}
      <span>Drones lost</span><b class="${m.dronesLost ? "bad" : ""}">${m.dronesLost} of ${world.drones.length}</b>
      <span>Water dropped</span><b>${m.waterDropped} loads</b>
      <span>Time to extinguish</span><b>${out ? m.extinguishedAt + " ticks" : "not extinguished"}</b>
      <span>Run</span><b>${modeName} · seed ${world.cfg.seed}${world.judgeLog.length ? ` · ${world.judgeLog.length} judge action${world.judgeLog.length > 1 ? "s" : ""}` : ""}</b>`;
    card.hidden = false;
  }
}
