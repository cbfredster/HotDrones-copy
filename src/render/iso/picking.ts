// Picking: pointer -> tile (raycast against the instanced terrain; instanceId is the
// tile index) and pointer -> drone (nearest on screen, since drones fly above the tile
// they are over and an isometric ray would hit the ground somewhere else).
import { Raycaster, Vector2 } from "three";
import { IsoCamera } from "./camera";
import { DroneLayer } from "./drones";
import { TerrainLayer } from "./terrain";

export class Picker {
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();

  constructor(private dom: HTMLElement, private cam: IsoCamera) {}

  /** Tile index under a client-space pointer position, or null if it is off the map. */
  tileAt(clientX: number, clientY: number, terrain: TerrainLayer): number | null {
    const r = this.dom.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.cam.camera);
    const hits = this.raycaster.intersectObjects([terrain.caps, terrain.columns], false);
    return hits.length > 0 && hits[0].instanceId !== undefined ? hits[0].instanceId : null;
  }

  /** The drone drawn nearest the pointer, if one is within `maxPx` pixels. */
  droneAt(clientX: number, clientY: number, drones: DroneLayer, maxPx = 26): number | null {
    const r = this.dom.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    let best: number | null = null;
    let bd = maxPx;
    for (let k = 0; k < drones.screenX.length; k++) {
      const d = Math.hypot(drones.screenX[k] - px, drones.screenY[k] - py);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  }
}
