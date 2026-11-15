// The radio log: every event on the stream becomes a line of radio traffic, and some of
// them are also spoken (see audio/voice.ts).
import type { SimEvent } from "./events";
import { actionLabel } from "./commands";
import { ALERTS, ALERT_DELIVERY, alertClip, droneClip, droneDelivery, droneLine, type Alert, type DroneCall } from "./lines";
import type { Line } from "./audio/voice";

type Kind = "base" | "drone" | "net" | "judge" | "alert" | "good" | "sys";

export interface LogEntry {
  tick: number;
  who: string;
  kind: Kind;
  text: string;
  /** e.g. "live" / "120 ticks stale": only on the commander's sitreps. */
  stale?: string;
  staleWarn?: boolean;
  src?: string;
}

const MAX_LINES = 120;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

export class RadioLog {
  private lastRoutine = 0;
  private lastAdded: HTMLElement | null = null;
  private lastJudge: { type: string; at: number; p: HTMLElement } | null = null;

  constructor(private el: HTMLElement, private speak: (l: Line) => void) {}

  clear() {
    this.el.textContent = "";
    this.lastRoutine = -Infinity;
    this.lastAdded = null;
    this.lastJudge = null;
  }

  /** Routine calls (refills, scouting) happen constantly: let one through every few seconds. */
  private routine() {
    const now = performance.now();
    if (now - this.lastRoutine < 4000) return false;
    this.lastRoutine = now;
    return true;
  }

  add(e: LogEntry) {
    const stick = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 8;
    const p = document.createElement("p");
    p.className = `line ${e.kind}`;
    p.innerHTML =
      `<span class="t">${String(e.tick).padStart(4, " ")}</span><span class="who">${esc(e.who)}</span>` +
      (e.stale ? `<span class="${e.staleWarn ? "stale" : "src"}">[${esc(e.stale)}]</span> ` : "") +
      esc(e.text) +
      (e.src ? ` <span class="src">· ${esc(e.src)}</span>` : "");
    this.el.append(p);
    this.lastAdded = p;
    while (this.el.childElementCount > MAX_LINES) this.el.firstElementChild!.remove();
    if (stick) this.el.scrollTop = this.el.scrollHeight;
  }

  private drone(e: { tick: number; id: number }, call: DroneCall, priority: number, extra = "") {
    const text = droneLine(e.id, call);
    this.add({ tick: e.tick, who: `D${e.id}`, kind: call === "crashed" ? "alert" : "drone", text: extra ? `${text} ${extra}` : text });
    this.speak({ voice: `drone:${e.id}`, text, clip: droneClip(e.id, call), priority, delivery: droneDelivery(call), key: `drone-${e.id}` });
  }

  private alert(tick: number, a: Alert, kind: Kind) {
    this.add({ tick, who: "BASE", kind, text: ALERTS[a] });
    this.speak({ voice: "dispatcher", text: ALERTS[a], clip: alertClip(a), priority: 3, delivery: ALERT_DELIVERY[a], key: a === "baseOnline" || a === "baseOffline" ? "base-link" : a === "villageLost" || a === "villageThreatened" ? "village" : a });
  }

  /** Turn one event into radio traffic. */
  onEvent(e: SimEvent) {
    switch (e.type) {
      case "runStarted":
        this.add({ tick: e.tick, who: "SYS", kind: "sys", text: `Run started: seed ${e.seed}, ${e.mode}, ${e.drones} drones.` });
        break;
      case "fireSpotted":
        this.add({ tick: e.tick, who: "BASE", kind: "base", text: `New fire on the base map near (${e.x}, ${e.y}).` });
        break;
      case "droneState":
        if (e.to === "toBase") {
          if (e.battery < 0.4) this.drone(e, "lowBattery", 1, `(${Math.round(e.battery * 100)}%)`);
          else if (e.damage > 0.6) this.drone(e, "returning", 1, `(damage ${Math.round(e.damage * 100)}%)`);
          else if (this.routine()) this.add({ tick: e.tick, who: `D${e.id}`, kind: "drone", text: "No fire on my map. Returning to base for an update." });
        } else if (e.to === "refilling") {
          if (this.routine()) this.drone(e, "refilling", 0);
        } else if (e.to === "scouting") {
          if (this.routine()) this.add({ tick: e.tick, who: `D${e.id}`, kind: "drone", text: "No known fire. Scouting ground nobody has seen for a while." });
        }
        break;
      case "droneCrashed":
        this.drone(e, "crashed", 4, `(${e.cause === "fire" ? "fire damage" : e.cause === "battery" ? "battery flat" : "taken out by a judge"} at ${Math.round(e.x)}, ${Math.round(e.y)})`);
        break;
      case "linkLost":
        if (e.scope === "all") this.drone(e, "lostLink", 1);
        else this.add({ tick: e.tick, who: "NET", kind: "net", text: `Drone ${e.id} is out of contact with base.` });
        break;
      case "linkRegained":
        this.add({ tick: e.tick, who: "NET", kind: "net", text: e.scope === "all" ? `Drone ${e.id} is back in the network: maps and plans merged.` : `Drone ${e.id} is back in contact with base.` });
        if (e.scope === "all" && this.routine()) this.drone(e, "rejoined", 1);
        break;
      case "networkSplit":
        this.add({ tick: e.tick, who: "NET", kind: "net", text: `Network split into ${e.groups} groups.` });
        if (e.groups >= 4) this.speak({ voice: "dispatcher", text: ALERTS.networkSplit, clip: alertClip("networkSplit"), priority: 1, delivery: ALERT_DELIVERY.networkSplit, key: "network" });
        break;
      case "networkHealed":
        this.add({ tick: e.tick, who: "NET", kind: "good", text: `Network rejoined: ${e.groups} group${e.groups === 1 ? "" : "s"}.` });
        break;
      case "baseOffline":
        this.alert(e.tick, "baseOffline", "alert");
        break;
      case "baseOnline":
        this.alert(e.tick, "baseOnline", "good");
        break;
      case "towerLost":
        this.add({ tick: e.tick, who: "NET", kind: "alert", text: `Relay tower ${e.id + 1} burnt down at (${e.x}, ${e.y}).` });
        break;
      case "villageThreatened":
        this.alert(e.tick, "villageThreatened", "alert");
        break;
      case "villageLost":
        this.alert(e.tick, "villageLost", "alert");
        break;
      case "fireOut":
        this.alert(e.tick, "fireOut", "good");
        break;
      case "judgeAction": {
        // Dragging a slider fires an action every tick: keep rewriting one line instead of flooding the log.
        const now = performance.now();
        const lj = this.lastJudge;
        if (lj && lj.type === e.action.type && (e.action.type === "wind" || e.action.type === "commsRange") && now - lj.at < 2500 && lj.p === this.lastAdded) {
          lj.p.lastChild!.textContent = actionLabel(e.action) + ".";
          lj.at = now;
          break;
        }
        this.add({ tick: e.tick, who: "JUDGE", kind: "judge", text: actionLabel(e.action) + "." });
        this.lastJudge = { type: e.action.type, at: now, p: this.lastAdded! };
        break;
      }
      case "runFinished":
        this.add({ tick: e.tick, who: "SYS", kind: "sys", text: `Run finished: ${e.burnt} tiles burnt, village ${e.villageLost ? "lost" : "safe"}, ${e.dronesLost} drone${e.dronesLost === 1 ? "" : "s"} lost.` });
        break;
    }
  }
}
