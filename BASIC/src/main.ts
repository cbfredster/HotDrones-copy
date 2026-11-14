import { Renderer, ViewOptions } from "./render/renderer";
import { BASE_ID } from "./sim/comms";
import { Mode } from "./sim/config";
import { World } from "./sim/world";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("map");

let world: World;
let renderer: Renderer;
let playing = true;
let tool = "select";
const view: ViewOptions = { beliefOf: null, selected: null, showLinks: true, showSmoke: true, showClouds: true, showSensors: true };

function newRun() {
  const mode = $<HTMLSelectElement>("mode").value as Mode;
  const seed = Number($<HTMLInputElement>("seed").value) || 1;
  world = new World({
    seed,
    mode,
    commsRange: Number($<HTMLInputElement>("range").value),
    smokeBlocksComms: $<HTMLInputElement>("smokeComms").checked,
  });
  renderer = new Renderer(canvas, world);
  (window as any).world = world; // handy for debugging in the browser console
  (window as any).view = view;
  view.selected = null;
  view.beliefOf = null;
  $("beliefView").classList.remove("on");
  $("baseOutage").classList.remove("on");
  syncWindSliders();
}

function syncWindSliders() {
  const deg = ((world.env.wind.angle * 180) / Math.PI + 360) % 360;
  $<HTMLInputElement>("windAngle").value = String(Math.round(deg));
  $<HTMLInputElement>("windSpeed").value = String(Math.round(world.env.wind.speed * 100));
}

// ---------------------------------------------------------------- controls
$("reset").onclick = newRun;
$("mode").onchange = newRun;
$("play").onclick = () => {
  playing = !playing;
  $("play").textContent = playing ? "Pause" : "Play";
  $("play").classList.toggle("on", playing);
};
for (const b of document.querySelectorAll<HTMLButtonElement>("#tools button")) {
  b.onclick = () => {
    tool = b.dataset.tool!;
    document.querySelectorAll("#tools button").forEach((x) => x.classList.toggle("on", x === b));
  };
}
const setWind = () =>
  world.setWind((Number($<HTMLInputElement>("windAngle").value) * Math.PI) / 180, Number($<HTMLInputElement>("windSpeed").value) / 100);
$("windAngle").oninput = setWind;
$("windSpeed").oninput = setWind;
$("range").oninput = () => (world.cfg.commsRange = Number($<HTMLInputElement>("range").value));
$("smokeComms").onchange = () => (world.cfg.smokeBlocksComms = $<HTMLInputElement>("smokeComms").checked);
$("baseOutage").onclick = () => {
  world.base.manualOutage = !world.base.manualOutage;
  $("baseOutage").classList.toggle("on", world.base.manualOutage);
  $("baseOutage").textContent = world.base.manualOutage ? "Restore base comms" : "Cut base comms";
};
$("clearBlackouts").onclick = () => world.clearBlackouts();
$("beliefView").onclick = () => {
  view.beliefOf = view.beliefOf === null && view.selected !== null ? view.selected : null;
  $("beliefView").classList.toggle("on", view.beliefOf !== null);
};
for (const [id, key] of [["links", "showLinks"], ["smoke", "showSmoke"], ["clouds", "showClouds"], ["sensors", "showSensors"]] as const) {
  $<HTMLInputElement>(id).onchange = () => ((view as any)[key] = $<HTMLInputElement>(id).checked);
}

canvas.addEventListener("click", (e) => {
  const rect = canvas.getBoundingClientRect();
  const px = ((e.clientX - rect.left) * canvas.width) / rect.width;
  const py = ((e.clientY - rect.top) * canvas.height) / rect.height;
  const { x, y } = renderer.tileAt(px, py);
  const nearest = () => {
    let best: number | null = null;
    let bd = 3;
    for (const d of world.drones) {
      const dd = Math.hypot(d.x - x, d.y - y);
      if (dd < bd) {
        bd = dd;
        best = d.id;
      }
    }
    return best;
  };
  if (tool === "select") {
    view.selected = nearest();
    if (view.beliefOf !== null) view.beliefOf = view.selected;
  } else if (tool === "ignite") world.igniteAt(x, y);
  else if (tool === "blackout") world.addBlackout(x, y, 7);
  else if (tool === "crash") {
    const id = nearest();
    if (id !== null) world.crashDrone(id);
  }
});

