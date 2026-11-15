/** Owns async selection ordering, including providers which ignore AbortSignal. */
export class LatestRequest {
  private generation = 0;
  private controller?: AbortController;

  begin() {
    this.cancel();
    const generation = this.generation;
    const controller = this.controller = new AbortController();
    return { signal: controller.signal, current: () => generation === this.generation && !controller.signal.aborted };
  }

  cancel() {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
  }
}
