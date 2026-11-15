// The AI incident commander (Gemini), browser side.
//
//   - Sitreps: every ~25 s of wall-clock time, or on a major event, the commander writes a
//     short radio report from the BASE's picture only. Each one is labelled with how stale
//     that picture is. Cut base comms and the label climbs: the commander is blind while the
//     swarm fights on. That contrast is the pitch.
//   - Commands: typed or spoken requests become proposed judge actions (function calling),
//     shown as confirm chips. Nothing runs until a human confirms it.
//   - After-action report at the end of a run.
//
// With no Gemini key (or no network) the same UI runs on built-in rules, and says so.
import type { JudgeAction } from "../sim/judge";
import type { World } from "../sim/world";
import { api } from "./api";
import { BaseKnowledge, localSitrep, stalenessLabel, type BaseSnapshot } from "./baseKnowledge";
import { parseCommandLocally, type ProposedAction } from "./commands";
import { digestEvents, type RunInfo, type RunResult, type SimEvent } from "./events";
import type { Line } from "./audio/voice";
import type { LogEntry } from "./radio";

const SITREP_EVERY_MS = 25000;
const MIN_GAP_MS = 7000;
const MAJOR = new Set<SimEvent["type"]>(["baseOffline", "baseOnline", "villageThreatened", "villageLost", "fireOut", "towerLost"]);

export class Commander {
  readonly knowledge = new BaseKnowledge();
  private world: World | null = null;
  private lastSitrep = 0;
  private pending: string | null = null; // reason for a sitrep that is due
  private inFlight = false;
  private keyEvents: SimEvent[] = [];
  private runToken = 0;

  constructor(
    private h: {
      log: (e: LogEntry) => void;
      speak: (l: Line) => void;
      judge: (a: JudgeAction) => boolean;
      chips: HTMLElement;
      tag: HTMLElement;
      onReport: (text: string, source: string) => void;
    },
  ) {
    api.onStatus(() => this.drawTag());
    this.drawTag();
  }

  private drawTag() {
    const on = api.on("gemini");
    this.h.tag.textContent = on ? "Gemini commander" : "built-in commander";
    this.h.tag.classList.toggle("on", on);
    this.h.tag.title = on ? api.status!.gemini.detail : "Gemini is not connected, so sitreps come from built-in rules and commands from a small phrase parser.";
  }

  onRun(world: World) {
    this.world = world;
    this.runToken++;
    this.keyEvents = [];
    this.pending = "start of the incident";
    this.lastSitrep = performance.now() - SITREP_EVERY_MS + 2500; // first report a couple of seconds in
    this.h.chips.textContent = "";
  }

  /** Every tick: keep the base's picture up to date, and note events that deserve a report. */
  onTick(world: World, events: readonly SimEvent[]) {
    this.knowledge.update(world, events);
    for (const e of events) {
      if (e.type !== "droneState" && e.type !== "waterDrop" && this.keyEvents.length < 600) this.keyEvents.push(e);
      if (MAJOR.has(e.type)) this.pending = e.type;
      if (e.type === "droneCrashed" && world.baseOnline) this.pending = `drone ${e.id} lost`;
    }
  }

  /** Every frame (cheap): fire off a sitrep when one is due. Never blocks. */
  frame(world: World, playing: boolean) {
    if (this.inFlight || world !== this.world) return;
    const now = performance.now();
    const due = playing && !world.finished && now - this.lastSitrep > SITREP_EVERY_MS;
    const urgent = this.pending !== null && now - this.lastSitrep > MIN_GAP_MS;
    if (!due && !urgent) return;
    const reason = this.pending ?? "routine update";
    this.pending = null;
    this.lastSitrep = now;
    void this.sitrep(world, reason);
  }

  private async sitrep(world: World, reason: string) {
    this.inFlight = true;
    const token = this.runToken;
    const snap = this.knowledge.snapshot(world);
    let text: string | null = null;
    let src = "built-in";
    try {
      if (api.on("gemini")) {
        const r = await api.postJson<{ text: string }>("/api/commander/sitrep", { snapshot: snap, trigger: reason }, 12000);
        if (r?.text) {
          text = r.text;
          src = "Gemini";
        }
      }
    } finally {
      this.inFlight = false;
    }
    if (token !== this.runToken) return; // a new run started while we were waiting
    text ??= localSitrep(snap);
    // The label is computed here, not by the model: staleness must never be made up.
    const now = this.knowledge.snapshot(world);
    this.h.log({ tick: world.tick, who: "CMDR", kind: "base", text, stale: stalenessLabel(now), staleWarn: now.staleTicks > 0, src });
    this.h.speak({ voice: "dispatcher", text, priority: 2, key: "sitrep" });
  }