// ---------------------------------------------------------------- panels
function updateStats() {
  const m = world.metrics();
  const alive = world.drones.filter((d) => d.alive).length;
  const status = m.villageLost ? `<b class="bad">LOST (t=${m.villageLostAt})</b>` : `<b class="good">safe</b>`;
  const done = m.extinguishedAt >= 0 ? `<b class="good">fire out at t=${m.extinguishedAt}</b>` : `<b>${m.burning} tiles burning</b>`;
  $("stats").innerHTML = `
    <span>Tick</span><b>${m.tick}</b>
    <span>Village</span>${status}
    <span>Fire</span>${done}
    <span>Area burnt</span><b>${m.burnt} tiles</b>
    <span>Drones</span><b>${alive}/${world.drones.length} flying</b>
    <span>Water drops</span><b>${m.waterDropped}</b>
    <span>Base comms</span><b class="${world.baseOnline ? "good" : "bad"}">${world.baseOnline ? "online" : "down"}</b>
    <span>Comms groups</span><b>${world.network.components.length}</b>`;
  drawChart();
}

function drawChart() {
  const c = $<HTMLCanvasElement>("chart");
  const ctx = c.getContext("2d")!;
  ctx.clearRect(0, 0, c.width, c.height);
  const hist = world.history;
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
  ctx.fillStyle = "#9aa0a6";
  ctx.font = "11px sans-serif";
  ctx.fillText("burning (orange) / burnt (grey)", 4, 12);
}

function updateDroneInfo() {
  const el = $("droneInfo");
  if (view.selected === null) {
    el.innerHTML = "Click a drone on the map.";
    return;
  }
  const d = world.drones[view.selected];
  const contacts = world.network.componentOf.get(d.id);
  const mates =
    contacts === undefined
      ? []
      : world.network.components[contacts].filter((id) => id !== d.id).map((id) => (id === BASE_ID ? "base" : `#${id}`));
  const lost = [...d.trackers.entries()].map(([id, tr]) => `#${id} (±${tr.spread().toFixed(1)})`);
  const rows = d.lastScores
    .map((s) => `<tr><td>${s.zone === d.zone ? "▶ " : ""}${s.zone}</td><td>${s.score.toFixed(2)}</td><td>${s.taken.toFixed(2)}</td></tr>`)
    .join("");
  el.innerHTML = `
    <div class="stats">
      <span>Drone</span><b>#${d.id} — ${d.state}</b>
      <span>Battery</span><b>${Math.round(d.battery * 100)}%</b>
      <span>Damage</span><b>${Math.round(d.damage * 100)}%</b>
      <span>Water</span><b>${d.water.toFixed(1)} / ${world.cfg.waterCapacity}</b>
      <span>Can reach</span><b>${mates.length ? mates.join(", ") : "nobody"}</b>
      <span>Guessing</span><b>${lost.length ? lost.join(", ") : "—"}</b>
    </div>
    ${
      world.cfg.mode === "central"
        ? `<p class="hint">Central mode: follows base's orders (${d.orders ? "zone " + d.orders.zone : "none"}).</p>`
        : `<table><tr><th>Zone</th><th>Bid</th><th>Already taken by</th></tr>${rows}</table>
           <p class="hint">"Already taken" counts teammates with better bids, plus a probability for out-of-contact teammates the drone thinks are still there.</p>`
    }`;
}

// ---------------------------------------------------------------- loop
let frame = 0;
function loop() {
  if (playing && !world.finished) {
    const steps = Number($<HTMLInputElement>("speed").value);
    for (let k = 0; k < steps; k++) world.step();
    if (world.cfg.windDrift && frame % 10 === 0) syncWindSliders();
  }
  renderer.draw(view);
  if (frame % 5 === 0) {
    updateStats();
    updateDroneInfo();
    $("rangeVal").textContent = String(world.cfg.commsRange);
  }
  frame++;
  requestAnimationFrame(loop);
}

newRun();
loop();
