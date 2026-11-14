// Scenarios and replays as documents. MongoDB Atlas when MONGODB_URI is set; otherwise a
// local JSON file, so share links and the board still work offline at the demo table.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { MongoClient, type Collection } from "mongodb";
import type { Config } from "../src/sim/config";
import type { RecordedAction } from "../src/sim/judge";
import type { IntegrationStatus } from "./env";

export interface Outcome {
  ticks: number;
  burnt: number;
  villageLost: boolean;
  villageLostAt: number;
  dronesLost: number;
  waterDropped: number;
  extinguishedAt: number;
}

/** A scenario is everything needed to replay a run exactly: config (incl. seed) + recorded judge actions. */
export interface Scenario {
  _id: string; // short id used in ?scenario=<id>
  name: string;
  author: string;
  createdAt: string;
  cfg: Partial<Config>;
  actions: RecordedAction[];
  /** How the same scenario went in every coordination mode (filled in by the challenge runner). */
  outcomes?: Record<string, Outcome>;
  /** Higher = hurt the swarm more. Used to rank the board. */
  hurt?: number;
  report?: string; // Gemini's after-action report on the swarm's run
  status: "queued" | "running" | "done" | "failed";
}

export interface ScenarioStore {
  kind: string;
  status(): IntegrationStatus;
  save(s: Scenario): Promise<void>;
  get(id: string): Promise<Scenario | null>;
  update(id: string, patch: Partial<Scenario>): Promise<void>;
  /** Board order: the scenarios that hurt the swarm most first. */
  board(limit: number): Promise<Scenario[]>;
}

export const newScenarioId = () => randomBytes(5).toString("base64url").replace(/[-_]/g, "x").slice(0, 7).toLowerCase();

const byHurt = (a: Scenario, b: Scenario) => (b.hurt ?? -1) - (a.hurt ?? -1) || b.createdAt.localeCompare(a.createdAt);

export class MongoStore implements ScenarioStore {
  kind = "mongo";
  private col: Collection<Scenario>;
  private lastError = "";

  private constructor(private client: MongoClient, db: string) {
    this.col = client.db(db).collection<Scenario>("scenarios");
  }

  static async connect(url: string, db: string): Promise<MongoStore> {
    const client = new MongoClient(url, { serverSelectionTimeoutMS: 8000 });
    await client.connect();
    const s = new MongoStore(client, db);
    await s.col.createIndex({ hurt: -1, createdAt: -1 });
    return s;
  }

  status(): IntegrationStatus {
    return { on: true, detail: this.lastError ? `MongoDB Atlas · last error: ${this.lastError}` : "MongoDB Atlas: scenarios, replays and the challenge board" };
  }

  private async run<T>(f: () => Promise<T>): Promise<T> {
    try {
      const r = await f();
      this.lastError = "";
      return r;
    } catch (e: any) {
      this.lastError = String(e.message ?? e).slice(0, 120);
      throw e;
    }
  }

  save(s: Scenario) {
    return this.run(async () => void (await this.col.insertOne(s)));
  }
  get(id: string) {
    return this.run(() => this.col.findOne({ _id: id }));
  }
  update(id: string, patch: Partial<Scenario>) {
    return this.run(async () => void (await this.col.updateOne({ _id: id }, { $set: patch })));
  }
  board(limit: number) {
    return this.run(() => this.col.find({}, { projection: { actions: 0 } }).sort({ hurt: -1, createdAt: -1 }).limit(limit).toArray() as Promise<Scenario[]>);
  }
}

export class FileStore implements ScenarioStore {
  kind = "file";
  private items = new Map<string, Scenario>();

  constructor(private path: string, private why: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      try {
        for (const s of JSON.parse(readFileSync(path, "utf8")) as Scenario[]) this.items.set(s._id, s);
      } catch {
        /* a corrupt file just starts empty */
      }
    }
  }

  status(): IntegrationStatus {
    return { on: false, detail: `${this.why}: scenarios are kept in a local file on this machine (${this.items.size} saved)` };
  }

  private flush() {
    writeFileSync(this.path, JSON.stringify([...this.items.values()], null, 1));
  }
  async save(s: Scenario) {
    this.items.set(s._id, s);
    this.flush();
  }
  async get(id: string) {
    return this.items.get(id) ?? null;
  }
  async update(id: string, patch: Partial<Scenario>) {
    const s = this.items.get(id);
    if (!s) return;
    Object.assign(s, patch);
    this.flush();
  }
  async board(limit: number) {
    return [...this.items.values()].sort(byHurt).slice(0, limit).map(({ actions, ...rest }) => ({ ...rest, actions: [] }));
  }
}
