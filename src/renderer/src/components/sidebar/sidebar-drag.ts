import { useSyncExternalStore } from 'react'
import type { DropSide } from '../../../../shared/sidebar-layout'

/**
 * The one sidebar row being dragged, as a page-wide record.
 *
 * Why a store and not `dataTransfer`: `dataTransfer.getData()` is unreadable during
 * `dragover` (the spec's protected mode), and every group needs to decide DURING
 * hover whether the row in flight is its own reorder, a row arriving from a group
 * it accepts, or nothing to do with it. A payload it cannot read cannot answer that.
 */

export type SidebarDrag = { scope: string; id: string; label: string }

let current: SidebarDrag | null = null
let pending: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function sidebarDragInFlight(): SidebarDrag | null {
  return current
}

/**
 * Record the drag ONE TICK AFTER `dragstart`, never inside it.
 *
 * Setting it re-renders the sidebar — a drop zone appears, the source row fades —
 * and Chromium cancels a drag whose start mutates the document under the pointer.
 * Done synchronously, the gesture ends the instant it begins. The console measured
 * this on 2026-09-09 and it cost about forty minutes to find; it is not a style
 * preference.
 */
export function beginSidebarDrag(next: SidebarDrag): void {
  if (pending) {
    clearTimeout(pending)
  }
  pending = setTimeout(() => {
    pending = null
    current = next
    emit()
  }, 0)
}

export function clearSidebarDrag(): void {
  // A cancelled drag's `dragend` can beat the tick above, so cancel it too.
  if (pending) {
    clearTimeout(pending)
    pending = null
  }
  if (current !== null) {
    current = null
    emit()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSidebarDrag(): SidebarDrag | null {
  return useSyncExternalStore(subscribe, sidebarDragInFlight, () => null)
}

/**
 * Which half of the row the pointer is over, measured on the row HEADER rather
 * than the whole element: a drop anywhere over an expanded company's departments
 * must read as "after that company", not as a drop inside it.
 */
export function dropSideOf(event: { currentTarget: HTMLElement; clientY: number }): DropSide {
  const header =
    event.currentTarget.querySelector<HTMLElement>('[data-sidebar-row-header]') ??
    event.currentTarget
  const box = header.getBoundingClientRect()
  return Math.round(event.clientY - box.top) > Math.round(box.height / 2) ? 'after' : 'before'
}

/** A redundant payload, so a drop still works if the store was cleared early. */
export { SIDEBAR_DRAG_MIME } from '../../../../shared/session-sidebar-drag-types'
