// Browser app: wires the controls to the simulation and draws it with the isometric
// renderer. The sim itself lives in src/sim and never imports anything from here.
import "./style.css";
import { IsoRenderer, IsoViewOptions, PickResult } from "./render/iso";
import { Config, Mode } from "./sim/config";
import { JudgeAction, RecordedAction, ReplayCursor, applyJudgeAction } from "./sim/judge";
import { World } from "./sim/world";
import { $, input, isTyping } from "./ui/dom";
import { RunOverlays } from "./ui/endcard";
import { Minimap } from "./ui/minimap";
import { updateSelection, updateStats } from "./ui/panels";

// The old loop ran 1-12 whole ticks per animation frame. 720 ticks/s is that maximum at
// 60 fps; the slider now also goes far below one tick per frame, which is what makes the
// 3D view watchable.
const MIN_TPS = 2;
const MAX_TPS = 720;
const MAX_STEPS_PER_FRAME = 24;
const STEP_BUDGET_MS = 14;
const SELECT_RADIUS = 2; // a click this close (tiles) to a drone selects it rather than the tile
const BLACKOUT_RADIUS = 7;

type Tool = "select" | "ignite" | "blackout" | "crash";

let world: World;
let iso: IsoRenderer;
let replay: ReplayCursor | null = null;
let playing = true;
let tool: Tool = "select";
let inspected: number | null = null; // tile shown in the inspector
let acc = 0; // fraction of the next tick already "owed"
let shownAlpha = 1;
const view: IsoViewOptions = {
  beliefOf: null,
  selected: null,
  showLinks: true,
  showSmoke: true,
  showClouds: true,
  showSensors: true,
  hoverRadius: 0,
};

const stage = $("stage");
const minimap = new Minimap($<HTMLCanvasElement>("minimap"), $<HTMLButtonElement>("minimapMode"), (x, y) => iso.focus(x, y));
const overlays = new RunOverlays({
  replay: () => startRun(world.initialCfg, structuredClone(world.judgeLog)),
  newSeed: () => {
    input("seed").value = String(world.cfg.seed + 1);
    newRunFromControls();
  },
});

// ---------------------------------------------------------------- runs
/** Start a run. With `actions`, every recorded judge action is re-applied at its original tick. */
function startRun(cfg: Partial<Config>, actions?: RecordedAction[]) {
  world = new World(cfg);
  replay = actions && actions.length ? new ReplayCursor(actions) : null;
  if (!iso) {
    iso = new IsoRenderer(stage, world);
    iso.onClick = onMapClick;
  } else {
    iso.setWorld(world);
  }
  minimap.setWorld(world);
  overlays.reset();
  view.selected = null;
  view.beliefOf = null;
  inspected = null;
  acc = 0;
  shownAlpha = 1;
  $("beliefView").classList.remove("on");
  input("seed").value = String(world.cfg.seed);
  $<HTMLSelectElement>("mode").value = world.cfg.mode;
  syncControls(true);
  // Handy in the browser console, and used by the headless checks.
  Object.assign(window as any, { world, view, iso, hot: { stepOnce, judge, setPlaying, setTps } });
}

function newRunFromControls() {
  startRun({
    seed: Number(input("seed").value) || 1,
    mode: $<HTMLSelectElement>("mode").value as Mode,
    commsRange: Number(input("range").value),
    smokeBlocksComms: input("smokeComms").checked,
  });
}

/** The single path for judge writes: applies the action and records it with its tick. */
function judge(action: JudgeAction) {
  return applyJudgeAction(world, action);
}

function stepOnce() {
  if (world.finished) return;
  replay?.applyDue(world);
  world.step();
  iso.onTick();
}

// ---------------------------------------------------------------- controls
/** Reflect world state in the controls (wind drifts; replays change things on their own). */
function syncControls(force = false) {
  const set = (id: string, value: string) => {
    const el = input(id);
    if (!force && el.matches(":active")) return; // don't fight a slider that is being dragged
    if (el.value !== value) el.value = value;
  };
  const deg = ((world.env.wind.angle * 180) / Math.PI + 3600) % 360;
  set("windAngle", String(Math.round(deg)));
  set("windSpeed", String(Math.round(world.env.wind.speed * 100)));
  set("range", String(world.cfg.commsRange));
  $("rangeVal").textContent = String(world.cfg.commsRange);
  input("smokeComms").checked = world.cfg.smokeBlocksComms;
  const cut = world.base.manualOutage;
  $("baseOutage").classList.toggle("on", cut);
  $("baseOutage").textContent = cut ? "Restore base comms" : "Cut base comms";
}

