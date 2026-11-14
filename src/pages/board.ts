// "Challenge the swarm" board: saved scenarios, each replayed by the server in every
// coordination mode, ranked by how badly they hurt the swarm.
import "./pages.css";
import { MODE_LABEL } from "./charts";

const MODES = ["swarm", "central", "greedy"];
const host = document.getElementById("board")!;
const source = document.getElementById("source")!;

const cell = (text: string, cls = "") => {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  return td;
};

function outcome(o: any): HTMLTableCellElement {
  const td = document.createElement("td");
  if (!o) {
    td.textContent = "…";
    return td;
  }
  const pill = document.createElement("span");
  pill.className = `pill ${o.villageLost ? "bad" : "good"}`;
  pill.textContent = o.villageLost ? "village lost" : "village safe";
  td.append(`${o.burnt} burnt `, pill);
  if (o.dronesLost) td.append(` · ${o.dronesLost} drone${o.dronesLost === 1 ? "" : "s"} lost`);
  return td;
}

async function refresh() {
  let d: any = null;
  try {
    const r = await fetch("/api/board");
    d = r.ok ? await r.json() : null;
  } catch {
    /* handled below */
  }
  if (!d) {
    host.innerHTML = `<p class="empty">The API server is not reachable (npm run dev starts it).</p>`;
    return;
  }
  source.innerHTML = `Stored in: <b></b>`;
  source.querySelector("b")!.textContent = d.store === "mongo" ? "MongoDB Atlas" : "a local file (MongoDB not connected)";
  if (!d.scenarios.length) {
    host.innerHTML = `<p class="empty">No scenarios yet. Be the first to break the swarm.</p>`;
    return;
  }
  const table = document.createElement("table");
  table.innerHTML = `<tr><th class="num">#</th><th>Scenario</th>${MODES.map((m) => `<th>${MODE_LABEL[m]}</th>`).join("")}<th>After-action report</th><th></th></tr>`;
  d.scenarios.forEach((s: any, i: number) => {
    const tr = document.createElement("tr");
    const name = document.createElement("td");
    const b = document.createElement("b");
    b.textContent = s.name;
    const meta = document.createElement("div");
    meta.className = "source";
    meta.textContent = `by ${s.author} · seed ${s.cfg?.seed} · ${new Date(s.createdAt).toLocaleString()}${s.status !== "done" ? ` · ${s.status}` : ""}`;
    name.append(b, meta);
    const report = cell(s.report ?? (s.status === "done" ? "—" : "running in every mode…"), "report");
    const play = document.createElement("td");
    const a = document.createElement("a");
    a.className = "play";
    a.href = `/?scenario=${s._id}`;
    a.textContent = "Replay ▶";
    play.append(a);
    tr.append(cell(String(i + 1), "num"), name, ...MODES.map((m) => outcome(s.outcomes?.[m])), report, play);
    table.append(tr);
  });
  host.replaceChildren(table);
}

function connect() {
  try {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onmessage = (m) => {
      if (JSON.parse(m.data).type === "board") void refresh();
    };
    ws.onclose = () => setTimeout(connect, 4000);
  } catch {
    /* polling still works */
  }
}
connect();
void refresh();
setInterval(() => void refresh(), 5000);
