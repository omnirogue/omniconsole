type Canvas2DTarget = {
  getContext(
    contextId: '2d',
    options?: CanvasRenderingContext2DSettings
  ): CanvasRenderingContext2D | null
}

// Scope DOM-renderer spies to the 2D overload even when WebGPU types are loaded.
export function canvas2DTestTarget(): Canvas2DTarget {
  return HTMLCanvasElement.prototype
}