  // ---------------------------------------------------------------- judge commands
  async command(text: string) {
    const world = this.world;
    if (!world || !text.trim()) return;
    this.h.log({ tick: world.tick, who: "JUDGE", kind: "judge", text: `“${text.trim()}”` });
    const snap: BaseSnapshot = this.knowledge.snapshot(world);
    let reply = "";
    let actions: ProposedAction[] = [];
    let src = "built-in";
    if (api.on("gemini")) {
      const r = await api.postJson<{ reply: string; actions: ProposedAction[] }>("/api/commander/command", { text, snapshot: snap, drones: world.drones.length }, 15000);
      if (r) {
        reply = r.reply;
        actions = r.actions ?? [];
        src = "Gemini";
      }
    }
    if (src === "built-in") {
      actions = parseCommandLocally(text, snap, world.drones.length);
      if (!actions.length) reply = "Say again? Without Gemini I understand: cut or restore base comms, crash drone N, wind <direction> <percent>, fire at X Y, blackout at X Y, clear blackouts, range N.";
    }
    if (world !== this.world) return;
    if (reply) {
      this.h.log({ tick: world.tick, who: "CMDR", kind: "base", text: reply, src });
      this.h.speak({ voice: "dispatcher", text: reply, priority: 2 });
    }
    for (const a of actions) this.chip(world, a);
  }

  /** A proposed action waits here until a human confirms or dismisses it. */
  private chip(world: World, a: ProposedAction) {
    const el = document.createElement("div");
    el.className = "chip";
    const label = document.createElement("span");
    label.textContent = a.label;
    const yes = document.createElement("button");
    yes.textContent = "Confirm";
    yes.className = "on";
    const no = document.createElement("button");
    no.textContent = "Dismiss";
    yes.onclick = () => {
      el.remove();
      if (world !== this.world) return;
      if (!this.h.judge(a.action)) this.h.log({ tick: world.tick, who: "SYS", kind: "sys", text: `Could not apply: ${a.label}.` });
    };
    no.onclick = () => el.remove();
    el.append(label, yes, no);
    this.h.chips.append(el);
  }

  // ---------------------------------------------------------------- after-action report
  async report(world: World, run: RunInfo, result: RunResult) {
    const token = this.runToken;
    const keyEvents = digestEvents(this.keyEvents, 50);
    let text: string | null = null;
    let source = "built-in summary";
    if (api.on("gemini")) {
      const r = await api.postJson<{ text: string; usedDatabase: boolean }>("/api/commander/report", { runId: run.runId, run: { seed: run.seed, mode: run.mode, drones: run.drones, commsRange: run.commsRange }, result, keyEvents }, 25000);
      if (r?.text) {
        text = r.text;
        source = r.usedDatabase ? "Gemini, from the event log and Tiger Data" : "Gemini, from the event log";
      }
    }
    if (token !== this.runToken) return;
    text ??= this.localReport(world, result);
    this.h.onReport(text, source);
    this.h.log({ tick: world.tick, who: "CMDR", kind: "base", text: `After-action: ${text}`, src: source });
  }

  private localReport(world: World, r: RunResult) {
    const ev = this.keyEvents;
    const count = (t: SimEvent["type"]) => ev.filter((e) => e.type === t).length;
    const judge = count("judgeAction");
    const out = r.extinguishedAt >= 0;
    return (
      `${world.cfg.mode === "swarm" ? "The swarm" : world.cfg.mode === "cbba" ? "The CBBA swarm" : world.cfg.mode === "unified" ? "The unified-stack swarm" : world.cfg.mode === "central" ? "Central control" : "The uncoordinated drones"} ${out ? `put the fire out in ${r.extinguishedAt} ticks` : `did not put the fire out in ${r.ticks} ticks`}; ` +
      `${r.burnt} tiles burned and the village was ${r.villageLost ? "lost" : "saved"}. ` +
      `${r.dronesLost} of ${world.drones.length} drones were lost and ${r.waterDropped} loads of water were dropped. ` +
      `The network split ${count("networkSplit")} time${count("networkSplit") === 1 ? "" : "s"}, ${count("linkLost")} link losses were reported` +
      `${count("baseOffline") ? ", and the base radio went down" : ""}. ` +
      `${judge ? `Judges intervened ${judge} time${judge === 1 ? "" : "s"}.` : "No judge intervened."}`
    );
  }
}