function setPlaying(p: boolean) {
  playing = p;
  $("play").textContent = playing ? "Pause" : "Play";
  $("play").classList.toggle("on", playing);
}

let tps = 20;
function setTps(v: number) {
  tps = Math.max(MIN_TPS, Math.min(MAX_TPS, Math.round(v)));
  $("tpsVal").textContent = String(tps);
  // The slider is logarithmic: most of its travel is in the watchable 2-60 range.
  input("speed").value = String(Math.round((100 * Math.log(tps / MIN_TPS)) / Math.log(MAX_TPS / MIN_TPS)));
}
const tpsFromSlider = () => MIN_TPS * Math.pow(MAX_TPS / MIN_TPS, Number(input("speed").value) / 100);

function setTool(t: Tool) {
  tool = t;
  stage.dataset.tool = t;
  view.hoverRadius = t === "blackout" ? BLACKOUT_RADIUS : 0;
  document.querySelectorAll<HTMLButtonElement>("#tools button").forEach((b) => b.classList.toggle("on", b.dataset.tool === t));
}

function toggleBelief() {
  view.beliefOf = view.beliefOf === null && view.selected !== null ? view.selected : null;
  $("beliefView").classList.toggle("on", view.beliefOf !== null);
}

function select(drone: number | null, tile: number | null) {
  view.selected = drone;
  inspected = drone === null ? tile : null;
  if (view.beliefOf !== null) {
    view.beliefOf = view.selected; // the belief view follows the selection (and ends with it)
    $("beliefView").classList.toggle("on", view.beliefOf !== null);
  }
  updateSelection(world, view.selected, inspected); // respond to the click now, not on the next panel refresh
}

$("reset").onclick = newRunFromControls;
$("mode").onchange = newRunFromControls;
$("play").onclick = () => setPlaying(!playing);
$("step").onclick = () => {
  setPlaying(false);
  stepOnce();
  shownAlpha = 0; // animate the single tick instead of jumping
};
input("speed").oninput = () => setTps(tpsFromSlider());
for (const b of document.querySelectorAll<HTMLButtonElement>("#tools button")) b.onclick = () => setTool(b.dataset.tool as Tool);

const windFromSliders = () =>
  judge({ type: "wind", angle: (Number(input("windAngle").value) * Math.PI) / 180, speed: Number(input("windSpeed").value) / 100 });
input("windAngle").oninput = windFromSliders;
input("windSpeed").oninput = windFromSliders;
input("range").oninput = () => {
  judge({ type: "commsRange", range: Number(input("range").value) });
  $("rangeVal").textContent = String(world.cfg.commsRange);
};
input("smokeComms").onchange = () => judge({ type: "smokeBlocksComms", on: input("smokeComms").checked });
$("baseOutage").onclick = () => {
  judge({ type: "baseComms", online: world.base.manualOutage }); // toggle
  syncControls(true);
};
$("clearBlackouts").onclick = () => judge({ type: "clearBlackouts" });
$("beliefView").onclick = toggleBelief;
for (const [id, key] of [["links", "showLinks"], ["smoke", "showSmoke"], ["clouds", "showClouds"], ["sensors", "showSensors"]] as const) {
  input(id).onchange = () => (view[key] = input(id).checked);
}
$("camLeft").onclick = () => iso.rotate(-1);
$("camRight").onclick = () => iso.rotate(1);
$("camReset").onclick = () => iso.resetCamera();

// Mouse clicks leave focus on the button; drop it so Space keeps meaning play/pause.
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (e.detail > 0 && t.closest("button")) (t.closest("button") as HTMLElement).blur();
});

