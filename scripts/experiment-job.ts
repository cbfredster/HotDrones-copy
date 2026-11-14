// One experiment run, shared by the main thread and the worker threads of scripts/experiment.ts.
import { sampleTelemetry, type TelemetrySample } from "../src/integrations/events";
import type { Config, Mode } from "../src/sim/config";
import { World } from "../src/sim/world";

export interface Job {
  index: number; // position in the sweep: results are written in this order whatever finishes first
  experiment: string;
  mode: Mode | "none";
  seed: number;
  extra: Partial<Config>;
}
export interface Row {
  experiment: string;
  mode: string;
  commsRange: number;
  seed: number;
  burnt: number;
  villageLost: number;
  dronesLost: number;
  extinguishedAt: number;
  ticks: number;
}
export interface JobResult {
  index: number;
  row: Row;
  drones: number;
  waterDropped: number;
  samples: TelemetrySample[]; // empty unless telemetry was asked for
}

/** `sampleEvery` > 0: also record telemetry every that many ticks (drones on every 5th sample), for --db. */
export function runJob(job: Job, baseCfg: Partial<Config>, sampleEvery: number): JobResult {
  const w = new World({ ...baseCfg, seed: job.seed, mode: job.mode === "none" ? "swarm" : job.mode, ...(job.mode === "none" ? { droneCount: 0 } : {}), ...job.extra });
  const samples: TelemetrySample[] = [];
  let m;
  if (sampleEvery > 0) {
    // Sampling only reads the world, so the run is identical with or without it.
    while (!w.finished) {
      w.step();
      if (w.tick % sampleEvery === 0) samples.push(sampleTelemetry(w, w.tick % (sampleEvery * 5) === 0));
    }
    m = w.metrics();
  } else m = w.runToEnd();
  return {
    index: job.index,
    drones: w.drones.length,
    waterDropped: m.waterDropped,
    samples,
    row: { experiment: job.experiment, mode: job.mode, commsRange: w.cfg.commsRange, seed: job.seed, burnt: m.burnt, villageLost: m.villageLost ? 1 : 0, dronesLost: m.dronesLost, extinguishedAt: m.extinguishedAt, ticks: m.tick },
  };
}
