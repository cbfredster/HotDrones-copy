// Browser side of the server API. Nothing here ever throws or blocks: a call that fails
// resolves to null, and the caller falls back to its offline behaviour. The sim loop never
// awaits any of these.

export type IntegrationName = "tiger" | "gemini" | "elevenlabs" | "mongo";
export interface IntegrationStatus {
  on: boolean;
  detail: string;
}
export type Status = Record<IntegrationName, IntegrationStatus>;

const LABELS: Record<IntegrationName, string> = { tiger: "Tiger Data", gemini: "Gemini", elevenlabs: "ElevenLabs", mongo: "MongoDB" };

class Api {
  /** null until the first answer; false = the server is not reachable. */
  serverUp: boolean | null = null;
  status: Status | null = null;
  private listeners: (() => void)[] = [];
  private polling = false;

  on(name: IntegrationName) {
    return !!this.status?.[name]?.on;
  }

  onStatus(f: () => void) {
    this.listeners.push(f);
  }

  /** Poll /api/status now and then, and draw the status dots into `el`. */
  startStatus(el: HTMLElement) {
    if (this.polling) return;
    this.polling = true;
    const tick = async () => {
      const s = await this.getJson<Status>("/api/status", 4000);
      this.serverUp = s !== null;
      this.status = s;
      this.drawDots(el);
      for (const f of this.listeners) f();
      setTimeout(tick, this.serverUp ? 10000 : 5000);
    };
    void tick();
  }

  private drawDots(el: HTMLElement) {
    el.textContent = "";
    for (const name of Object.keys(LABELS) as IntegrationName[]) {
      const s = this.status?.[name];
      const dot = document.createElement("span");
      const warn = !!s && s.on && /error/.test(s.detail);
      dot.className = `dot${s?.on ? " on" : ""}${warn ? " warn" : ""}`;
      dot.title = this.serverUp === false ? `${LABELS[name]}: the API server is not running (npm run dev starts it). The demo works without it.` : `${LABELS[name]}: ${s?.detail ?? "checking…"}`;
      dot.append(document.createElement("i"), LABELS[name]);
      el.append(dot);
    }
  }

  async post(path: string, body: unknown, timeoutMs = 15000, signal?: AbortSignal): Promise<Response | null> {
    if (this.serverUp === false) return null;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      return r.ok ? r : null;
    } catch {
      return null;
    }
  }

  async postJson<T>(path: string, body: unknown, timeoutMs = 15000): Promise<T | null> {
    const r = await this.post(path, body, timeoutMs);
    try {
      return r ? ((await r.json()) as T) : null;
    } catch {
      return null;
    }
  }

  async getJson<T>(path: string, timeoutMs = 8000): Promise<T | null> {
    try {
      const r = await fetch(path, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  }

  /** Fire-and-forget: used for telemetry, where a lost batch is fine. */
  send(path: string, body: unknown) {
    if (this.serverUp !== true) return;
    void fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: false }).catch(() => {});
  }
}

export const api = new Api();
