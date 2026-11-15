// The fixed radio lines. One catalogue, used twice: the browser plays them (radio.ts) and
// `npm run audio:generate` pre-records them with ElevenLabs so they need no network later.

import type { Delivery } from "./audio/profiles";

export const DRONE_CALLS = ["lowBattery", "returning", "refilling", "lostLink", "rejoined", "crashed"] as const;
export type DroneCall = (typeof DRONE_CALLS)[number];

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "niner", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen"];
export const callsign = (id: number) => `Drone ${NUMBER_WORDS[id] ?? id}`;

export function droneLine(id: number, call: DroneCall): string {
  const me = callsign(id);
  switch (call) {
    case "lowBattery":
      return `${me}, battery low. Returning to base.`;
    case "returning":
      return `${me}, returning to base.`;
    case "refilling":
      return `${me}, refilling.`;
    case "lostLink":
      return `${me}, lost link. Continuing on my own plan.`;
    case "rejoined":
      return `${me}, link restored. Sharing my map with the swarm.`;
    case "crashed":
      return `Mayday, mayday. ${me} going down.`;
  }
}
export const droneClip = (id: number, call: DroneCall) => `d${id}-${call}`;
export const droneDelivery = (call: DroneCall): Delivery => call === "crashed" ? "urgent" : call === "rejoined" ? "relieved" : "calm";

/** Dispatcher alerts with fixed wording (Gemini's sitreps are generated live instead). */
export const ALERTS = {
  baseOffline: "All units, base radio is down. You are on your own. Keep working the fire.",
  baseOnline: "Base radio restored. All units, report in.",
  villageThreatened: "Warning. Fire is closing on the village.",
  villageLost: "Fire has reached the village.",
  fireOut: "All units, the fire is out. Good work. Return to base.",
  networkSplit: "Network is splitting. Units out of contact, hold to your last plan.",
} as const;
export type Alert = keyof typeof ALERTS;
export const alertClip = (a: Alert) => `base-${a}`;
export const ALERT_DELIVERY: Record<Alert, Delivery> = {
  baseOffline: "urgent", baseOnline: "relieved", villageThreatened: "urgent",
  villageLost: "urgent", fireOut: "relieved", networkSplit: "calm",
};

/** A short cast audition that works without changing or starting the simulation. */
export const RADIO_CHECK = [
  { voice: "dispatcher", text: "Base to all units. Radio check. Ready to work the fire.", clip: "check-base", priority: 2, delivery: "calm" },
  { voice: "drone:0", text: "Drone zero. Loud and clear.", clip: "check-d0", priority: 2, delivery: "calm" },
  { voice: "drone:1", text: "Drone one. Ready for dispatch.", clip: "check-d1", priority: 2, delivery: "calm" },
  { voice: "drone:2", text: "Drone two. Standing by.", clip: "check-d2", priority: 2, delivery: "calm" },
] as const;
