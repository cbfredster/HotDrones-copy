// Headless experiment runner: the same simulation code as the browser, no graphics.
// Runs every coordination mode over many seeds and comms conditions, then writes
//   results/runs.csv     one row per run
//   results/summary.csv  averages per condition
//   results/report.html  charts for the pitch
//
// Usage: npm run experiment -- [seeds=30] [--legacy] [--out <dir>] [--workers N] [--db]
//   --legacy     switch off everything added since the 2D version (legacyConfig). The output
//                must then match BASIC/results/summary.csv exactly: `npm run experiment:legacy-check`.
//   --out        where to write (default: results, or results/legacy with --legacy)
//   --workers N  run on N worker threads (the files written are identical to a single-threaded run)
//   --db         also stream every run into Tiger Data (TIGER_DATABASE_URL in .env), downsampled
//                to one row every 10 ticks, so dashboard.html fills in while the sweep runs
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { RunInfo } from "../src/integrations/events";
import { Mode, legacyConfig, type Config } from "../src/sim/config";
import { runJob, type Job, type JobResult, type Row } from "./experiment-job";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const LEGACY = flag("--legacy");
const OUT = option("--out") ?? (LEGACY ? "results/legacy" : "results");
const SEEDS = Number(args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== "--out" && args[i - 1] !== "--workers")) || 30;
const WORKERS = flag("--workers") ? Math.max(1, Math.min(64, Number(option("--workers")) || availableParallelism())) : 1;
const DB = flag("--db");
const DB_SAMPLE_EVERY = 10; // ticks between telemetry rows sent to the database
const BASE_CFG: Partial<Config> = LEGACY ? legacyConfig : {};
// CBBA is new since the 2D version, so the --legacy run (which must match BASIC/ exactly) leaves it out.
const MODES: Mode[] = LEGACY ? ["swarm", "central", "greedy"] : ["swarm", "cbba", "unified", "central", "greedy"];
const RANGES = [6, 8, 11, 14, 20, 30, 200];

// ------------------------------------------------------------------ the sweep, as a list of jobs
const jobs: Job[] = [];
const add = (experiment: string, mode: Mode | "none", seed: number, extra: Partial<Config>) => jobs.push({ index: jobs.length, experiment, mode, seed, extra });
// Experiment 1: how does each approach cope as comms get worse?
for (const range of RANGES) for (const mode of MODES) for (let s = 1; s <= SEEDS; s++) add("range", mode, s, { commsRange: range, baseCommsRange: Math.max(range, 12) * 1.4 });
// Experiment 2: base goes offline shortly after the drones launch.
for (const mode of MODES) for (let s = 1; s <= SEEDS; s++) add("baseOutage", mode, s, { baseOutageAt: 120 });
// Reference: no drones at all.
for (let s = 1; s <= SEEDS; s++) add("noDrones", "none", s, {});

// ------------------------------------------------------------------ optional: stream into Tiger Data
const sweepId = `sweep-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}`;
let tiger: import("../server/tiger").Tiger | null = null;
if (DB) {
  const { env } = await import("../server/env");
  const { Tiger } = await import("../server/tiger");
  tiger = await Tiger.connect(env.tigerUrl);
  if (!tiger?.ready) {
    console.error(tiger ? `--db: could not use the database (${tiger.lastError})` : "--db: set TIGER_DATABASE_URL in .env first (see .env.example)");
    process.exit(1);
  }
  console.log(`--db: streaming to ${tiger.status().detail}; sweep id ${sweepId}`);
}
let dbChain: Promise<void> = Promise.resolve();
function store(job: Job, r: JobResult) {
  const t = tiger;
  if (!t) return;
  const samples = r.samples;
  r.samples = []; // taken now, so the results array does not hold every run's telemetry
  const run: RunInfo = { runId: randomUUID(), startedAt: Date.now(), source: "experiment", experiment: job.experiment, sweepId, seed: job.seed, mode: job.mode, commsRange: r.row.commsRange, drones: r.drones, config: job.extra };
  dbChain = dbChain
    .then(async () => {
      await t.startRun(run);
      await t.insertSamples(run.runId, run.startedAt, samples);
      await t.finishRun(run, { ticks: r.row.ticks, burnt: r.row.burnt, villageLost: !!r.row.villageLost, dronesLost: r.row.dronesLost, waterDropped: r.waterDropped, extinguishedAt: r.row.extinguishedAt });
    })
    .catch((e) => console.warn("--db: write failed:", e.message));
}

