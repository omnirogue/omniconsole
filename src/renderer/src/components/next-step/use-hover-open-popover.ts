import { useCallback, useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

/** Pointer-enter waits this long before opening, so a pass across the control opens nothing. */
export const HOVER_OPEN_DELAY_MS = 120
/** Pointer-leave waits this long before closing, so the pointer can cross into the content. */
export const HOVER_CLOSE_DELAY_MS = 250

const OPEN_KEYS = new Set(['Enter', ' ', 'ArrowDown'])

/** Marks the anchor so the content's dismiss layer can tell it from a real outside click. */
export const HOVER_OPEN_ANCHOR_ATTRIBUTE = 'data-hover-open-anchor'
/** The shape Radix hands to onInteractOutside; only what the guard reads. */
export type HoverOpenOutsideEvent = { target: EventTarget | null; preventDefault: () => void }
export type HoverOpenAnchorProps = {
  [HOVER_OPEN_ANCHOR_ATTRIBUTE]: string
  onPointerEnter: () => void
  onPointerLeave: () => void
  onKeyDown: (event: ReactKeyboardEvent) => void
  onClick: () => void
}

export type HoverOpenContentProps = {
  onPointerMove: () => void
  onPointerEnter: () => void
  onPointerLeave: () => void
  onPointerDownCapture: () => void
  /** A press or focus on this popover's own anchor is not an outside interaction. */
  onInteractOutside: (event: HoverOpenOutsideEvent) => void
  onOpenAutoFocus: (event: Event) => void
  onCloseAutoFocus: (event: Event) => void
}

export type HoverOpenPopover = {
  /** Wire onto the Popover root; clears timers and unpins when the popover closes. */
  onOpenChange: (open: boolean) => void
  /** Keep the popover open until it is dismissed, as a click inside it does. */
  pin: () => void
  /** Spread onto the anchor (a PopoverAnchor child). Override onClick to add a selection. */
  anchorProps: HoverOpenAnchorProps
  /** Spread onto the PopoverContent. */
  contentProps: HoverOpenContentProps
}

function canHover(): boolean {
  return window.matchMedia?.('(hover: hover)').matches === true
}

/**
 * The ＋ control's behaviour, shared by every popover in Next actions: it opens on
 * pointer-enter after a short delay on hover-capable devices, pins on click or on
 * Enter / Space / ArrowDown, and closes shortly after the pointer leaves unless pinned.
 * Focus moves into the content only when the keyboard opened it, so a hover never steals it.
 */
export function useHoverOpenPopover({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): HoverOpenPopover {
  const anchorId = useId()
  const pinned = useRef(false)
  const keyboard = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = useCallback((): void => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }, [])
  useEffect(() => () => clear(), [clear])
  const leave = useCallback((): void => {
    clear()
    if (!pinned.current) {
      timer.current = setTimeout(() => onOpenChange(false), HOVER_CLOSE_DELAY_MS)
    }
  }, [clear, onOpenChange])
  const pin = useCallback((): void => {
    pinned.current = true
    clear()
  }, [clear])
  const setOpen = useCallback(
    (next: boolean): void => {
      clear()
      onOpenChange(next)
      if (!next) {
        pinned.current = false
      }
    },
    [clear, onOpenChange]
  )
  return {
    onOpenChange: setOpen,
    pin,
    anchorProps: {
      [HOVER_OPEN_ANCHOR_ATTRIBUTE]: anchorId,
      onPointerEnter: () => {
        clear()
        if (!open && canHover()) {
          keyboard.current = false
          timer.current = setTimeout(() => onOpenChange(true), HOVER_OPEN_DELAY_MS)
        }
      },
      onPointerLeave: leave,
      onKeyDown: (event) => {
        if (OPEN_KEYS.has(event.key)) {
          event.preventDefault()
          keyboard.current = true
          pin()
          onOpenChange(true)
        }
      },
      onClick: () => {
        keyboard.current = false
        // Why: on a mouse the hover has already opened it by the time the click lands; that
        // click must keep it (pin), not toggle it shut. Only a click on a pinned popover closes.
        if (open && !pinned.current) {
          pin()
          return
        }
        pin()
        onOpenChange(!open)
      }
    },
    contentProps: {
      onPointerEnter: clear,
      onPointerMove: clear,
      onPointerLeave: leave,
      onPointerDownCapture: pin,
      // Why (measured on 1.12.2): Radix treats a PopoverAnchor as outside its dismiss layer, so the
      // mouse-down focus and the pointer-down-outside it defers past the click both closed a
      // hover-opened popover right after the click. The anchor's own press must not dismiss.
      onInteractOutside: (event) => {
        const target = event.target
        if (
          target instanceof Element &&
          target.closest(`[${HOVER_OPEN_ANCHOR_ATTRIBUTE}="${anchorId}"]`)
        ) {
          event.preventDefault()
        }
      },
      onOpenAutoFocus: (event) => {
        if (!keyboard.current) {
          event.preventDefault()
        }
      },
      onCloseAutoFocus: (event) => {
        if (!keyboard.current) {
          event.preventDefault()
        }
        keyboard.current = false
      }
    }
  }
}
