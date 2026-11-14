// The corner minimap: the original top-down 2D renderer, reused at a few pixels per
// tile. It shows either the true map or the selected drone's own fire map.
import { Renderer, ViewOptions } from "../render/renderer";
import { World } from "../sim/world";

export type MinimapMode = "auto" | "truth" | "belief";
const NEXT: Record<MinimapMode, MinimapMode> = { auto: "truth", truth: "belief", belief: "auto" };

export class Minimap {
  mode: MinimapMode = "auto";
  private renderer: Renderer | null = null;
  private world: World | null = null;
  private lastLabel = "";

  /** @param onFocus called with sim coordinates when the minimap is clicked */
  constructor(
    private canvas: HTMLCanvasElement,
    private button: HTMLButtonElement,
    onFocus: (x: number, y: number) => void,
  ) {
    button.onclick = () => {
      this.mode = NEXT[this.mode];
    };
    canvas.addEventListener("click", (e) => {
      if (!this.renderer) return;
      const rect = canvas.getBoundingClientRect();
      const px = ((e.clientX - rect.left) * canvas.width) / rect.width;
      const py = ((e.clientY - rect.top) * canvas.height) / rect.height;
      const t = this.renderer.tileAt(px, py);
      onFocus(t.x, t.y);
    });
  }

  setWorld(world: World) {
    this.world = world;
    this.renderer = new Renderer(this.canvas, world);
  }

  /**
   * Which drone's belief the minimap shows (null = the truth).
   * "auto" complements the main view: if the 3D view shows the truth, the minimap shows
   * the selected drone's map, and the other way round.
   */
  private source(view: ViewOptions): number | null {
    if (view.selected === null || this.mode === "truth") return null;
    if (this.mode === "belief") return view.selected;
    return view.beliefOf === null ? view.selected : null;
  }

  draw(view: ViewOptions) {
    if (!this.renderer || !this.world) return;
    const beliefOf = this.source(view);
    this.renderer.draw({ ...view, beliefOf, showSensors: false, compact: true });
    const what = beliefOf === null ? "Truth" : `Drone #${beliefOf}'s map`;
    const label = this.mode === "auto" ? what : `${what} (locked)`;
    if (label !== this.lastLabel) {
      this.lastLabel = label;
      this.button.textContent = label;
    }
  }
}
