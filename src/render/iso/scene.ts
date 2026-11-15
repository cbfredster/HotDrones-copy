// Scene, lights and the WebGL renderer. No sim knowledge in here beyond the map size.
import {
  AmbientLight,
  Color,
  DirectionalLight,
  HemisphereLight,
  PCFShadowMap,
  Scene,
  Vector3,
  WebGLRenderer,
} from "three";

export class IsoScene {
  readonly scene = new Scene();
  readonly gl: WebGLRenderer;
  readonly sun: DirectionalLight;
  readonly canvas: HTMLCanvasElement;
  private width = 1;
  private height = 1;

  constructor(readonly container: HTMLElement) {
    this.gl = new WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.gl.shadowMap.enabled = true;
    this.gl.shadowMap.type = PCFShadowMap; // crisp-edged directional shadows
    this.canvas = this.gl.domElement;
    this.canvas.className = "iso-canvas";
    container.appendChild(this.canvas);

    this.scene.background = new Color(0x18222e);

    // Toy-box lighting: one strong warm sun for crisp shadows, plus a cool sky fill so
    // faces turned away from the sun stay saturated instead of going black.
    this.sun = new DirectionalLight(0xfff2d9, 2.7);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);
    this.scene.add(new HemisphereLight(0xd6ecff, 0x7a6248, 1.25));
    this.scene.add(new AmbientLight(0xffffff, 0.35));
  }

  /** Aim the sun and size its shadow box to cover a w x h map whose tallest point is maxY. */
  fitToMap(w: number, h: number, maxY: number, fullHeight = false) {
    const cx = (w - 1) / 2;
    const cz = (h - 1) / 2;
    const radius = Math.hypot(w, h, fullHeight ? maxY : 0) / 2 + 2;
    const cy = fullHeight ? maxY / 2 : 0;
    const dir = new Vector3(-0.55, 1.0, -0.32).normalize();
    this.sun.target.position.set(cx, cy, cz);
    this.sun.position.set(cx + dir.x * radius * 2, cy + dir.y * radius * 2, cz + dir.z * radius * 2);
    const cam = this.sun.shadow.camera;
    cam.left = -radius;
    cam.right = radius;
    cam.top = radius;
    cam.bottom = -radius;
    cam.near = 1;
    cam.far = radius * 4 + maxY;
    cam.updateProjectionMatrix();
    this.sun.shadow.needsUpdate = true;
  }

  /** Match the canvas to its container. Returns true if the size changed. */
  resize(): boolean {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    if (w === this.width && h === this.height) return false;
    this.width = w;
    this.height = h;
    this.gl.setSize(w, h, false);
    return true;
  }

  get aspect() {
    return this.width / this.height;
  }
  get size() {
    return { width: this.width, height: this.height };
  }

  dispose() {
    this.gl.dispose();
    this.canvas.remove();
  }
}
