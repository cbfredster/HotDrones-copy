// Scenarios (MongoDB Atlas): because the sim is deterministic, seed + config + the recorded
// judge actions replay a run exactly. Saving one gives a share link (?scenario=<id>) and
// enters it on the "Challenge the swarm" board, where the server re-runs it in every mode.
import type { Config } from "../sim/config";
import type { RecordedAction } from "../sim/judge";
import { $, input } from "../ui/dom";
import { api } from "./api";
import type { Hooks } from "./index";

interface StoredScenario {
  _id: string;
  name: string;
  cfg: Partial<Config>;
  actions: RecordedAction[];
}

export class Scenarios {
  private saving = false;

  constructor(private hooks: Hooks) {
    $("scenarioSave").onclick = () => void this.save($("scenarioShare"));
    $("endSave").onclick = () => void this.save($("endShare"));
  }

  onRun() {
    for (const id of ["scenarioShare", "endShare"]) $(id).hidden = true;
  }

  loadFromUrl(): boolean {
    const id = new URLSearchParams(location.search).get("scenario");
    if (!id || !/^[a-z0-9]{4,12}$/.test(id)) return false;
    void (async () => {
      const s = await api.getJson<StoredScenario>(`/api/scenarios/${id}`);
      if (!s) {
        this.show($("scenarioShare"), `Could not load scenario “${id}” (is the server running?).`);
        return;
      }
      input("scenarioName").value = s.name;
      this.hooks.startRun(s.cfg, s.actions);
      this.show($("scenarioShare"), `Replaying “${s.name}”: ${s.actions.length} recorded judge action${s.actions.length === 1 ? "" : "s"} will happen at their original ticks.`);
    })();
    return true;
  }

  private show(el: HTMLElement, text: string) {
    el.hidden = false;
    el.textContent = text;
  }

  private async save(out: HTMLElement) {
    if (this.saving) return;
    const world = this.hooks.getWorld();
    this.saving = true;
    this.show(out, "Saving…");
    try {
      const name = input("scenarioName").value.trim() || `Seed ${world.cfg.seed}, ${world.judgeLog.length} judge action${world.judgeLog.length === 1 ? "" : "s"}`;
      const r = await api.postJson<{ id: string }>("/api/scenarios", { name, cfg: world.initialCfg, actions: world.judgeLog });
      if (!r?.id) {
        this.show(out, "Could not save: the API server is not reachable. (The run can still be replayed from the end card.)");
        return;
      }
      const url = `${location.origin}${location.pathname}?scenario=${r.id}`;
      out.textContent = "";
      const a = document.createElement("a");
      a.href = url;
      a.textContent = url;
      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.onclick = () => navigator.clipboard?.writeText(url).then(() => (copy.textContent = "Copied"), () => {});
      const board = document.createElement("a");
      board.href = "/board.html";
      board.target = "_blank";
      board.rel = "noopener";
      board.textContent = "See it on the challenge board";
      out.append("Saved. Share link: ", a, copy, document.createElement("br"), "It is now being run in every mode. ", board, ".");
    } finally {
      this.saving = false;
    }
  }
}
