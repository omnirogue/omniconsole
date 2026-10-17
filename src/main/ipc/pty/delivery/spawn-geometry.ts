import { ptySizes } from './visibility-state'
import type { PtySpawnResult } from '../../../providers/types'

type PtySize = { cols: number; rows: number }
export type PtySpawnGeometry = {
  id: string
  previous: PtySize | undefined
  provisional: PtySize | undefined
}

export function beginPtySpawnGeometry(
  id: string | undefined,
  requested: PtySize,
  fresh: boolean
): PtySpawnGeometry | null {
  if (id === undefined) {
    return null
  }
  const previous = ptySizes.get(id)
  // A retained provider does not resize when attaching; only fresh creation owns these dimensions.
  const provisional =
    fresh && previous === undefined ? { cols: requested.cols, rows: requested.rows } : undefined
  if (provisional) {
    ptySizes.set(id, provisional)
  }
  return { id, previous, provisional }
}

export function restorePtySpawnGeometry(
  geometry: PtySpawnGeometry | null,
  discardPrevious = false
): void {
  if (!geometry || ptySizes.get(geometry.id) !== (geometry.provisional ?? geometry.previous)) {
    return
  }
  if (!discardPrevious && geometry.previous) {
    ptySizes.set(geometry.id, geometry.previous)
  } else {
    ptySizes.delete(geometry.id)
  }
}

export function commitPtySpawnGeometry(
  geometry: PtySpawnGeometry | null,
  result: Pick<PtySpawnResult, 'id' | 'isReattach' | 'appliedSize'>,
  requested: PtySize
): void {
  if (result.isReattach || geometry?.id !== result.id) {
    restorePtySpawnGeometry(geometry)
  }
  const size = result.isReattach ? result.appliedSize : requested
  if (
    !size ||
    !Number.isSafeInteger(size.cols) ||
    size.cols <= 0 ||
    !Number.isSafeInteger(size.rows) ||
    size.rows <= 0
  ) {
    return
  }
  const current = ptySizes.get(result.id)
  const expected =
    geometry?.id === result.id
      ? result.isReattach
        ? geometry.previous
        : (geometry.provisional ?? geometry.previous)
      : undefined
  // A resize replaces the object even when its numeric dimensions equal the spawn defaults.
  if (current === expected) {
    ptySizes.set(result.id, { cols: size.cols, rows: size.rows })
  }
}
