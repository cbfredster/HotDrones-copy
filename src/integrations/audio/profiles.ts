// One cast and delivery vocabulary for live speech, offline clips and the radio check.
// These are ElevenLabs' current replacement voices, rather than expiring defaults.
export const DEFAULT_CAST = {
  dispatcher: { id: "BFd5oBc2DDna33pSi4Gf", name: "Alicia" },
  drones: [
    { id: "jSuBIjxMKhqIfb0wCK1F", name: "Baxter" },
    { id: "g7LVvkPWALzPxOQbF6OE", name: "Jade" },
    { id: "6WwXjDDEMyNmFG95zycZ", name: "Eldrin" },
  ],
} as const;

export type Delivery = "calm" | "urgent" | "relieved";
export type VoiceRole = "dispatcher" | `drone:${number}`;

interface AccountVoice { voiceId: string; name?: string | null; category?: string | null; labels?: Record<string, string> | null }

/** Prefer included voices over library voices that can require a paid plan. */
export function accountCast(voices: AccountVoice[]) {
  const english = voices.filter((v) => v.voiceId && (!v.labels?.language || v.labels.language === "en"));
  const included = english.filter((v) => v.category === "premade");
  const owned = english.filter((v) => v.category === "cloned" || v.category === "generated");
  const pool = [...(included.length ? included : owned.length ? owned : english)].sort((a, b) => a.voiceId.localeCompare(b.voiceId));
  if (!pool.length) throw new Error("No English voices available. Set ELEVENLABS_DISPATCHER_VOICE and ELEVENLABS_DRONE_VOICES.");
  const used = new Set<string>();
  const pick = (names: string[]) => {
    const available = pool.filter((v) => !used.has(v.voiceId));
    const selected = names.map((name) => available.find((v) => v.name?.split(" - ")[0] === name)).find(Boolean) ?? available[0] ?? pool[0];
    used.add(selected.voiceId);
    return selected.voiceId;
  };
  return {
    dispatcher: pick(["Alicia", "Alice", "Bella", "Daniel", "Sarah"]),
    drones: [pick(["Baxter", "Charlie"]), pick(["Jade", "Jessica"]), pick(["Eldrin", "George"])],
  };
}

export function isDelivery(value: unknown): value is Delivery {
  return value === "calm" || value === "urgent" || value === "relieved";
}

export function isVoiceRole(value: unknown): value is VoiceRole {
  return typeof value === "string" && (value === "dispatcher" || /^drone:(?:0|[1-9]\d?)$/.test(value));
}

/** Flash uses pacing/stability; models with audio tags also get delivery direction. */
export function speechDelivery(text: string, delivery: Delivery, model: string) {
  const expressive = /^eleven_v[34](?:_|$)/.test(model);
  const tag = { calm: "", urgent: "[urgent] ", relieved: "[relieved] " }[delivery];
  return {
    text: (expressive ? tag : "") + text,
    voiceSettings: {
      stability: expressive ? 0.5 : delivery === "urgent" ? 0.45 : 0.65,
      similarityBoost: 0.8,
      style: 0,
      speed: delivery === "urgent" ? 1.1 : delivery === "relieved" ? 0.98 : 1.03,
      useSpeakerBoost: false,
    },
  };
}
