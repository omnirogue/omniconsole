import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** Moves sooner than this after a launch are part of the click, not a new intent to hover. */
export const HOVER_REARM_QUIET_MS = 800

/**
 * After a click-launch the menu must stay shut while the pointer rests on "+", even though the
 * reveal re-lays out the sidebar and slides "+" out from under the cursor and back (measured
 * live on 792a1dce3: pointerleave at +100 ms, pointerenter at +590 ms, menu at +715 ms). Those
 * layout-driven boundary events carry no movement, so only a real pointer move after a short
 * quiet period re-arms hover-open.
 */
export function useHoverRearmOnMove(): { isSuppressed: () => boolean; suppress: () => void } {
  const suppressedAt = useRef<number | null>(null)
  const [listening, setListening] = useState(false)
  useEffect(() => {
    if (!listening) {
      return
    }
    const onMove = (event: PointerEvent): void => {
      const since = suppressedAt.current
      if (
        (event.movementX === 0 && event.movementY === 0) ||
        (since !== null && Date.now() - since < HOVER_REARM_QUIET_MS)
      ) {
        return
      }
      suppressedAt.current = null
      setListening(false)
    }
    window.addEventListener('pointermove', onMove, true)
    return () => window.removeEventListener('pointermove', onMove, true)
  }, [listening])
  const suppress = useCallback((): void => {
    suppressedAt.current = Date.now()
    setListening(true)
  }, [])
  const isSuppressed = useCallback((): boolean => suppressedAt.current !== null, [])
  return useMemo(() => ({ isSuppressed, suppress }), [isSuppressed, suppress])
}
