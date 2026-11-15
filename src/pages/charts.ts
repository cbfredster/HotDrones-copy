// A small SVG line chart for the dashboard: one y-axis, 2px lines, recessive grid, a legend
// plus direct labels at the line ends, and a crosshair tooltip. No dependencies.

export interface Series {
  name: string;
  color: string;
  points: { x: number; y: number; lo?: number; hi?: number }[]; // lo/hi: error bar or band
  band?: boolean; // draw lo..hi as a soft band instead of error bars
  dashed?: boolean;
}
export interface ChartOpts {
  series: Series[];
  xLabel: string;
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
  /** Categorical x: positions 0..n-1 with these labels. */
  categories?: string[];
  yMax?: number;
  /** Shaded spans on the x axis, e.g. "base offline". */
  spans?: { from: number; to: number; label: string }[];
  height?: number;
}

// Mode colours: the app's hues, stepped for a dark surface and checked with the dataviz
// validator (lightness band, colour-blind separation, contrast) against #1d2026.
export const MODE_COLOR: Record<string, string> = { swarm: "#d07a00", central: "#22a0c2", greedy: "#8052d6", cbba: "#3fa66a", unified: "#d6336c", none: "#7d848d" };
export const MODE_LABEL: Record<string, string> = { swarm: "Swarm (ours)", central: "Central control", greedy: "No coordination", cbba: "CBBA", unified: "Unified stack", none: "No drones" };
export const INK = { text: "#e8e6e3", dim: "#9aa0a6", grid: "#2c313a", surface: "#1d2026" };

const NS = "http://www.w3.org/2000/svg";
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, text?: string) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
};

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

