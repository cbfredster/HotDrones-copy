// Worker thread for `npm run experiment -- --workers N`: runs jobs sent by the main thread.
import { parentPort, workerData } from "node:worker_threads";
import { runJob, type Job } from "./experiment-job";

const { baseCfg, sampleEvery } = workerData as { baseCfg: object; sampleEvery: number };
parentPort!.on("message", (job: Job) => parentPort!.postMessage(runJob(job, baseCfg, sampleEvery)));
