// Live dashboard. Everything on this page is read from the database's aggregates
// (fire_10s, swarm_10s, experiment_1h) through the server. With no database connected the
// live half still works from the server's memory, and says so.
import "./pages.css";
import { INK, MODE_COLOR, MODE_LABEL, lineChart, type Series } from "./charts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const getJson = async (path: string) => {
  try {
    const r = await fetch(path);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};

const FIRE = "#d07a00";
const BLUE = "#22a0c2";
const MODES = ["swarm", "central", "greedy"];
let pickedRun = "";
let pickedSweep = "";

function tile(label: string, value: string, cls = "") {
  const d = document.createElement("div");
  d.className = "tile";
  const s = document.createElement("span");
  s.textContent = label;
  const b = document.createElement("b");
  b.textContent = value;
  if (cls) b.className = cls;
  if (value.length > 9) b.style.fontSize = "15px";
  d.append(s, b);
  return d;
}

function fillSelect(sel: HTMLSelectElement, options: { value: string; label: string }[], current: string) {
  const key = JSON.stringify(options);
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;
  sel.textContent = "";
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    sel.append(opt);
  }
  sel.value = current;
  sel.hidden = options.length < 2;
}

async function refreshLive() {
  const d = await getJson(`/api/dashboard/live${pickedRun ? `?run=${pickedRun}` : ""}`);
  const src = $("source");
  if (!d) {
    src.textContent = "The API server is not reachable (npm run dev starts it).";
    return;
  }
  src.innerHTML = `Reading from: <b></b>`;
  src.querySelector("b")!.textContent = d.source;
  fillSelect(
    $<HTMLSelectElement>("runPick"),
    [{ value: "", label: "Newest live run" }, ...(d.recent ?? []).map((r: any) => ({ value: r.run_id, label: `${new Date(r.started_at).toLocaleTimeString()} · ${r.source} · seed ${r.seed} · ${r.mode}` }))],
    pickedRun,
  );
  const tiles = $("tiles");
  tiles.textContent = "";
  if (!d.run) {
    tiles.append(tile("Status", "Waiting for a run"));
    for (const id of ["chartFire", "chartNet", "chartBattery", "chartSmoke"]) lineChart($(id), { series: [], xLabel: "tick" });
    return;
  }
  const fire: any[] = d.fire;
  const last = fire[fire.length - 1];
  tiles.append(
    tile("Run", `seed ${d.run.seed} · ${MODE_LABEL[d.run.mode] ?? d.run.mode}`),
    tile("Tick", last ? String(last.tick) : "0"),
    tile("Burning now", last ? Math.round(last.burning).toString() : "0"),
    tile("Area burnt", last ? String(last.burnt) : "0"),
    tile("Radio groups", last ? (+last.comms_groups).toFixed(1) : "1", last && last.comms_groups > 1.5 ? "bad" : "good"),
    tile("Drones flying", last ? `${last.drones_alive} / ${d.run.drones}` : String(d.run.drones)),
    tile("Village", d.run.finished ? (d.run.village_lost ? "Lost" : "Safe") : "Run in progress", d.run.finished ? (d.run.village_lost ? "bad" : "good") : ""),
  );

  // Spans where the base radio was mostly down.
  const spans: { from: number; to: number; label: string }[] = [];
  let open: number | null = null;
  for (const f of fire) {
    if (f.base_online < 0.5 && open === null) open = f.tick;
    if (f.base_online >= 0.5 && open !== null) {
      spans.push({ from: open, to: f.tick, label: "base offline" });
      open = null;
    }
  }
  if (open !== null && last) spans.push({ from: open, to: last.tick, label: "base offline" });

  lineChart($("chartFire"), {
    xLabel: "tick",
    spans,
    series: [
      { name: "Burning now", color: FIRE, points: fire.map((f) => ({ x: f.tick, y: f.burning })) },
      { name: "Burnt so far", color: INK.dim, points: fire.map((f) => ({ x: f.tick, y: f.burnt })) },
    ],
  });
  lineChart($("chartNet"), { xLabel: "tick", spans, yMax: Math.max(4, Math.ceil(Math.max(...fire.map((f) => f.comms_groups)))), series: [{ name: "Radio groups", color: BLUE, points: fire.map((f) => ({ x: f.tick, y: f.comms_groups })) }] });
  lineChart($("chartSmoke"), { xLabel: "tick", series: [{ name: "Thick smoke", color: INK.dim, points: fire.map((f) => ({ x: f.tick, y: f.thick_smoke })) }] });
  const sw: any[] = d.swarm;
  lineChart($("chartBattery"), {
    xLabel: "tick",
    yMax: 1,
    yFormat: (v) => `${Math.round(v * 100)}%`,
    series: [{ name: "Average", color: BLUE, band: true, points: sw.map((s) => ({ x: s.tick, y: s.battery_avg, lo: s.battery_min, hi: s.battery_max })) }],
  });
}

