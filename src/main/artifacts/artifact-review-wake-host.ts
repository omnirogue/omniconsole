import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'

/**
 * With no window open, the review wake reads the rows the window last listed from the session
 * owner's inventory, as the steward does (setStewardRowsWithoutWindow).
 */
type HeadlessRows = () => Promise<SessionManageSidebarRow[]>

let rowsWithoutWindow: HeadlessRows | null = null

export function setReviewWakeRowsWithoutWindow(next: HeadlessRows | null): () => void {
  const previous = rowsWithoutWindow
  rowsWithoutWindow = next
  return () => {
    rowsWithoutWindow = previous
  }
}

export function reviewWakeRowsWithoutWindow(): HeadlessRows | null {
  return rowsWithoutWindow
}
