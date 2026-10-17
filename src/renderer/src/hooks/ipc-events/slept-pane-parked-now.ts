import { isTerminalTabOnScreen } from '@/lib/idle-auto-close/idle-keep-guards'
import { isPaneParkedBySleep, leafHoldsLivePty } from '@/lib/pane-parked-by-sleep'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { useAppStore } from '../../store'

/** Drops a parked pane's checkpoint so revealing the tab starts nothing; false while it runs. */
export async function forgetSleptPane(paneKey: string): Promise<boolean> {
  if (!useAppStore.getState().sleepingAgentSessionsByPaneKey?.[paneKey]) {
    return true
  }
  if (!(await sleptPaneParkedNow(paneKey))) {
    return false
  }
  useAppStore.getState().clearSleepingAgentSession(paneKey)
  return true
}

/**
 * The pane is parked by sleep right now. Why re-read after the daemon answers: a person may have
 * opened the tab meanwhile, and its own restore keeps the checkpoint until its spawn succeeds.
 */
export async function sleptPaneParkedNow(paneKey: string): Promise<boolean> {
  const record = useAppStore.getState().sleepingAgentSessionsByPaneKey?.[paneKey]
  if (
    !record ||
    !(await isPaneParkedBySleep(useAppStore.getState(), record, window.api?.pty?.hasPty))
  ) {
    return false
  }
  const state = useAppStore.getState()
  const tabId = parsePaneKey(paneKey)?.tabId
  return (
    state.sleepingAgentSessionsByPaneKey?.[paneKey] === record &&
    !(tabId && isTerminalTabOnScreen(tabId)) &&
    !leafHoldsLivePty(state, record)
  )
}
