import { putSidebarSessionToSleep, type SessionSleepResult } from '@/lib/put-session-to-sleep'
import type { SessionSleepPlan } from '@/lib/session-sleep-target'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionBulkItem } from './SessionBulkNextStep'
import { runSessionBulkAction, type SessionBulkOutcome } from './session-bulk-outcome'

/** The part of a selection that can sleep right now; the rest is skipped, not failed. */
export function sleepableSessionItems(
  items: readonly SessionBulkItem[],
  plan: (session: SidebarSession) => SessionSleepPlan
): SessionBulkItem[] {
  return items.filter((item) => plan(item.session).ok)
}

/**
 * Sleep each item one after another: each kill settles its pane's store state before the next
 * is planned, and one refusal never stops the rest.
 */
export function sleepSessionItems(
  items: readonly SessionBulkItem[],
  sleepOne: (session: SidebarSession) => Promise<SessionSleepResult> = putSidebarSessionToSleep
): Promise<SessionBulkOutcome[]> {
  return runSessionBulkAction(items, async (item) => {
    const result = await sleepOne(item.session)
    return { ok: result.ok, ...(result.message ? { message: result.message } : {}) }
  })
}
