// Orthographic isometric camera rig: drag to pan, wheel to zoom at the cursor,
// rotate in 90° steps (hills hide things), reset. Knows nothing about the sim.
import { OrthographicCamera, Plane, Raycaster, Vector2, Vector3 } from "three";

const DIST = 400; // camera distance from its target (orthographic, so only clipping cares)
const DRAG_THRESHOLD_PX = 5;

export class IsoCamera {
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, DIST * 3);
  readonly target = new Vector3();

  /** True isometric: the view direction makes equal angles with all three axes. */
  readonly elevation = Math.atan(1 / Math.SQRT2);
  private azimuth = Math.PI / 4;
  private azimuthGoal = Math.PI / 4;
  private zoom = 1;
  private viewHeight = 60; // world units visible top-to-bottom at zoom 1
  private aspect = 1;
  private home = new Vector3();
  private map = { w: 64, h: 64 };

  private readonly raycaster = new Raycaster();
  private readonly plane = new Plane(new Vector3(0, 1, 0), 0);
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();
  private readonly ndc = new Vector2();

  /** Fit a w x h map (tallest point maxY, already vertically scaled) into the view. */
  frame(w: number, h: number, maxY: number, aspect: number) {
    this.map = { w, h };
    this.aspect = aspect;
    this.home.set((w - 1) / 2, maxY * 0.35, (h - 1) / 2);
    this.plane.constant = -this.home.y;
    this.fitViewHeight(maxY);
    this.reset();
  }

  private fitViewHeight(maxY: number) {
    const { w, h } = this.map;
    const projW = (w + h) / Math.SQRT2; // the map's footprint is a diamond on screen
    const projH = projW * Math.sin(this.elevation) + maxY * Math.cos(this.elevation);
    this.viewHeight = Math.max(projH * 1.1, (projW * 1.06) / this.aspect);
  }

  setAspect(aspect: number, maxY: number) {
    this.aspect = aspect;
    this.fitViewHeight(maxY);
    this.apply();
  }

  reset() {
    this.target.copy(this.home);
    this.zoom = 1;
    this.azimuth = this.azimuthGoal = Math.PI / 4;
    this.apply();
  }

  /** Rotate the view 90° clockwise (+1) or anticlockwise (-1) around the point being looked at. */
  rotate(dir: 1 | -1) {
    this.azimuthGoal += (dir * Math.PI) / 2;
  }

  /** Quarter-turns from the home view, for UI that wants to show the heading. */
  get quarterTurns() {
    return Math.round((this.azimuthGoal - Math.PI / 4) / (Math.PI / 2));
  }

  focus(x: number, z: number) {
    this.target.x = x;
    this.target.z = z;
    this.clampTarget();
    this.apply();
  }

  /** Advance the rotation tween. Call once per frame. */
  update(dt: number) {
    const d = this.azimuthGoal - this.azimuth;
    if (Math.abs(d) > 1e-4) {
      this.azimuth += d * (1 - Math.exp(-dt * 12));
      if (Math.abs(this.azimuthGoal - this.azimuth) < 1e-3) this.azimuth = this.azimuthGoal;
      this.apply();
    }
  }

  private apply() {
    const ce = Math.cos(this.elevation);
    this.camera.position.set(
      this.target.x + Math.cos(this.azimuth) * ce * DIST,
      this.target.y + Math.sin(this.elevation) * DIST,
      this.target.z + Math.sin(this.azimuth) * ce * DIST,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    const halfH = this.viewHeight / 2 / this.zoom;
    const halfW = halfH * this.aspect;
    this.camera.left = -halfW;
    this.camera.right = halfW;
    this.camera.top = halfH;
    this.camera.bottom = -halfH;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  private clampTarget() {
    const m = 6;
    this.target.x = Math.min(this.map.w + m, Math.max(-m, this.target.x));
    this.target.z = Math.min(this.map.h + m, Math.max(-m, this.target.z));
  }

  /** Where the pointer ray (NDC coordinates) meets the horizontal plane the camera pivots on. */
  private groundPoint(nx: number, ny: number, out: Vector3): Vector3 {
    this.ndc.set(nx, ny);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    if (!this.raycaster.ray.intersectPlane(this.plane, out)) out.copy(this.target);
    return out;
  }

  private panBetween(nx0: number, ny0: number, nx1: number, ny1: number) {
    const a = this.groundPoint(nx0, ny0, this.tmpA);
    const b = this.groundPoint(nx1, ny1, this.tmpB);
    this.target.x += a.x - b.x;
    this.target.z += a.z - b.z;
    this.clampTarget();
    this.apply();
  }

  private zoomAt(nx: number, ny: number, factor: number) {
    const before = this.groundPoint(nx, ny, this.tmpA).clone();
    this.zoom = Math.min(8, Math.max(0.5, this.zoom * factor));
    this.apply();
    const after = this.groundPoint(nx, ny, this.tmpB);
    this.target.x += before.x - after.x; // keep the point under the cursor fixed
    this.target.z += before.z - after.z;
    this.clampTarget();
    this.apply();
  }

  /**
   * Where the four corners of the screen (top-left, top-right, bottom-left, bottom-right)
   * meet the horizontal plane at height y. Used to make the opening clouds fill the view.
   */
  screenCornersAt(y: number): Vector3[] {
    const plane = new Plane(new Vector3(0, 1, 0), -y);
    const ray = new Raycaster();
    return [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ].map(([nx, ny]) => {
      ray.setFromCamera(new Vector2(nx, ny), this.camera);
      const out = new Vector3();
      if (!ray.ray.intersectPlane(plane, out)) out.copy(this.target);
      return out;
    });
  }

  /** World units covered by one screen pixel (orthographic, so it is the same everywhere). */
  unitsPerPixel(viewportHeightPx: number): number {
    return (this.camera.top - this.camera.bottom) / Math.max(1, viewportHeightPx);
  }

  /** World position -> CSS pixel position inside a viewport of the given size. Returns out. */
  project(world: Vector3, width: number, height: number, out: { x: number; y: number }) {
    const v = this.tmpA.copy(world).project(this.camera);
    out.x = (v.x * 0.5 + 0.5) * width;
    out.y = (-v.y * 0.5 + 0.5) * height;
    return out;
  }

  /**
   * On-screen angle (radians, clockwise from "right", CSS convention) of a horizontal
   * direction in the sim's x/y plane. Used by the wind compass so it stays correct
   * when the view is rotated.
   */
  screenAngle(dx: number, dy: number): number {
    const e = this.camera.matrixWorld.elements; // columns: right (0..2), up (4..6)
    const sx = dx * e[0] + dy * e[2];
    const sy = dx * e[4] + dy * e[6];
    return Math.atan2(-sy, sx);
  }

  /**
   * Wire up pointer / wheel input on `dom`. `onClick` fires for a primary-button press
   * that was released without dragging, so tools and panning never fight.
   */
  attach(dom: HTMLElement, onClick: (clientX: number, clientY: number, ev: PointerEvent) => void): () => void {
    const pointers = new Map<number, { x: number; y: number }>();
    let downX = 0;
    let downY = 0;
    let dragging = false;
    let pinchDist = 0;

    const toNdc = (cx: number, cy: number) => {
      const r = dom.getBoundingClientRect();
      return { x: ((cx - r.left) / r.width) * 2 - 1, y: -((cy - r.top) / r.height) * 2 + 1 };
    };

    const down = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        downX = e.clientX;
        downY = e.clientY;
        dragging = false;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        dragging = true; // a second finger is never a click
      }
      dom.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      if (pointers.size === 2) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchDist > 0 && d > 0) {
          const mid = toNdc((a.x + b.x) / 2, (a.y + b.y) / 2);
          this.zoomAt(mid.x, mid.y, d / pinchDist);
        }
        pinchDist = d;
        return;
      }
      if (!dragging && Math.hypot(e.clientX - downX, e.clientY - downY) < DRAG_THRESHOLD_PX) return;
      if (!dragging) {
        dragging = true;
        dom.classList.add("dragging");
      }
      const p0 = toNdc(prev.x, prev.y);
      const p1 = toNdc(e.clientX, e.clientY);
      this.panBetween(p0.x, p0.y, p1.x, p1.y);
      prev.x = e.clientX;
      prev.y = e.clientY;
    };
    const up = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
      if (pointers.size === 0) {
        dom.classList.remove("dragging");
        if (!dragging && e.button === 0 && e.type === "pointerup") onClick(e.clientX, e.clientY, e);
        dragging = false;
      }
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = toNdc(e.clientX, e.clientY);
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.zoomAt(p.x, p.y, Math.exp(-delta * 0.0015));
    };
    const noMenu = (e: Event) => e.preventDefault();

    dom.addEventListener("pointerdown", down);
    dom.addEventListener("pointermove", move);
    dom.addEventListener("pointerup", up);
    dom.addEventListener("pointercancel", up);
    dom.addEventListener("wheel", wheel, { passive: false });
    dom.addEventListener("contextmenu", noMenu);
    return () => {
      dom.removeEventListener("pointerdown", down);
      dom.removeEventListener("pointermove", move);
      dom.removeEventListener("pointerup", up);
      dom.removeEventListener("pointercancel", up);
      dom.removeEventListener("wheel", wheel);
      dom.removeEventListener("contextmenu", noMenu);
    };
  }
}
