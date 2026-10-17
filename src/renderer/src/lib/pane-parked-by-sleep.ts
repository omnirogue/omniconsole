import type { AppState } from '@/store/types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'

/**
 * A pane the hibernation timer slept and nothing has woken since: its checkpoint has the
 * automatic-sleep shape (`toAutomaticSleepRecord`; a quit or live checkpoint never does), the tab
 * holds no live PTY, and the daemon positively says the PTY its layout still names is gone. Why
 * the daemon: after a restart it keeps working agents whose tabs are not mounted yet, and their
 * layout names the PTY to reattach; parking leaves the dead one's id there too.
 */
export async function isPaneParkedBySleep(
  state: Pick<AppState, 'terminalLayoutsByTabId' | 'ptyIdsByTabId'>,
  record: SleepingAgentSessionRecord,
  hasPty: ((ptyId: string) => Promise<boolean | null>) | undefined
): Promise<boolean> {
  const pane = parsePaneKey(record.paneKey)
  if (
    !pane ||
    record.state !== 'done' ||
    record.restoreOnTabOpenOnly !== true ||
    record.resumeOnFirstReveal !== true ||
    record.interrupted
  ) {
    return false
  }
  // Why this leaf's PTY only: another pane of a split tab may run while this one sleeps.
  const recorded = state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
  if (!recorded) {
    return true
  }
  if (leafHoldsLivePty(state, record)) {
    return false
  }
  // Unknown (no daemon answer) is never taken as gone.
  return hasPty ? (await hasPty(recorded).catch(() => null)) === false : false
}

/** The pane's own recorded PTY is live in its tab (another pane of a split tab does not count). */
export function leafHoldsLivePty(
  state: Pick<AppState, 'terminalLayoutsByTabId' | 'ptyIdsByTabId'>,
  record: SleepingAgentSessionRecord
): boolean {
  const pane = parsePaneKey(record.paneKey)
  const recorded = pane
    ? state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
    : undefined
  return Boolean(pane && recorded && (state.ptyIdsByTabId[pane.tabId] ?? []).includes(recorded))
}