export function lineChart(host: HTMLElement, o: ChartOpts) {
  const W = Math.max(320, host.clientWidth || 640);
  const H = o.height ?? 240;
  const L = 48, R = 118, T = 12, B = 40;
  const yf = o.yFormat ?? ((v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")));
  const xf = o.xFormat ?? ((v: number) => String(Math.round(v)));
  const all = o.series.flatMap((s) => s.points);
  host.textContent = "";
  host.style.position = "relative";
  if (!all.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No data yet.";
    host.append(p);
    return;
  }
  const xMin = o.categories ? 0 : Math.min(...all.map((p) => p.x));
  const xMax = o.categories ? o.categories.length - 1 : Math.max(...all.map((p) => p.x), xMin + 1);
  const yMax = o.yMax ?? niceMax(Math.max(...all.map((p) => Math.max(p.y, p.hi ?? p.y))));
  const X = (x: number) => L + ((x - xMin) / Math.max(1e-9, xMax - xMin)) * (W - L - R);
  const Y = (y: number) => T + (1 - Math.min(1, y / yMax)) * (H - T - B);

  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, role: "img" });
  for (let k = 0; k <= 4; k++) {
    const v = (yMax * k) / 4;
    svg.append(el("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), stroke: INK.grid, "stroke-width": 1 }));
    svg.append(el("text", { x: L - 8, y: Y(v) + 4, "text-anchor": "end", fill: INK.dim, "font-size": 11 }, yf(v)));
  }
  for (const s of o.spans ?? []) {
    const x1 = X(Math.max(xMin, s.from)), x2 = X(Math.min(xMax, s.to));
    if (x2 <= x1) continue;
    svg.append(el("rect", { x: x1, y: T, width: x2 - x1, height: H - T - B, fill: "#ffffff", opacity: 0.06 }));
    svg.append(el("text", { x: x1 + 4, y: T + 12, fill: INK.dim, "font-size": 10 }, s.label));
  }
  if (o.categories) {
    o.categories.forEach((c, i) => svg.append(el("text", { x: X(i), y: H - B + 16, "text-anchor": "middle", fill: INK.dim, "font-size": 11 }, c)));
  } else {
    for (let k = 0; k <= 5; k++) {
      const v = xMin + ((xMax - xMin) * k) / 5;
      svg.append(el("text", { x: X(v), y: H - B + 16, "text-anchor": "middle", fill: INK.dim, "font-size": 11 }, xf(v)));
    }
  }
  svg.append(el("text", { x: (L + W - R) / 2, y: H - 6, "text-anchor": "middle", fill: INK.dim, "font-size": 11 }, o.xLabel));

  // Marks, then direct labels at the line ends (nudged apart so they never collide).
  const ends: { y: number; s: Series; v: number }[] = [];
  for (const s of o.series) {
    if (!s.points.length) continue;
    if (s.band) {
      const up = s.points.map((p) => `${X(p.x)},${Y(p.hi ?? p.y)}`);
      const down = [...s.points].reverse().map((p) => `${X(p.x)},${Y(p.lo ?? p.y)}`);
      svg.append(el("polygon", { points: [...up, ...down].join(" "), fill: s.color, opacity: 0.18 }));
    } else {
      for (const p of s.points) {
        if (p.lo === undefined || p.hi === undefined) continue;
        svg.append(el("line", { x1: X(p.x), x2: X(p.x), y1: Y(p.lo), y2: Y(p.hi), stroke: s.color, "stroke-width": 2, opacity: 0.45 }));
      }
    }
    svg.append(el("polyline", { points: s.points.map((p) => `${X(p.x)},${Y(p.y)}`).join(" "), fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", ...(s.dashed ? { "stroke-dasharray": "5 4" } : {}) }));
    if (o.categories) for (const p of s.points) svg.append(el("circle", { cx: X(p.x), cy: Y(p.y), r: 4, fill: s.color, stroke: INK.surface, "stroke-width": 2 }));
    const last = s.points[s.points.length - 1];
    ends.push({ y: Y(last.y), s, v: last.y });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const e of ends) {
    svg.append(el("circle", { cx: W - R + 10, cy: e.y, r: 4, fill: e.s.color }));
    svg.append(el("text", { x: W - R + 18, y: e.y + 4, fill: INK.text, "font-size": 11 }, e.s.name));
  }

  // Hover: crosshair + tooltip listing every series at the nearest x.
  const cross = el("line", { x1: 0, x2: 0, y1: T, y2: H - B, stroke: INK.dim, "stroke-width": 1, visibility: "hidden" });
  svg.append(cross);
  const tip = document.createElement("div");
  tip.className = "tip";
  tip.hidden = true;
  const xs = [...new Set(all.map((p) => p.x))].sort((a, b) => a - b);
  svg.addEventListener("pointermove", (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const x = xs.reduce((a, b) => (Math.abs(X(b) - px) < Math.abs(X(a) - px) ? b : a));
    cross.setAttribute("x1", String(X(x)));
    cross.setAttribute("x2", String(X(x)));
    cross.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.textContent = "";
    const head = document.createElement("b");
    head.textContent = o.categories ? `${o.xLabel.split(" (")[0]}: ${o.categories[x]}` : `${o.xLabel.split(" (")[0]} ${xf(x)}`;
    tip.append(head);
    for (const s of o.series) {
      const p = s.points.find((q) => q.x === x);
      if (!p) continue;
      const row = document.createElement("div");
      const sw = document.createElement("i");
      sw.style.background = s.color;
      row.append(sw, `${s.name}: ${yf(p.y)}`);
      tip.append(row);
    }
    const left = (X(x) / W) * r.width;
    tip.style.left = `${Math.min(r.width - 170, left + 12)}px`;
    tip.style.top = `${T + 4}px`;
  });
  svg.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    tip.hidden = true;
  });

  host.append(svg, tip);
  if (o.series.length > 1) {
    const legend = document.createElement("div");
    legend.className = "legend";
    for (const s of o.series) {
      const item = document.createElement("span");
      const sw = document.createElement("i");
      sw.style.background = s.color;
      item.append(sw, s.name);
      legend.append(item);
    }
    host.append(legend);
  }
}
