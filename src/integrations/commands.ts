// Judge commands for the AI commander: the tools Gemini may call, how a tool call becomes a
// JudgeAction, and a tiny offline parser for when Gemini is not connected.
//
// The commander only ever PROPOSES judge actions (the same ones the buttons fire). A human
// confirms each one, and it then goes through applyJudgeAction like everything else. It can
// never steer a drone: the swarm's decisions stay the swarm's.
import type { JudgeAction } from "../sim/judge";
import { angleOfCompass, compassOf, type BaseSnapshot } from "./baseKnowledge";

export interface ProposedAction {
  action: JudgeAction;
  label: string; // shown on the confirm chip
}

/** Tool declarations in the JSON-schema style Gemini function calling expects. */
export const JUDGE_TOOLS = [
  {
    name: "start_fire",
    description: "Ignite a new fire at a map tile. Only grass and forest burn.",
    parameters: {
      type: "OBJECT",
      properties: { x: { type: "INTEGER", description: "tile x, 0 = west edge" }, y: { type: "INTEGER", description: "tile y, 0 = north edge" } },
      required: ["x", "y"],
    },
  },
  {
    name: "place_blackout",
    description: "Place a circular zone where no radio works.",
    parameters: {
      type: "OBJECT",
      properties: { x: { type: "INTEGER" }, y: { type: "INTEGER" }, radius: { type: "INTEGER", description: "tiles, 3 to 15; default 7" } },
      required: ["x", "y"],
    },
  },
  { name: "clear_blackouts", description: "Remove every blackout zone.", parameters: { type: "OBJECT", properties: {} } },
  {
    name: "crash_drone",
    description: "Destroy one drone (to test how the swarm copes).",
    parameters: { type: "OBJECT", properties: { id: { type: "INTEGER", description: "drone number" } }, required: ["id"] },
  },
  {
    name: "set_wind",
    description: "Set the wind. Give the compass direction the wind blows TOWARDS (a 'northerly' or 'wind from the north' blows towards S).",
    parameters: {
      type: "OBJECT",
      properties: {
        blowing_towards: { type: "STRING", enum: ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] },
        speed_percent: { type: "INTEGER", description: "0 to 100" },
      },
      required: ["blowing_towards", "speed_percent"],
    },
  },
  {
    name: "set_base_comms",
    description: "Cut or restore the base's radio.",
    parameters: { type: "OBJECT", properties: { online: { type: "BOOLEAN" } }, required: ["online"] },
  },
  {
    name: "set_comms_range",
    description: "Set every drone's radio range in tiles (4 to 40).",
    parameters: { type: "OBJECT", properties: { range: { type: "INTEGER" } }, required: ["range"] },
  },
] as const;

const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** Turn one tool call into a judge action (validated and clamped), or null if it makes no sense. */
export function toolCallToAction(name: string, args: Record<string, unknown>, map: { width: number; height: number; drones: number }): ProposedAction | null {
  switch (name) {
    case "start_fire": {
      const x = Math.round(num(args.x));
      const y = Math.round(num(args.y));
      if (!(x >= 0 && y >= 0 && x < map.width && y < map.height)) return null;
      return describe({ type: "ignite", x, y });
    }
    case "place_blackout": {
      const x = Math.round(num(args.x));
      const y = Math.round(num(args.y));
      if (!(x >= 0 && y >= 0 && x < map.width && y < map.height)) return null;
      const r = Number.isFinite(num(args.radius)) ? clamp(Math.round(num(args.radius)), 3, 15) : 7;
      return describe({ type: "blackout", x, y, r });
    }
    case "clear_blackouts":
      return describe({ type: "clearBlackouts" });
    case "crash_drone": {
      const id = num(args.id);
      if (!Number.isInteger(id) || id < 0 || id >= map.drones) return null;
      return describe({ type: "crash", id });
    }
    case "set_wind": {
      const angle = angleOfCompass(String(args.blowing_towards ?? ""));
      const speed = num(args.speed_percent);
      if (angle === null || !Number.isFinite(speed)) return null;
      return describe({ type: "wind", angle, speed: clamp(speed, 0, 100) / 100 });
    }
    case "set_base_comms":
      if (typeof args.online !== "boolean") return null;
      return describe({ type: "baseComms", online: args.online });
    case "set_comms_range": {
      const range = num(args.range);
      if (!Number.isFinite(range)) return null;
      return describe({ type: "commsRange", range: clamp(Math.round(range), 4, 40) });
    }
  }
  return null;
}

