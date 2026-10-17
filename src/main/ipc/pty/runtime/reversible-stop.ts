import type { PtyRuntimeControllerDeps } from './controller-deps'

/** Preserve renderer bindings while a reversible physical stop is in flight. */
export function markReversibleStopsFromRuntimeController(
  deps: PtyRuntimeControllerDeps,
  ptyIds: readonly string[]
): () => void {
  const { reversibleStopOwnersByPtyId } = deps
  for (const ptyId of ptyIds) {
    reversibleStopOwnersByPtyId.set(ptyId, (reversibleStopOwnersByPtyId.get(ptyId) ?? 0) + 1)
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    for (const ptyId of ptyIds) {
      const owners = (reversibleStopOwnersByPtyId.get(ptyId) ?? 0) - 1
      if (owners > 0) {
        reversibleStopOwnersByPtyId.set(ptyId, owners)
      } else {
        reversibleStopOwnersByPtyId.delete(ptyId)
      }
    }
  }
}
