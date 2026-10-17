import { vi } from 'vitest'

type CanvasTextMeasurement = Pick<CanvasRenderingContext2D, 'measureText'>

export function installTerminalCanvasTextMetrics(): void {
  // Select the 2D contract explicitly; WebGPU can be the last getContext overload.
  const canvas: { getContext(contextId: '2d'): CanvasTextMeasurement | null } =
    HTMLCanvasElement.prototype
  vi.spyOn(canvas, 'getContext').mockReturnValue({
    measureText: (): TextMetrics => ({
      width: 10,
      actualBoundingBoxAscent: 0,
      actualBoundingBoxDescent: 0,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 10,
      alphabeticBaseline: 0,
      emHeightAscent: 0,
      emHeightDescent: 0,
      fontBoundingBoxAscent: 0,
      fontBoundingBoxDescent: 0,
      hangingBaseline: 0,
      ideographicBaseline: 0
    })
  })
}
