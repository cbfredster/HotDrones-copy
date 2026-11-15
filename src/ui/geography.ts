import { geoBounds, gridToGeo, landCoverToTile, validateGeoArea, validateGeoScenario, type GeoScenario } from "../sim/geography";
import { FUEL } from "../sim/terrain";
import { $, input } from "./dom";
import { LatestRequest } from "./latest-request";

const COLOURS = ["#7f9956", "#335e40", "#c9c5b0", "#87857e", "#387d9d"];

async function getJson(url: string, signal: AbortSignal) {
  let res: Response;
  try { res = await fetch(url, { signal }); }
  catch (e) {
    if (signal.aborted) throw e;
    throw new Error("Cannot reach the server. Start npm run dev, then retry; or use a bundled example.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status}). Retry shortly or use an offline example.`);
  return body;
}

export class GeographyControls {
  private load = new LatestRequest();
  private search = new LatestRequest();
  private draft?: GeoScenario;
  private selectedPlace?: { lat: number; lon: number; label: string };
  private placement: "ignition" | "base" | "target" = "ignition";

  constructor(private apply: (scenario?: GeoScenario) => void) {
    $("terrainMode").onchange = () => {
      const real = $<HTMLSelectElement>("terrainMode").value === "geographic";
      $("geoControls").hidden = !real;
      this.load.cancel(); this.search.cancel();
      if (!real) { this.draft = undefined; this.apply(); }
    };
    $("geoSearch").onclick = () => void this.searchPlaces();
    input("geoQuery").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); void this.searchPlaces(); } };
    for (const id of ["geoLat", "geoLon", "geoSize"]) {
      $(id).oninput = () => { this.invalidate(); this.footprint(); };
    }
    $("geoLoad").onclick = () => void this.loadArea();
    $("geoCancel").onclick = () => { this.load.cancel(); this.busy(false); this.status("Load cancelled. The current run is still available."); };
    $("geoApply").onclick = () => {
      if (!this.draft) return;
      try {
        const scenario = validateGeoScenario({ ...this.draft,
          preburnTicks: Number(input("geoPreburn").value),
          wind: { angle: Number(input("geoWind").value) * Math.PI / 180, speed: Number(input("geoWindSpeed").value) / 100 } });
        this.apply(scenario);
        this.status("Location ready at tick 0. Press Play or Step. New run, mode changes and replay retain this terrain.");
      } catch (e) { this.status(String((e as Error).message), true); }
    };
    for (const b of document.querySelectorAll<HTMLButtonElement>("[data-placement]")) b.onclick = () => {
      this.placement = b.dataset.placement as typeof this.placement;
      for (const other of document.querySelectorAll("[data-placement]")) other.classList.toggle("on", other === b);
      this.status(`Click the preview to place ${this.placement === "target" ? "the protected target" : this.placement}.`);
    };
    const canvas = $<HTMLCanvasElement>("geoPreview");
    canvas.onclick = (e) => {
      if (!this.draft) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.min(63, Math.max(0, Math.floor((e.clientX - r.left) / r.width * 64)));
      const y = Math.min(63, Math.max(0, Math.floor((e.clientY - r.top) / r.height * 64)));
      try {
        const patch = this.placement === "ignition" ? { ignition: [y * 64 + x] } : { [this.placement]: y * 64 + x };
        this.draft = validateGeoScenario({ ...this.draft, ...patch });
        this.draw(); this.status(`${this.placement} placed at (${x}, ${y}). Apply when ready.`);
      } catch (err) { this.status((err as Error).message, true); }
    };
    canvas.onmousemove = (e) => {
      if (!this.draft) return;
      const r = canvas.getBoundingClientRect();
      const x = Math.min(63, Math.max(0, Math.floor((e.clientX-r.left)/r.width*64)));
      const y = Math.min(63, Math.max(0, Math.floor((e.clientY-r.top)/r.height*64)));
      const p = gridToGeo(this.draft, x, y);
      canvas.title = `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · ${this.draft.elevationM[y*64+x].toFixed(0)} m · WorldCover ${this.draft.landCover[y*64+x]}`;
    };
    this.footprint();
    void this.examples();
  }

  setActive(scenario?: GeoScenario) {
    this.load.cancel(); this.search.cancel(); this.busy(false);
    $<HTMLSelectElement>("terrainMode").value = scenario ? "geographic" : "procedural";
    $("geoControls").hidden = !scenario;
    const info = $("geoRunInfo"); info.hidden = !scenario;
    if (scenario) {
      input("geoLat").value = String(scenario.centre.lat);
      input("geoLon").value = String(scenario.centre.lon);
      $<HTMLSelectElement>("geoSize").value = String(scenario.sizeM);
      info.textContent = `${scenario.metadata.label} · ${(scenario.sizeM / 1000).toFixed(0)} × ${(scenario.sizeM / 1000).toFixed(0)} km · ${(scenario.sizeM / 64).toFixed(1)} m/cell`;
      this.receive(scenario);
    }
  }

  private status(message: string, error = false) {
    $("geoStatus").textContent = message;
    $("geoStatus").classList.toggle("bad", error);
  }
  private busy(on: boolean) {
    $("geoCancel").hidden = !on;
    $("geoLoad").textContent = on ? "Restart load" : "Load / retry area";
  }
  private invalidate() {
    this.load.cancel(); this.busy(false); this.draft = undefined;
    $("geoPlacement").hidden = true;
    this.status("Footprint changed. Load this area to preview its terrain.");
  }
  private area() {
    const area = { centre: { lat: Number(input("geoLat").value), lon: Number(input("geoLon").value) }, sizeM: Number($<HTMLSelectElement>("geoSize").value), w: 64 as const, h: 64 as const };
    if (!input("geoLat").value.trim() || !input("geoLon").value.trim()) throw new Error("Enter both latitude and longitude.");
    validateGeoArea(area);
    return area;
  }
  private footprint() {
    try {
      const a = this.area(); const b = geoBounds(a);
      $("geoFootprint").textContent = `North ↑ · ${a.sizeM/1000} × ${a.sizeM/1000} km · ${a.sizeM/64} m/cell. Bounds: N ${b.north.toFixed(4)}, S ${b.south.toFixed(4)}, W ${b.west.toFixed(4)}, E ${b.east.toFixed(4)}.`;
      const link = $<HTMLAnchorElement>("geoMapLink");
      link.href = `https://www.openstreetmap.org/?minlat=${b.south}&minlon=${b.west}&maxlat=${b.north}&maxlon=${b.east}&box=yes`;
      link.hidden = false;
    } catch (e) { $("geoFootprint").textContent = (e as Error).message; $("geoMapLink").hidden = true; }
  }
  private async searchPlaces() {
    const req = this.search.begin();
    const query = input("geoQuery").value.trim();
    if (query.length < 2 || query.length > 100) { this.status("Enter a place name between 2 and 100 characters.", true); return; }
    this.status("Searching place names…"); $("geoResults").replaceChildren();
    try {
      const body = await getJson(`/api/geography/search?q=${encodeURIComponent(query)}`, req.signal);
      if (!req.current()) return;
      const results = Array.isArray(body) ? body : body.results ?? [];
      for (const place of results) {
        const b = document.createElement("button"); b.type = "button";
        b.textContent = place.label ?? [place.name, place.admin1, place.country].filter(Boolean).join(", ");
        b.onclick = () => {
          this.invalidate();
          input("geoLat").value = String(place.lat ?? place.latitude);
          input("geoLon").value = String(place.lon ?? place.longitude);
          input("geoQuery").value = b.textContent || query;
          this.selectedPlace = { lat: Number(input("geoLat").value), lon: Number(input("geoLon").value), label: b.textContent || query };
          this.footprint(); this.status("Place selected. Check the footprint, then load the area.");
        };
        $("geoResults").append(b);
      }
      this.status(results.length ? "Choose a result below, then load its area." : "No places found. Try another name or enter coordinates.");
    } catch (e) { if (req.current()) this.status((e as Error).message, true); }
  }
  private async loadArea(file?: string) {
    const req = this.load.begin(); this.busy(true);
    try {
      let url = file;
      if (!url) {
        const a = this.area();
        const selected = this.selectedPlace;
        const label = selected && selected.lat === a.centre.lat && selected.lon === a.centre.lon ? selected.label : `${a.centre.lat.toFixed(5)}, ${a.centre.lon.toFixed(5)}`;
        url = `/api/geography/load?lat=${a.centre.lat}&lon=${a.centre.lon}&sizeM=${a.sizeM}&label=${encodeURIComponent(label)}`;
      }
      this.status(file ? "Loading bundled sourced snapshot…" : "Footprint validated. Loading elevation and WorldCover land cover…");
      const body = await getJson(url, req.signal);
      if (!req.current()) return;
      this.status("Validating terrain coverage and placing initial assets…");
      const scenario = validateGeoScenario(body);
      this.receive(scenario);
      this.status("Terrain loaded. Place assets on the preview, set wind and preburn, then Apply location.");
    } catch (e) { if (req.current()) this.status((e as Error).message, true); }
    finally { if (req.current()) this.busy(false); }
  }
  private receive(scenario: GeoScenario) {
    this.draft = scenario;
    input("geoLat").value = String(scenario.centre.lat);
    input("geoLon").value = String(scenario.centre.lon);
    $<HTMLSelectElement>("geoSize").value = String(scenario.sizeM);
    this.footprint();
    $("geoPlacement").hidden = false;
    input("geoPreburn").value = String(scenario.preburnTicks);
    input("geoWind").value = String(Math.round(scenario.wind.angle * 180 / Math.PI));
    input("geoWindSpeed").value = String(Math.round(scenario.wind.speed * 100));
    $("geoSources").textContent = `${scenario.metadata.label} · retrieved ${scenario.metadata.retrievedAt}. ${scenario.metadata.elevation}. ${scenario.metadata.landCover}. ${scenario.metadata.details ?? ""} ${scenario.metadata.attribution.join(" · ")}`;
    this.draw();
  }
  private draw() {
    const s = this.draft; if (!s) return;
    const ctx = $<HTMLCanvasElement>("geoPreview").getContext("2d")!;
    const min = Math.min(...s.elevationM), max = Math.max(...s.elevationM);
    for (let i=0;i<4096;i++) {
      ctx.fillStyle = COLOURS[landCoverToTile(s.landCover[i])];
      ctx.fillRect(i%64*4, Math.floor(i/64)*4,4,4);
      ctx.fillStyle = `rgba(0,0,0,${0.28*(1-(s.elevationM[i]-min)/Math.max(1,max-min))})`;
      ctx.fillRect(i%64*4, Math.floor(i/64)*4,4,4);
    }
    for (const [i, label, colour] of [[s.ignition[0],"I","#ff9f1c"],[s.base,"B","#b388ff"],[s.target,"T","#fff"]] as const) {
      const x=i%64*4+2,y=Math.floor(i/64)*4+2;
      ctx.beginPath(); ctx.arc(x,y,7,0,Math.PI*2);ctx.fillStyle="#14161a";ctx.fill();
      ctx.fillStyle=colour;ctx.font="bold 11px system-ui";ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillText(label,x,y);
    }
    const water = s.landCover.some(c => c===80);
    const fuel = s.landCover.filter(c => FUEL[landCoverToTile(c)].ignite>0).length;
    $("geoCoverage").textContent = `North ↑ · ${s.centre.lat.toFixed(4)}, ${s.centre.lon.toFixed(4)} · ${s.sizeM/1000} km square · ${fuel}/4096 combustible cells. ${water ? "Natural water cells available for refill." : "No natural refill water: a hypothetical refill station is provided at base."} Target and base are hypothetical response assets, not mapped buildings.`;
  }
  private async examples() {
    try {
      const res = await fetch("/geography/examples.json"); if (!res.ok) return;
      const body = await res.json();
      for (const ex of body.examples ?? []) {
        if (typeof ex.file !== "string" || !/^\/geography\/[a-z0-9-]+\.json$/.test(ex.file)) continue;
        const b=document.createElement("button"); b.textContent=ex.label;
        b.onclick=()=>void this.loadArea(ex.file); $("geoExamples").append(b);
      }
    } catch { /* examples optional during source acquisition */ }
  }
}