// ------------------------------------------------------------------ run them
const t0 = Date.now();
const results: JobResult[] = new Array(jobs.length);
const sampleEvery = DB ? DB_SAMPLE_EVERY : 0;
let done = 0;
const progress = () => {
  if (done % Math.max(1, Math.round(jobs.length / 10)) === 0 || done === jobs.length) process.stdout.write(`${done}/${jobs.length} runs (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
};
if (WORKERS <= 1) {
  for (const job of jobs) {
    results[job.index] = runJob(job, BASE_CFG, sampleEvery);
    store(job, results[job.index]);
    done++;
    progress();
    if (DB) await dbChain; // keep memory flat: do not run ahead of the database
  }
} else {
  console.log(`running on ${WORKERS} worker threads`);
  let next = 0;
  await new Promise<void>((resolve, reject) => {
    for (let k = 0; k < Math.min(WORKERS, jobs.length); k++) {
      const worker = new Worker(new URL("./experiment-worker.ts", import.meta.url), { workerData: { baseCfg: BASE_CFG, sampleEvery } });
      const feed = () => (next < jobs.length ? worker.postMessage(jobs[next++]) : void worker.terminate());
      worker.on("message", (r: JobResult) => {
        results[r.index] = r;
        store(jobs[r.index], r);
        done++;
        progress();
        if (done === jobs.length) resolve();
        feed();
      });
      worker.on("error", reject);
      feed();
    }
  });
}
// Rows in sweep order, whatever order the workers finished in: the files are byte-identical.
const rows: Row[] = results.map((r) => r.row);
process.stdout.write(`all runs done (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
if (tiger) {
  await dbChain;
  await tiger.close();
  console.log(`--db: ${jobs.length} runs stored under sweep ${sweepId}`);
}

// ------------------------------------------------------------------ summarise
mkdirSync(OUT, { recursive: true });
const keys = Object.keys(rows[0]) as (keyof Row)[];
writeFileSync(`${OUT}/runs.csv`, [keys.join(","), ...rows.map((r) => keys.map((k) => r[k]).join(","))].join("\n"));

interface Summary {
  experiment: string;
  mode: string;
  commsRange: number;
  n: number;
  burntMean: number;
  burntSe: number; // standard error of the mean
  villageLostRate: number;
  dronesLostMean: number;
}
const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.experiment}|${r.mode}|${r.commsRange}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k)!.push(r);
}
const summary: Summary[] = [];
for (const g of groups.values()) {
  const n = g.length;
  const mean = g.reduce((s, r) => s + r.burnt, 0) / n;
  const sd = Math.sqrt(g.reduce((s, r) => s + (r.burnt - mean) ** 2, 0) / Math.max(1, n - 1));
  summary.push({
    experiment: g[0].experiment,
    mode: g[0].mode,
    commsRange: g[0].commsRange,
    n,
    burntMean: mean,
    burntSe: sd / Math.sqrt(n),
    villageLostRate: g.reduce((s, r) => s + r.villageLost, 0) / n,
    dronesLostMean: g.reduce((s, r) => s + r.dronesLost, 0) / n,
  });
}
const skeys = Object.keys(summary[0]) as (keyof Summary)[];
writeFileSync(
  `${OUT}/summary.csv`,
  [skeys.join(","), ...summary.map((r) => skeys.map((k) => (typeof r[k] === "number" ? +(r[k] as number).toFixed(3) : r[k])).join(","))].join("\n"),
);

console.log("\nComms range sweep (mean tiles burnt ± SE, village lost %):");
for (const range of RANGES) {
  const line = MODES.map((m) => {
    const s = summary.find((x) => x.experiment === "range" && x.mode === m && x.commsRange === range)!;
    return `${m}: ${s.burntMean.toFixed(0)}±${s.burntSe.toFixed(0)} (${(s.villageLostRate * 100).toFixed(0)}%)`;
  });
  console.log(`range ${String(range).padStart(3)} | ${line.join(" | ")}`);
}
console.log("\nBase outage at tick 120:");
for (const m of MODES) {
  const s = summary.find((x) => x.experiment === "baseOutage" && x.mode === m)!;
  console.log(`  ${m}: ${s.burntMean.toFixed(0)}±${s.burntSe.toFixed(0)} burnt, village lost ${(s.villageLostRate * 100).toFixed(0)}%`);
}
const nd = summary.find((x) => x.experiment === "noDrones")!;
console.log(`No drones: ${nd.burntMean.toFixed(0)} burnt, village lost ${(nd.villageLostRate * 100).toFixed(0)}%`);

// ------------------------------------------------------------------ HTML report
const COLOURS: Record<string, string> = { swarm: "#ff9f1c", cbba: "#80ed99", unified: "#ff4d8d", central: "#4cc9f0", greedy: "#b388ff", none: "#9aa0a6" };
const LABELS: Record<string, string> = { swarm: "Swarm (ours)", cbba: "CBBA (ours)", unified: "Unified stack (ours)", central: "Central control", greedy: "No coordination", none: "No drones" };

