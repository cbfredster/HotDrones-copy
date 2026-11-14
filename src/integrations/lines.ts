// The fixed radio lines. One catalogue, used twice: the browser plays them (radio.ts) and
// `npm run audio:generate` pre-records them with ElevenLabs so they need no network later.

export const DRONE_CALLS = ["lowBattery", "returning", "refilling", "lostLink", "crashed"] as const;
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
    case "crashed":
      return `Mayday, mayday. ${me} going down.`;
  }
}
export const droneClip = (id: number, call: DroneCall) => `d${id}-${call}`;

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
