// Top-down renderer. Kept completely separate from the simulation.
// The main view is now the isometric renderer in ./iso; this one draws the minimap
// (pass `compact: true`) and is still the whole display of the frozen 2D app in BASIC/.
import { BASE_ID } from "../sim/comms";
import { Drone } from "../sim/drone";
import { Fire } from "../sim/environment";
import { Tile } from "../sim/terrain";
import { World } from "../sim/world";

export interface ViewOptions {
  beliefOf: number | null; // show this drone's belief instead of the truth
  selected: number | null;
  showLinks: boolean;
  showSmoke: boolean;
  showClouds: boolean;
  showSensors: boolean;
  /** Minimap mode: drones become plain dots (no ID text or bars), which stay legible at 3-4 px per tile. */
  compact?: boolean;
  /** Draw pairs that are in range but cut off (hill / smoke / blackout). Used by the 3D view. */
  showBlocked?: boolean;
}

const TILE_RGB: Record<number, [number, number, number]> = {
  [Tile.Grass]: [143, 191, 90],
  [Tile.Forest]: [47, 107, 58],
  [Tile.Sand]: [217, 200, 143],
  [Tile.Rock]: [138, 133, 128],
  [Tile.Water]: [63, 127, 191],
};

// Exported so the isometric renderer colours drones exactly like this one.
export const STATE_COLOUR: Record<string, string> = {
  idle: "#e0e0e0",
  toFire: "#ff9f1c",
  toWater: "#4cc9f0",
  refilling: "#4cc9f0",
  toBase: "#b388ff",
  charging: "#b388ff",
  scouting: "#80ed99",
  dead: "#555",
};