window.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
  if ((e.target as HTMLElement)?.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
  switch (e.key.toLowerCase()) {
    case " ":
      e.preventDefault();
      setPlaying(!playing);
      break;
    case ".":
      $("step").click();
      break;
    case "q":
      iso.rotate(-1);
      break;
    case "e":
      iso.rotate(1);
      break;
    case "r":
      iso.resetCamera();
      break;
    case "b":
      toggleBelief();
      break;
    case "1":
      setTool("select");
      break;
    case "2":
      setTool("ignite");
      break;
    case "3":
      setTool("blackout");
      break;
    case "4":
      setTool("crash");
      break;
    case "escape":
      select(null, null);
      setTool("select");
      break;
  }
});

/** A click on the map: same tool logic as the 2D app, fed by the 3D picker. */
function onMapClick(hit: PickResult) {
  // Prefer the drone under the cursor; otherwise the nearest one to the clicked tile.
  const nearDrone = (): number | null => {
    if (hit.drone !== null) return hit.drone;
    if (hit.tile === null) return null;
    let best: number | null = null;
    let bd = SELECT_RADIUS;
    for (const d of world.drones) {
      const dd = Math.hypot(d.x - hit.x, d.y - hit.y);
      if (dd < bd) {
        bd = dd;
        best = d.id;
      }
    }
    return best;
  };
  if (tool === "select") {
    select(nearDrone(), hit.tile);
  } else if (tool === "crash") {
    const id = nearDrone();
    if (id !== null) judge({ type: "crash", id });
  } else if (hit.tile !== null) {
    if (tool === "ignite") judge({ type: "ignite", x: hit.x, y: hit.y });
    else if (tool === "blackout") judge({ type: "blackout", x: hit.x, y: hit.y, r: BLACKOUT_RADIUS });
  }
}

// ---------------------------------------------------------------- frame loop
function updateHud() {
  const wind = world.env.wind;
  const ang = iso.screenAngle(Math.cos(wind.angle), Math.sin(wind.angle));
  const scale = 0.55 + 0.45 * wind.speed;
  $("compassArrow").setAttribute("transform", `rotate(${((ang * 180) / Math.PI).toFixed(1)}) scale(${scale.toFixed(2)})`);
  $("compassSpeed").textContent = `${Math.round(wind.speed * 100)}%`;

  const badge = $("viewBadge");
  if (view.beliefOf !== null) {
    badge.hidden = false;
    badge.innerHTML = `Viewing drone #${view.beliefOf}'s own map <small>· darker = older information</small>`;
  } else if (replay && !replay.done) {
    badge.hidden = false;
    badge.innerHTML = `Replay <small>· ${replay.remaining} recorded judge action${replay.remaining > 1 ? "s" : ""} still to come</small>`;
  } else {
    badge.hidden = true;
  }
}

let last = performance.now();
let frame = 0;
let fps = 60;
function loop(now: number) {
  const dt = Math.min(0.25, Math.max(0.001, (now - last) / 1000));
  last = now;
  fps += (1 / dt - fps) * 0.05;

  if (playing && !world.finished) {
    acc += dt * tps;
    const deadline = performance.now() + STEP_BUDGET_MS;
    let n = 0;
    while (acc >= 1 && n < MAX_STEPS_PER_FRAME && !world.finished && performance.now() < deadline) {
      stepOnce();
      acc -= 1;
      n++;
    }
    if (acc > 1) acc = 1; // fell behind: drop the backlog instead of spiralling
    shownAlpha = Math.min(1, acc);
  } else {
    shownAlpha = Math.min(1, shownAlpha + dt * 5); // settle on the exact current state
  }

  iso.draw(view, shownAlpha);

  if (frame % 2 === 0) updateHud();
  if (frame % 3 === 0) minimap.draw(view);
  if (frame % 6 === 0) {
    updateStats(world);
    updateSelection(world, view.selected, inspected);
    overlays.update(world);
    syncControls();
    $("tickVal").textContent = String(world.tick);
    const s = iso.stats();
    $("perf").textContent = `${Math.round(fps)} fps · ${s.calls} draw calls · ${(s.triangles / 1000).toFixed(0)}k tris`;
  }
  frame++;
  requestAnimationFrame(loop);
}

setTps(20);
setTool("select");
newRunFromControls();
requestAnimationFrame(loop);
