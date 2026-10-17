import { useCallback, useEffect, useRef, useState } from 'react'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'

export const ATTENTION_SPLIT_RATIO_STORAGE_KEY = 'omni.attention-split-ratio.v1'
export const ATTENTION_SPLIT_MIN_RATIO = 0.25
export const ATTENTION_SPLIT_MAX_RATIO = 0.75
export const ATTENTION_SPLIT_DEFAULT_RATIO = 0.5

export function clampAttentionSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return ATTENTION_SPLIT_DEFAULT_RATIO
  }
  return Math.min(ATTENTION_SPLIT_MAX_RATIO, Math.max(ATTENTION_SPLIT_MIN_RATIO, ratio))
}

export function readPersistedAttentionSplitRatio(
  storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage
): number {
  try {
    const raw = storage?.getItem(ATTENTION_SPLIT_RATIO_STORAGE_KEY)
    return raw === null || raw === undefined
      ? ATTENTION_SPLIT_DEFAULT_RATIO
      : clampAttentionSplitRatio(Number(raw))
  } catch {
    return ATTENTION_SPLIT_DEFAULT_RATIO
  }
}

export function persistAttentionSplitRatio(
  ratio: number,
  storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined'
    ? null
    : localStorage
): void {
  try {
    storage?.setItem(ATTENTION_SPLIT_RATIO_STORAGE_KEY, String(clampAttentionSplitRatio(ratio)))
  } catch {
    // Why: the ratio is a per-device convenience; a blocked storage must not break the view.
  }
}

/** Pointer-driven divider between the two attention slots; the ratio is the current slot's share. */
export function useAttentionSplitRatio(): {
  ratio: number
  isResizing: boolean
  onResizeStart: (event: React.PointerEvent<HTMLElement>) => void
} {
  const [ratio, setRatio] = useState(() => readPersistedAttentionSplitRatio())
  const [isResizing, setIsResizing] = useState(false)
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  const onResizeStart = useCallback((event: React.PointerEvent<HTMLElement>) => {
    event.preventDefault()
    if (cleanupRef.current) {
      return
    }
    const handle = event.currentTarget
    const container = handle.parentElement
    if (!container) {
      return
    }
    const pointerId = event.pointerId
    handle.setPointerCapture(pointerId)
    setIsResizing(true)
    let latest: number | null = null
    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) {
        return
      }
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0) {
        return
      }
      latest = clampAttentionSplitRatio((move.clientX - rect.left) / rect.width)
      setRatio(latest)
    }
    const finish = (): void => {
      cleanupRef.current = null
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', finish)
      handle.removeEventListener('lostpointercapture', finish)
      try {
        if (handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId)
        }
      } catch {
        // Best effort: capture can already be gone during unmount.
      }
      setIsResizing(false)
      if (latest !== null) {
        persistAttentionSplitRatio(latest)
      }
      // Why: both portaled terminals changed width; refit so the PTY columns follow the new split.
      window.dispatchEvent(new Event(SYNC_FIT_PANES_EVENT))
    }
    cleanupRef.current = finish
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
    handle.addEventListener('lostpointercapture', finish)
  }, [])

  return { ratio, isResizing, onResizeStart }
}
