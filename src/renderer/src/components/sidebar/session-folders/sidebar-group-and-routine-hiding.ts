/**
 * Hiding what is not one session row: a whole group (folder, company, Other) or a routine. No
 * organization change kind names these, so they stay unrecorded per-device view edits.
 */

import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { routineHiddenKey } from '../routines/routine-view-key'

export function setSidebarGroupHidden(groupKey: string, hidden: boolean): void {
  useSessionSidebarView.getState().setHidden(groupKey, hidden)
}

export function setRoutineRowsHidden(routineKeys: readonly string[], hidden: boolean): void {
  useSessionSidebarView.getState().setHiddenMany(routineKeys.map(routineHiddenKey), hidden)
}