function lineChart(metric: "burntMean" | "villageLostRate", title: string, yLabel: string, yMax: number) {
  const W = 640;
  const H = 320;
  const L = 60;
  const B = 44;
  const T = 30;
  const R = 150;
  const xs = RANGES.map((_, i) => L + (i * (W - L - R)) / (RANGES.length - 1));
  const y = (v: number) => T + (H - T - B) * (1 - v / yMax);
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif" font-size="12">`;
  svg += `<text x="${L}" y="18" font-size="14" font-weight="600" fill="#e8e6e3">${title}</text>`;
  for (let k = 0; k <= 4; k++) {
    const v = (yMax * k) / 4;
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#2c313a"/>`;
    svg += `<text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" fill="#9aa0a6">${metric === "villageLostRate" ? Math.round(v * 100) + "%" : Math.round(v)}</text>`;
  }
  RANGES.forEach((r, i) => (svg += `<text x="${xs[i]}" y="${H - B + 18}" text-anchor="middle" fill="#9aa0a6">${r === 200 ? "∞" : r}</text>`));
  svg += `<text x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle" fill="#9aa0a6">comms range (tiles) — worse comms on the left</text>`;
  svg += `<text transform="translate(14 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle" fill="#9aa0a6">${yLabel}</text>`;
  MODES.forEach((m, mi) => {
    const pts = RANGES.map((r) => summary.find((x) => x.experiment === "range" && x.mode === m && x.commsRange === r)!);
    if (metric === "burntMean") {
      pts.forEach((p, i) => {
        svg += `<line x1="${xs[i]}" x2="${xs[i]}" y1="${y(p.burntMean - 1.96 * p.burntSe)}" y2="${y(p.burntMean + 1.96 * p.burntSe)}" stroke="${COLOURS[m]}" stroke-opacity="0.5" stroke-width="2"/>`;
      });
    }
    svg += `<polyline fill="none" stroke="${COLOURS[m]}" stroke-width="2.5" points="${pts.map((p, i) => `${xs[i]},${y(p[metric])}`).join(" ")}"/>`;
    pts.forEach((p, i) => (svg += `<circle cx="${xs[i]}" cy="${y(p[metric])}" r="3.5" fill="${COLOURS[m]}"/>`));
    const last = pts[pts.length - 1];
    svg += `<circle cx="${W - R + 16}" cy="${T + 60 + mi * 20}" r="5" fill="${COLOURS[m]}"/><text x="${W - R + 26}" y="${T + 64 + mi * 20}" fill="#e8e6e3">${LABELS[m]}</text>`;
    void last;
  });
  if (metric === "burntMean") {
    svg += `<line x1="${L}" x2="${W - R}" y1="${y(nd.burntMean)}" y2="${y(nd.burntMean)}" stroke="#9aa0a6" stroke-dasharray="5 4"/>`;
    svg += `<text x="${L + 6}" y="${y(nd.burntMean) - 6}" fill="#9aa0a6">no drones</text>`;
  }
  return svg + "</svg>";
}

function outageBars() {
  const W = 640;
  const H = 220;
  const L = 150;
  const max = Math.max(nd.burntMean, ...summary.filter((s) => s.experiment === "baseOutage").map((s) => s.burntMean));
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" font-family="system-ui,sans-serif" font-size="12">`;
  svg += `<text x="10" y="18" font-size="14" font-weight="600" fill="#e8e6e3">Base goes offline at tick 120: tiles burnt (lower is better)</text>`;
  const items = [...MODES.map((m) => summary.find((s) => s.experiment === "baseOutage" && s.mode === m)!), nd];
  items.forEach((s, i) => {
    const y = 36 + i * 44;
    const w = ((W - L - 220) * s.burntMean) / max;
    svg += `<text x="${L - 10}" y="${y + 20}" text-anchor="end" fill="#e8e6e3">${LABELS[s.mode]}</text>`;
    svg += `<rect x="${L}" y="${y}" width="${w}" height="30" rx="4" fill="${COLOURS[s.mode]}"/>`;
    svg += `<text x="${L + w + 8}" y="${y + 20}" fill="#9aa0a6">${s.burntMean.toFixed(0)} burnt · village lost ${(s.villageLostRate * 100).toFixed(0)}%</text>`;
  });
  return svg + "</svg>";
}

const maxBurnt = Math.ceil(nd.burntMean / 500) * 500;
const html = `<!doctype html><html><head><meta charset="utf-8"><title>HotDrones results</title>
<style>body{background:#14161a;color:#e8e6e3;font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:30px auto;padding:0 16px}
h1 span{color:#ff9f1c} .card{background:#1d2026;border:1px solid #2c313a;border-radius:10px;padding:14px;margin:18px 0} p{color:#c9c9c9}</style></head><body>
<h1>Hot<span>Drones</span> — results</h1>
<p>${SEEDS} random maps per condition, same fires for every approach (seeded). Error bars are 95% confidence intervals.</p>
<div class="card">${lineChart("burntMean", "Area burnt as comms get worse (lower is better)", "tiles burnt", maxBurnt)}</div>
<div class="card">${lineChart("villageLostRate", "How often the village is lost", "village lost", 1)}</div>
<div class="card">${outageBars()}</div>
</body></html>`;
writeFileSync(`${OUT}/report.html`, html);
console.log(`\nWrote ${OUT}/runs.csv, ${OUT}/summary.csv, ${OUT}/report.html`);