async function refreshExperiments() {
  const d = await getJson(`/api/dashboard/experiments${pickedSweep ? `?sweep=${encodeURIComponent(pickedSweep)}` : ""}`);
  const note = $("expSource");
  if (!d || !d.rows?.length) {
    note.textContent = d?.source === "none" ? "Connect Tiger Data (TIGER_DATABASE_URL), then run  npm run experiment -- --db  to fill this in while the sweep runs." : "No experiment runs in the database yet: run  npm run experiment -- --db";
    for (const id of ["chartBurnt", "chartLost"]) lineChart($(id), { series: [], xLabel: "" });
    $("expTable").textContent = "";
    return;
  }
  note.innerHTML = `Reading from: <b></b> · sweep <code></code>`;
  note.querySelector("b")!.textContent = d.source;
  note.querySelector("code")!.textContent = d.sweepId;
  fillSelect($<HTMLSelectElement>("sweepPick"), d.sweeps.map((s: any) => ({ value: s.sweep_id, label: `${s.sweep_id} · ${s.runs} runs` })), pickedSweep || d.sweepId);

  const range = d.rows.filter((r: any) => r.experiment === "range");
  const ranges: number[] = [...new Set<number>(range.map((r: any) => r.comms_range))].sort((a, b) => a - b);
  const cats = ranges.map((r) => (r >= 200 ? "∞" : String(r)));
  const series = (metric: (r: any) => { y: number; lo?: number; hi?: number }): Series[] =>
    MODES.filter((m) => range.some((r: any) => r.mode === m)).map((m) => ({
      name: MODE_LABEL[m],
      color: MODE_COLOR[m],
      points: ranges.flatMap((rg, i) => {
        const row = range.find((r: any) => r.mode === m && r.comms_range === rg);
        return row ? [{ x: i, ...metric(row) }] : [];
      }),
    }));
  lineChart($("chartBurnt"), { xLabel: "comms range (tiles), worse comms on the left", categories: cats, series: series((r) => ({ y: r.burnt_mean, lo: Math.max(0, r.burnt_mean - 1.96 * r.burnt_se), hi: r.burnt_mean + 1.96 * r.burnt_se })) });
  lineChart($("chartLost"), { xLabel: "comms range (tiles), worse comms on the left", categories: cats, yMax: 1, yFormat: (v) => `${Math.round(v * 100)}%`, series: series((r) => ({ y: r.village_lost_rate })) });

  const table = document.createElement("table");
  table.innerHTML = `<tr><th>Experiment</th><th>Mode</th><th class="num">Comms range</th><th class="num">Runs</th><th class="num">Mean burnt</th><th class="num">± SE</th><th class="num">Village lost</th><th class="num">Drones lost</th></tr>`;
  for (const r of d.rows) {
    const tr = document.createElement("tr");
    const cells = [r.experiment, MODE_LABEL[r.mode] ?? r.mode, r.comms_range >= 200 ? "∞" : r.comms_range, r.n, r.burnt_mean.toFixed(0), r.burnt_se.toFixed(0), `${Math.round(r.village_lost_rate * 100)}%`, r.drones_lost_mean.toFixed(1)];
    cells.forEach((c, i) => {
      const td = document.createElement("td");
      td.textContent = String(c);
      if (i >= 2) td.className = "num";
      tr.append(td);
    });
    table.append(tr);
  }
  $("expTable").replaceChildren(table);
}

$<HTMLSelectElement>("runPick").onchange = (e) => {
  pickedRun = (e.target as HTMLSelectElement).value;
  void refreshLive();
};
$<HTMLSelectElement>("sweepPick").onchange = (e) => {
  pickedSweep = (e.target as HTMLSelectElement).value;
  void refreshExperiments();
};

// Poll, and also refresh shortly after the server says new telemetry has arrived.
let soon: number | null = null;
const refreshSoon = () => {
  if (soon !== null) return;
  soon = window.setTimeout(() => {
    soon = null;
    void refreshLive();
  }, 700);
};
function connect() {
  try {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === "telemetry" || msg.type === "run" || msg.type === "finished") refreshSoon();
      if (msg.type === "finished") void refreshExperiments();
    };
    ws.onclose = () => setTimeout(connect, 4000);
  } catch {
    /* polling still works */
  }
}
connect();
void refreshLive();
void refreshExperiments();
setInterval(() => void refreshLive(), 3000);
setInterval(() => void refreshExperiments(), 8000);
