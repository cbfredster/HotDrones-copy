// Tiger Data (Tiger Cloud: Postgres + TimescaleDB): our live database.
// Used by the server (live runs from the browser) and by `npm run experiment -- --db`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { RunInfo, RunResult, SimEvent, TelemetrySample } from "../src/integrations/events";
import type { IntegrationStatus } from "./env";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Anything with a pg-style query(): a pg.Pool, or PGlite in the tests. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export class Tiger {
  timescale = false;
  ready = false;
  lastError = "";
  private pool: pg.Pool | null = null;

  constructor(private db: Queryable, pool?: pg.Pool) {
    this.pool = pool ?? null;
  }

  static async connect(url: string | undefined): Promise<Tiger | null> {
    if (!url) return null;
    const needsSsl = !/localhost|127\.0\.0\.1|sslmode=disable/.test(url);
    // Strip SSL settings from the URL and pass them as an option instead. In the URL, pg treats
    // sslmode=require as verify-full, which fails ("self-signed certificate in certificate chain")
    // on networks that intercept TLS, such as university or venue Wi-Fi. The link is still encrypted.
    const connectionString = needsSsl ? stripSslParams(url) : url;
    const pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 8000, ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
    pool.on("error", (e) => console.warn("[tiger] pool error:", e.message));
    const t = new Tiger(pool, pool);
    try {
      await t.migrate();
    } catch (e: any) {
      t.lastError = e.message;
      console.warn("[tiger] could not set up the database:", e.message);
    }
    return t;
  }

  status(): IntegrationStatus {
    if (!this.ready) return { on: false, detail: this.lastError ? `error: ${this.lastError}` : "connecting" };
    return { on: true, detail: this.timescale ? "TimescaleDB: hypertables + continuous aggregates" : "plain Postgres (no TimescaleDB extension): views stand in for the aggregates" };
  }

  /** Apply server/sql/schema.sql. Safe to run on every start. */
  async migrate() {
    try {
      await this.db.query("CREATE EXTENSION IF NOT EXISTS timescaledb");
    } catch {
      /* not available: plain Postgres */
    }
    const ext = await this.db.query("SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'");
    this.timescale = ext.rows.length > 0;

    const statements = readFileSync(join(HERE, "sql/schema.sql"), "utf8").split(/^-- ;;\s*$/m);
    let fallbackNext = false; // the previous @timescale CREATE TABLE failed: use its @plain twin, then convert it
    for (const raw of statements) {
      const tag = /^-- @(timescale|plain)\s*$/m.exec(raw)?.[1];
      const sql = raw.replace(/^--.*$/gm, "").trim();
      if (!sql) continue;
      if (tag === "plain" && this.timescale && !fallbackNext) continue;
      if (tag === "timescale" && !this.timescale) continue;
      try {
        await this.db.query(sql);
        if (tag === "plain" && fallbackNext) {
          const table = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(sql)?.[1];
          if (table) await this.db.query(`SELECT create_hypertable('${table}', 'time', if_not_exists => true)`);
        }
        fallbackNext = false;
      } catch (e: any) {
        // Older TimescaleDB has no CREATE TABLE ... WITH (tsdb.hypertable): fall back to create_hypertable().
        if (tag === "timescale" && /^CREATE TABLE/i.test(sql)) {
          fallbackNext = true;
          continue;
        }
        fallbackNext = false;
        // Policies and aggregates are best-effort: the app works without them.
        console.warn(`[tiger] skipped: ${sql.slice(0, 70).replace(/\s+/g, " ")}… (${e.message})`);
      }
    }
    this.ready = true;
    this.lastError = "";
  }

  // ---------------------------------------------------------------- writes
  async startRun(r: RunInfo) {
    await this.db.query(
      `INSERT INTO runs (run_id, started_at, source, experiment, sweep_id, seed, mode, comms_range, drones, config)
       VALUES ($1, to_timestamp($2::float8 / 1000), $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
       ON CONFLICT (run_id) DO NOTHING`,
      [r.runId, r.startedAt, r.source, r.experiment ?? null, r.sweepId ?? null, r.seed, r.mode, r.commsRange, r.drones, JSON.stringify(r.config ?? {})],
    );
  }

  /** Bulk insert with UNNEST: one round trip per table however many rows there are. */
  async insertSamples(runId: string, startedAt: number, samples: TelemetrySample[]) {
    if (!samples.length) return;
    const t0 = startedAt / 1000;
    await this.db.query(
      `INSERT INTO fire_metrics (time, run_id, tick, burning, burnt, thick_smoke, comms_groups, links, base_online, drones_alive)
       SELECT to_timestamp($2::float8 + t), $1::uuid, t, a, b, c, d, e, f, g
       FROM unnest($3::int[], $4::int[], $5::int[], $6::int[], $7::int[], $8::int[], $9::bool[], $10::int[]) AS u(t, a, b, c, d, e, f, g)`,
      [
        runId,
        t0,
        samples.map((s) => s.tick),
        samples.map((s) => s.burning),
        samples.map((s) => s.burnt),
        samples.map((s) => s.thickSmoke),
        samples.map((s) => s.groups),
        samples.map((s) => s.links),
        samples.map((s) => s.baseOnline),
        samples.map((s) => s.dronesAlive),
      ],
    );
    const ticks: number[] = [], ids: number[] = [], xs: number[] = [], ys: number[] = [], alts: number[] = [];
    const states: string[] = [], bats: number[] = [], dmgs: number[] = [], waters: number[] = [];
    for (const s of samples) {
      for (const d of s.drones ?? []) {
        ticks.push(s.tick); ids.push(d.id); xs.push(d.x); ys.push(d.y); alts.push(d.alt);
        states.push(d.state); bats.push(d.battery); dmgs.push(d.damage); waters.push(d.water);
      }
    }
    if (!ticks.length) return;
    await this.db.query(
      `INSERT INTO drone_telemetry (time, run_id, drone_id, x, y, alt, state, battery, damage, water)
       SELECT to_timestamp($2::float8 + t), $1::uuid, id, x, y, alt, st, bat, dmg, wat
       FROM unnest($3::int[], $4::int[], $5::real[], $6::real[], $7::real[], $8::text[], $9::real[], $10::real[], $11::real[])
         AS u(t, id, x, y, alt, st, bat, dmg, wat)`,
      [runId, t0, ticks, ids, xs, ys, alts, states, bats, dmgs, waters],
    );
  }

  async insertEvents(runId: string, startedAt: number, events: SimEvent[]) {
    if (!events.length) return;
    await this.db.query(
      `INSERT INTO events (time, run_id, tick, type, drone_id, data)
       SELECT to_timestamp($2::float8 + t), $1::uuid, t, ty, NULLIF(id, -1), d::jsonb
       FROM unnest($3::int[], $4::text[], $5::int[], $6::text[]) AS u(t, ty, id, d)`,
      [
        runId,
        startedAt / 1000,
        events.map((e) => e.tick),
        events.map((e) => e.type),
        events.map((e) => ("id" in e && typeof e.id === "number" ? e.id : -1)),
        events.map((e) => JSON.stringify(e)),
      ],
    );
  }

  async finishRun(r: RunInfo, m: RunResult) {
    await this.db.query(
      `UPDATE runs SET finished = true, ticks = $2, burnt = $3, village_lost = $4, drones_lost = $5, water_dropped = $6, extinguished_at = $7 WHERE run_id = $1`,
      [r.runId, m.ticks, m.burnt, m.villageLost, m.dronesLost, m.waterDropped, m.extinguishedAt],
    );
    await this.db.query(
      `INSERT INTO run_results (time, run_id, source, experiment, sweep_id, mode, comms_range, seed, burnt, village_lost, drones_lost, ticks)
       VALUES (to_timestamp($2::float8 / 1000), $1, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [r.runId, r.startedAt, r.source, r.experiment ?? "", r.sweepId ?? "", r.mode, r.commsRange, r.seed, m.burnt, m.villageLost ? 1 : 0, m.dronesLost, m.ticks],
    );
  }

  // ---------------------------------------------------------------- reads (dashboard: aggregates only)
  async recentRuns(limit = 12) {
    const r = await this.db.query(
      `SELECT run_id, started_at, source, seed, mode, comms_range, drones, finished, ticks, burnt, village_lost, drones_lost
       FROM runs WHERE source <> 'experiment' ORDER BY started_at DESC LIMIT $1`,
      [limit],
    );
    return r.rows;
  }

  /** The live view: fire growth, connectivity and battery spread for one run (default: the newest live run). */
  async liveRun(runId?: string) {
    const run = runId
      ? (await this.db.query(`SELECT * FROM runs WHERE run_id = $1`, [runId])).rows[0]
      : (await this.db.query(`SELECT * FROM runs WHERE source = 'live' ORDER BY started_at DESC LIMIT 1`)).rows[0];
    if (!run) return null;
    const fire = await this.db.query(
      `SELECT tick, burning::float8, burnt, thick_smoke::float8, comms_groups::float8, links::float8, base_online::float8, drones_alive
       FROM fire_10s WHERE run_id = $1 ORDER BY bucket`,
      [run.run_id],
    );
    const swarm = await this.db.query(
      `SELECT (extract(epoch FROM bucket) - extract(epoch FROM $2::timestamptz))::int AS tick,
              battery_min::float8, battery_avg::float8, battery_max::float8, damage_max::float8, damage_avg::float8, water_avg::float8
       FROM swarm_10s WHERE run_id = $1 ORDER BY bucket`,
      [run.run_id, run.started_at],
    );
    return { run, fire: fire.rows, swarm: swarm.rows };
  }

  /** Experiment comparison from the experiment_1h aggregate (default: the newest sweep). */
  async experiments(sweepId?: string) {
    const sweeps = await this.db.query(
      `SELECT sweep_id, min(bucket) AS started, sum(n)::int AS runs FROM experiment_1h WHERE sweep_id <> '' GROUP BY sweep_id ORDER BY started DESC LIMIT 10`,
    );
    const id = sweepId ?? sweeps.rows[0]?.sweep_id;
    if (!id) return { sweeps: [], sweepId: null, rows: [] };
    const rows = await this.db.query(
      `SELECT experiment, mode, comms_range::float8, sum(n)::int AS n,
              sum(burnt_sum)::float8 / sum(n) AS burnt_mean,
              sum(burnt_sq_sum)::float8 AS burnt_sq, sum(burnt_sum)::float8 AS burnt_sum,
              sum(village_lost_sum)::float8 / sum(n) AS village_lost_rate,
              sum(drones_lost_sum)::float8 / sum(n) AS drones_lost_mean
       FROM experiment_1h WHERE sweep_id = $1 GROUP BY experiment, mode, comms_range ORDER BY experiment, comms_range, mode`,
      [id],
    );
    for (const r of rows.rows) {
      const n = r.n;
      const variance = n > 1 ? Math.max(0, (r.burnt_sq - (r.burnt_sum * r.burnt_sum) / n) / (n - 1)) : 0;
      r.burnt_se = Math.sqrt(variance / n);
      delete r.burnt_sq;
      delete r.burnt_sum;
    }
    return { sweeps: sweeps.rows, sweepId: id, rows: rows.rows };
  }

  /** A compact summary of one run for the after-action report. */
  async runSummary(runId: string) {
    const fire = await this.db.query(`SELECT tick, burning::float8, burnt, comms_groups::float8, base_online::float8, drones_alive FROM fire_10s WHERE run_id = $1 ORDER BY bucket`, [runId]);
    const rows = fire.rows;
    if (!rows.length) return null;
    const peak = rows.reduce((a, b) => (b.burning > a.burning ? b : a));
    const split = rows.reduce((a, b) => (b.comms_groups > a.comms_groups ? b : a));
    const step = Math.max(1, Math.floor(rows.length / 12));
    return {
      peakBurning: { tick: peak.tick, tiles: Math.round(peak.burning) },
      mostFragmented: { tick: split.tick, groups: +split.comms_groups.toFixed(1) },
      baseOnlineShare: +(rows.reduce((s, r) => s + r.base_online, 0) / rows.length).toFixed(2),
      timeline: rows.filter((_, i) => i % step === 0).map((r) => ({ t: r.tick, burning: Math.round(r.burning), burnt: r.burnt, groups: +r.comms_groups.toFixed(1), alive: r.drones_alive })),
    };
  }

  async close() {
    await this.pool?.end();
  }
}

/** Remove sslmode / uselibpqcompat / sslrootcert etc. from a Postgres URL, keeping everything else. */
export function stripSslParams(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (/^ssl|^uselibpqcompat$/i.test(k)) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return url;
  }
}