export function describe(action: JudgeAction): ProposedAction {
  return { action, label: actionLabel(action) };
}

export function actionLabel(a: JudgeAction): string {
  switch (a.type) {
    case "ignite":
      return `Start a fire at (${Math.round(a.x)}, ${Math.round(a.y)})`;
    case "blackout":
      return `Comms blackout at (${Math.round(a.x)}, ${Math.round(a.y)}), radius ${a.r}`;
    case "clearBlackouts":
      return "Clear all blackouts";
    case "crash":
      return `Crash drone ${a.id}`;
    case "wind":
      return `Wind towards ${compassOf(a.angle)} at ${Math.round(a.speed * 100)}%`;
    case "baseComms":
      return a.online ? "Restore base comms" : "Cut base comms";
    case "commsRange":
      return `Comms range ${a.range} tiles`;
    case "smokeBlocksComms":
      return a.on ? "Smoke blocks comms: on" : "Smoke blocks comms: off";
  }
}

/**
 * Offline fallback: understands a handful of fixed phrasings, so the command box still works
 * with no network. e.g. "cut base comms", "crash drone 3", "wind south 80", "fire at 30 22",
 * "fire near the village", "blackout at 20 20", "clear blackouts", "range 8".
 */
export function parseCommandLocally(text: string, s: BaseSnapshot, drones: number): ProposedAction[] {
  const t = text.toLowerCase();
  const map = { width: s.map.width, height: s.map.height, drones };
  const out: (ProposedAction | null)[] = [];
  const coords = /(\d{1,2})\s*[, ]\s*(\d{1,2})/.exec(t);
  const place = (): { x: number; y: number } | null => {
    if (coords) return { x: Number(coords[1]), y: Number(coords[2]) };
    if (/village/.test(t)) return { x: clamp(s.map.village.x - 6, 0, map.width - 1), y: clamp(s.map.village.y - 6, 0, map.height - 1) };
    if (/base/.test(t)) return { x: clamp(s.map.base.x + 5, 0, map.width - 1), y: clamp(s.map.base.y - 5, 0, map.height - 1) };
    if (/cent(re|er)|middle/.test(t)) return { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) };
    return null;
  };
  if (/clear.*blackout/.test(t)) out.push(toolCallToAction("clear_blackouts", {}, map));
  else if (/blackout|jam/.test(t)) {
    const p = place();
    if (p) out.push(toolCallToAction("place_blackout", p, map));
  }
  if (/(restore|fix|bring back).*(base|comms|radio)/.test(t)) out.push(toolCallToAction("set_base_comms", { online: true }, map));
  else if (/(cut|kill|drop|lose).*(base|radio)/.test(t)) out.push(toolCallToAction("set_base_comms", { online: false }, map));
  const crash = /(crash|kill|destroy|down)\s+drone\s+#?(\d+)/.exec(t);
  if (crash) out.push(toolCallToAction("crash_drone", { id: Number(crash[2]) }, map));
  if (/\b(fire|ignite|burn)\b/.test(t) && !/base comms/.test(t)) {
    const p = place();
    if (p) out.push(toolCallToAction("start_fire", p, map));
  }
  const wind = /wind\D*?\b(north[- ]?east|north[- ]?west|south[- ]?east|south[- ]?west|north|south|east|west|ne|nw|se|sw|n|s|e|w)\b\D*(\d{1,3})?/.exec(t);
  if (wind) {
    const dir = wind[1].replace(/[- ]/g, "").replace("north", "N").replace("south", "S").replace("east", "E").replace("west", "W").toUpperCase();
    out.push(toolCallToAction("set_wind", { blowing_towards: dir, speed_percent: wind[2] ? Number(wind[2]) : s.wind.speedPercent }, map));
  }
  const range = /range\D*(\d{1,2})/.exec(t);
  if (range) out.push(toolCallToAction("set_comms_range", { range: Number(range[1]) }, map));
  return out.filter((a): a is ProposedAction => a !== null);
}
