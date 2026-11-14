// Gemini: the AI incident commander at the base.
// It is given ONLY the base's picture (src/integrations/baseKnowledge.ts) and can only
// propose judge actions through function calling. It never controls a drone.
import { GoogleGenAI } from "@google/genai";
import type { BaseSnapshot } from "../src/integrations/baseKnowledge";
import { JUDGE_TOOLS, toolCallToAction, type ProposedAction } from "../src/integrations/commands";
import type { IntegrationStatus } from "./env";

const SITREP_SYSTEM = `You are the incident commander at the home base of a wildfire-fighting drone swarm.
You see ONLY what the base knows, given as JSON: the base's own fire map summarised into zones,
the drones in radio contact with the base right now, and the last status heard from the others.
You do not control the drones: they coordinate among themselves. You advise the humans watching.

Write one radio-style situation report, at most 55 words, plain text, no markdown, no lists.
Lead with the most important thing. Use map coordinates like (30, 22) for places and plain
drone numbers. Never invent facts that are not in the JSON. If staleTicks is above zero or
baseOnline is false, your picture is old: say so plainly and do not describe it as current.
If drones are silent, say you do not know what they are doing, not that they are lost.`;

const COMMAND_SYSTEM = `You are the incident commander's console for a wildfire drone-swarm simulation.
A judge types or speaks a request. If it asks to change the scenario, call the matching tool(s).
The tools change the world (fire, wind, radio), never the drones' decisions. Pick coordinates
yourself from the JSON when the judge names a place ("near the village", "north-east corner",
"on top of drone 4"): x grows east, y grows south, (0,0) is the north-west corner.
Wind is set by the direction it blows TOWARDS. If the request is a question, answer it in at
most 40 words from the JSON only, with no tool call. Never call a tool the judge did not ask for.`;

const AAR_SYSTEM = `You are writing the after-action report for one run of a wildfire drone-swarm simulation.
You get the final metrics, a log of key events, and (if present) database aggregates of the run.
Write 90 to 130 words of plain text, no markdown: what happened, the turning point, how
communications held up and how the swarm coped when they failed, and one concrete lesson.
Ticks are the time unit. Do not invent numbers that are not in the data.`;

export class Gemini {
  private ai: GoogleGenAI | null;
  private lastError = "";
  private lastCall = 0;
  private calls = 0;

  constructor(key: string | undefined, private model: string) {
    this.ai = key ? new GoogleGenAI({ apiKey: key }) : null;
  }

  get on() {
    return this.ai !== null;
  }

  status(): IntegrationStatus {
    if (!this.ai) return { on: false, detail: "no GEMINI_API_KEY: built-in sitreps and a basic command parser are used instead" };
    return { on: true, detail: this.lastError ? `${this.model} · last error: ${this.lastError}` : `${this.model} · ${this.calls} calls` };
  }

  /** A simple floor between calls so a stuck client cannot burn the quota. */
  private throttle(minGapMs: number) {
    const now = Date.now();
    if (now - this.lastCall < minGapMs) throw new Error("rate limited");
    this.lastCall = now;
    this.calls++;
  }

  private async text(system: string, payload: unknown, minGapMs: number): Promise<string> {
    if (!this.ai) throw new Error("Gemini is not configured");
    this.throttle(minGapMs);
    try {
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents: JSON.stringify(payload),
        config: { systemInstruction: system },
      });
      this.lastError = "";
      const out = (res.text ?? "").trim();
      if (!out) throw new Error("empty response");
      return out;
    } catch (e: any) {
      this.lastError = String(e.message ?? e).slice(0, 120);
      throw e;
    }
  }

  sitrep(snapshot: BaseSnapshot, trigger: string) {
    return this.text(SITREP_SYSTEM, { reasonForThisReport: trigger, baseKnowledge: snapshot }, 4000);
  }

  afterAction(data: unknown) {
    return this.text(AAR_SYSTEM, data, 1500);
  }

  /** A judge's request -> proposed judge actions (to be confirmed by a human) and/or a spoken reply. */
  async command(request: string, snapshot: BaseSnapshot, drones: number): Promise<{ reply: string; actions: ProposedAction[] }> {
    if (!this.ai) throw new Error("Gemini is not configured");
    this.throttle(800);
    try {
      const res = await this.ai.models.generateContent({
        model: this.model,
        contents: JSON.stringify({ judgeRequest: request.slice(0, 400), droneCount: drones, baseKnowledge: snapshot }),
        config: { systemInstruction: COMMAND_SYSTEM, tools: [{ functionDeclarations: JUDGE_TOOLS as any }] },
      });
      this.lastError = "";
      const map = { width: snapshot.map.width, height: snapshot.map.height, drones };
      const actions: ProposedAction[] = [];
      for (const call of res.functionCalls ?? []) {
        const a = toolCallToAction(call.name ?? "", (call.args ?? {}) as Record<string, unknown>, map);
        if (a) actions.push(a);
      }
      let reply = "";
      try {
        reply = (res.text ?? "").trim();
      } catch {
        /* a response with only function calls has no text */
      }
      return { reply, actions: actions.slice(0, 6) };
    } catch (e: any) {
      this.lastError = String(e.message ?? e).slice(0, 120);
      throw e;
    }
  }
}
