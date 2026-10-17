import type { JunkTitleRepair } from '@/lib/session-goal-title'

const DISMISSED_STORAGE_KEY = 'omni.sessions.junkTitleRepairNotice.dismissed'

export function isJunkTitleNoticeDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

export function dismissJunkTitleNotice(): void {
  try {
    localStorage.setItem(DISMISSED_STORAGE_KEY, '1')
  } catch {
    // Why: storage can be unavailable; the notice then only stays hidden for this view.
  }
}

/** The notice's example: the first launcher title, cut short so the line stays one line. */
export function junkTitleExample(repairs: readonly JunkTitleRepair[]): string {
  const title = repairs[0]?.previous.trim() ?? ''
  return title.length > 14 ? `${title.slice(0, 12)}…` : title
}
