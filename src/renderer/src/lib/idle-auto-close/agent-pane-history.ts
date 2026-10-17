/**
 * Panes that held an agent at any point in this app session: an agent status entry, a sleeping
 * record, or an agent the daemon or runtime saw in the pane. R2 never closes them. Why: after an
 * agent exits to its shell, R1 drops its stale done entry and writes no resume record, so the
 * pane looks like a bare shell while its scrollback is the agent's whole transcript.
 */

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

const MAX_REMEMBERED_PANES = 5_000

const paneKeys = new Set<string>()
let stopWatching: (() => void) | null = null
let users = 0

export function rememberAgentPane(paneKey: string): void {
  if (paneKeys.has(paneKey)) {
    return
  }
  if (paneKeys.size >= MAX_REMEMBERED_PANES) {
    // Why the oldest: a Set iterates in insertion order.
    paneKeys.delete(paneKeys.values().next().value!)
  }
  paneKeys.add(paneKey)
}

export function paneHeldAgentThisSession(paneKey: string): boolean {
  return paneKeys.has(paneKey)
}

function rememberFromState(
  state: Pick<AppState, 'agentStatusByPaneKey' | 'sleepingAgentSessionsByPaneKey'>
): void {
  for (const paneKey of Object.keys(state.agentStatusByPaneKey ?? {})) {
    rememberAgentPane(paneKey)
  }
  for (const paneKey of Object.keys(state.sleepingAgentSessionsByPaneKey ?? {})) {
    rememberAgentPane(paneKey)
  }
}

/** Watches the store for agent panes while either idle coordinator runs. Ref-counted. */
export function startAgentPaneHistory(): () => void {
  users += 1
  if (!stopWatching) {
    rememberFromState(useAppStore.getState())
    stopWatching = useAppStore.subscribe((state, prev) => {
      if (
        state.agentStatusByPaneKey !== prev.agentStatusByPaneKey ||
        state.sleepingAgentSessionsByPaneKey !== prev.sleepingAgentSessionsByPaneKey
      ) {
        rememberFromState(state)
      }
    })
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    users -= 1
    if (users <= 0) {
      stopWatching?.()
      stopWatching = null
      users = 0
    }
  }
}

export function resetAgentPaneHistoryForTests(): void {
  stopWatching?.()
  stopWatching = null
  users = 0
  paneKeys.clear()
}