export const TEAM_COLOURS = ["#ff595e", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93", "#f15bb5", "#00bbf9", "#fee440", "#9b5de5", "#00f5d4", "#fb5607", "#3a86ff"];

export class Renderer {
  private terrainImg: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private smokeLayer: HTMLCanvasElement;
  readonly scale: number;

  constructor(private canvas: HTMLCanvasElement, private world: World) {
    const { w, h } = world.terrain;
    this.scale = Math.floor(Math.min(canvas.width / w, canvas.height / h));
    this.terrainImg = this.buildTerrain();
    this.overlay = document.createElement("canvas");
    this.overlay.width = w;
    this.overlay.height = h;
    this.smokeLayer = document.createElement("canvas");
    this.smokeLayer.width = w;
    this.smokeLayer.height = h;
  }

  // Terrain colours with simple hill shading, drawn once.
  private buildTerrain() {
    const { w, h, height, type } = this.world.terrain;
    const hs = this.world.cfg.heightScale;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const [r, g, b] = TILE_RGB[type[i]];
        const west = height[y * w + Math.max(0, x - 1)];
        const north = height[Math.max(0, y - 1) * w + x];
        const shade = type[i] === Tile.Water ? 1 : 0.78 + (0.3 * height[i]) / hs + 0.06 * (height[i] - west + height[i] - north);
        img.data[i * 4] = r * shade;
        img.data[i * 4 + 1] = g * shade;
        img.data[i * 4 + 2] = b * shade;
        img.data[i * 4 + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return c;
  }

  draw(opts: ViewOptions) {
    const world = this.world;
    const { w, h } = world.terrain;
    const s = this.scale;
    const ctx = this.canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.terrainImg, 0, 0, w * s, h * s);

    // Fire layer: the truth, or what one drone believes.
    const viewer = opts.beliefOf !== null ? world.drones[opts.beliefOf] : null;
    const fire = viewer ? viewer.belief.fire : world.env.fire;
    const sev = viewer ? viewer.belief.severity : world.env.severity;
    const octx = this.overlay.getContext("2d")!;
    const oimg = octx.createImageData(w, h);
    const maxSev = world.cfg.maxSeverity;
    for (let i = 0; i < w * h; i++) {
      const o = i * 4;
      if (fire[i] === Fire.Burning) {
        const t = Math.min(1, sev[i] / maxSev);
        oimg.data[o] = 255;
        oimg.data[o + 1] = 210 * (1 - t) + 30 * t;
        oimg.data[o + 2] = 40 * (1 - t);
        oimg.data[o + 3] = 235;
      } else if (fire[i] === Fire.Burnt) {
        oimg.data[o] = 43;
        oimg.data[o + 1] = 37;
        oimg.data[o + 2] = 35;
        oimg.data[o + 3] = 220;
      } else if (!viewer && world.env.wetness[i] > 0.05) {
        oimg.data[o] = 120;
        oimg.data[o + 1] = 190;
        oimg.data[o + 2] = 255;
        oimg.data[o + 3] = 120 * world.env.wetness[i];
      }
      if (viewer) {
        // Darken tiles this drone hasn't seen recently: its map is out of date there.
        const seen = viewer.belief.lastSeen[i];
        const age = seen < 0 ? 1e9 : world.tick - seen;
        const dark = Math.min(0.75, age / 300);
        if (oimg.data[o + 3] === 0) {
          oimg.data[o + 3] = 255 * dark;
        } else {
          oimg.data[o] *= 1 - dark;
          oimg.data[o + 1] *= 1 - dark;
          oimg.data[o + 2] *= 1 - dark;
        }
      }
    }
    octx.putImageData(oimg, 0, 0);
    ctx.drawImage(this.overlay, 0, 0, w * s, h * s);

    // Village and base.
    for (const v of world.terrain.village) {
      const x = (v % w) * s;
      const y = Math.floor(v / w) * s;
      ctx.fillStyle = world.env.fire[v] === Fire.Unburnt ? "#f4e3c1" : "#5a3a2a";
      ctx.fillRect(x + s * 0.2, y + s * 0.4, s * 0.6, s * 0.5);
      ctx.fillStyle = "#b23a2a";
      ctx.beginPath();
      ctx.moveTo(x + s * 0.1, y + s * 0.45);
      ctx.lineTo(x + s * 0.5, y + s * 0.1);
      ctx.lineTo(x + s * 0.9, y + s * 0.45);
      ctx.fill();
    }
    const bx = (world.base.x + 0.5) * s;
    const by = (world.base.y + 0.5) * s;
    ctx.fillStyle = world.baseOnline ? "#ffffff" : "#777";
    ctx.beginPath();
    ctx.arc(bx, by, s * 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#222";
    ctx.font = `bold ${Math.round(s * 1.4)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("H", bx, by + 1);

    // Relay towers: a small diamond, hollow once burnt down.
    for (const t of world.towers) {
      const tx = (t.x + 0.5) * s;
      const ty = (t.y + 0.5) * s;
      const r = Math.max(3, s * 0.9);
      ctx.beginPath();
      ctx.moveTo(tx, ty - r);
      ctx.lineTo(tx + r, ty);
      ctx.lineTo(tx, ty + r);
      ctx.lineTo(tx - r, ty);
      ctx.closePath();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "#111";
      ctx.fillStyle = t.alive ? "#ff5d73" : "#444";
      ctx.fill();
      ctx.stroke();
    }

    // Smoke drifts with the wind; drawn smoothed.
    if (opts.showSmoke && !viewer) {
      const sctx = this.smokeLayer.getContext("2d")!;
      const simg = sctx.createImageData(w, h);
      const thick = world.cfg.thickSmoke;
      for (let i = 0; i < w * h; i++) {
        const a = Math.min(0.75, world.env.smoke[i] / (thick * 2.5));
        simg.data[i * 4] = 90;
        simg.data[i * 4 + 1] = 90;
        simg.data[i * 4 + 2] = 95;
        simg.data[i * 4 + 3] = a * 255;
      }
      sctx.putImageData(simg, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.smokeLayer, 0, 0, w * s, h * s);
      ctx.imageSmoothingEnabled = false;
    }

    // Comms blackout zones.
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    for (const b of world.blackouts) {
      ctx.strokeStyle = "#c77dff";
      ctx.fillStyle = "rgba(199,125,255,0.12)";
      ctx.beginPath();
      ctx.arc((b.x + 0.5) * s, (b.y + 0.5) * s, b.r * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Comms links (who can talk to whom right now).
    if (opts.showLinks) {
      ctx.strokeStyle = "rgba(120,230,255,0.55)";
      ctx.lineWidth = 1;
      for (const [a, b] of world.network.links) {
        const pa = this.nodeAt(a);
        const pb = this.nodeAt(b);
        if (!pa || !pb) continue;
        ctx.beginPath();
        ctx.moveTo((pa.x + 0.5) * s, (pa.y + 0.5) * s);
        ctx.lineTo((pb.x + 0.5) * s, (pb.y + 0.5) * s);
        ctx.stroke();
      }
    }

    // Selected drone: sensor range, target, and its guesses about lost teammates.
    const sel = opts.selected !== null ? world.drones[opts.selected] : null;
    if (sel && sel.alive) {
      if (opts.showSensors) {
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.beginPath();
        ctx.arc((sel.x + 0.5) * s, (sel.y + 0.5) * s, world.cfg.sensorRadius * s, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (opts.showClouds) {
        for (const [id, tr] of sel.trackers) {
          ctx.fillStyle = TEAM_COLOURS[id % TEAM_COLOURS.length];
          for (let k = 0; k < tr.n; k++) {
            ctx.globalAlpha = 0.55;
            ctx.fillRect((tr.xs[k] + 0.5) * s - 1.5, (tr.ys[k] + 0.5) * s - 1.5, 3, 3);
          }
          ctx.globalAlpha = 1;
        }
      }
    }

    // Drones.
    for (const d of world.drones) {
      if (opts.compact) this.drawDroneDot(ctx, d, d.id === opts.selected);
      else this.drawDrone(ctx, d, d.id === opts.selected);
    }
  }

  private nodeAt(id: number): { x: number; y: number } | undefined {
    if (id === BASE_ID) return this.world.base;
    return id >= 0 ? this.world.drones[id] : this.world.towers.find((t) => t.id === id);
  }

  // Minimap version of a drone: a dot in its state colour, ringed when selected.
  private drawDroneDot(ctx: CanvasRenderingContext2D, d: Drone, selected: boolean) {
    const s = this.scale;
    const x = (d.x + 0.5) * s;
    const y = (d.y + 0.5) * s;
    const r = Math.max(2.4, s * 0.7) + (selected ? 1.2 : 0);
    ctx.fillStyle = STATE_COLOUR[d.state] ?? "#fff";
    ctx.strokeStyle = selected ? "#fff" : "#000";
    ctx.lineWidth = selected ? 2 : 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  private drawDrone(ctx: CanvasRenderingContext2D, d: Drone, selected: boolean) {
    const s = this.scale;
    const x = (d.x + 0.5) * s;
    const y = (d.y + 0.5) * s;
    if (!d.alive) {
      ctx.strokeStyle = "#ddd";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 4, y - 4);
      ctx.lineTo(x + 4, y + 4);
      ctx.moveTo(x + 4, y - 4);
      ctx.lineTo(x - 4, y + 4);
      ctx.stroke();
      return;
    }
    if (selected && d.state === "toFire") {
      ctx.strokeStyle = "rgba(255,159,28,0.8)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo((d.targetX + 0.5) * s, (d.targetY + 0.5) * s);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    const r = s * 0.75;
    ctx.fillStyle = STATE_COLOUR[d.state] ?? "#fff";
    ctx.strokeStyle = selected ? "#fff" : "#000";
    ctx.lineWidth = selected ? 2.5 : 1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#000";
    ctx.font = `bold ${Math.round(s * 0.9)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(d.id), x, y + 1);
    // Water (blue) and battery (green) bars.
    const bw = s * 1.8;
    const cap = this.world.cfg.waterCapacity;
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x - bw / 2, y - r - 7, bw, 6);
    ctx.fillStyle = "#4cc9f0";
    ctx.fillRect(x - bw / 2, y - r - 7, (bw * d.water) / cap, 3);
    ctx.fillStyle = d.damage > 0.5 ? "#ff595e" : "#80ed99";
    ctx.fillRect(x - bw / 2, y - r - 4, bw * Math.max(0, Math.min(d.battery, 1 - d.damage)), 3);
  }

  // Which tile is under a canvas pixel?
  tileAt(px: number, py: number) {
    return { x: Math.floor(px / this.scale), y: Math.floor(py / this.scale) };
  }
}
