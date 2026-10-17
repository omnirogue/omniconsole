import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { resolveTerminalCloseTarget } from '@/components/terminal/terminal-close-target'
import { useAppStore } from '@/store'

const CLOSE_OUTCOME_TIMEOUT_MS = 15_000

/** Agent states that mean the tab is not finished: busy, or asking the person something. */
const UNFINISHED_STATES: ReadonlySet<string> = new Set(['working', 'waiting', 'blocked'])

/** True when any pane of the tab still has an agent working or waiting on the person. */
export function sessionTabHasUnfinishedAgent(tabId: string): boolean {
  const prefix = `${tabId}:`
  return Object.entries(useAppStore.getState().agentStatusByPaneKey).some(
    ([paneKey, status]) => paneKey.startsWith(prefix) && UNFINISHED_STATES.has(status?.state ?? '')
  )
}

/** True while the tab is still open on this device. */
export function sessionTabIsOpen(tabId: string): boolean {
  return resolveTerminalCloseTarget(useAppStore.getState(), tabId, undefined) !== null
}

/**
 * Close a session's tab the way a person would (history kept, reopenable from Recently closed).
 * True once the tab is closed, false when the close was declined, null when still undecided.
 */
export function closeSessionTab(
  tabId: string,
  options: { rejectPinned?: boolean } = {}
): Promise<boolean | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), CLOSE_OUTCOME_TIMEOUT_MS)
    const settle = (outcome: boolean): void => {
      clearTimeout(timer)
      resolve(outcome)
    }
    closeTerminalTab(tabId, {
      reason: 'user',
      captureRecentlyClosed: true,
      skipRunningProcessConfirm: true,
      // Why: a close nobody is watching must never wait on a modal; a pinned tab just stays open.
      ...(options.rejectPinned ? { rejectPinned: true } : {}),
      onClosed: () => settle(true),
      onCancel: () => settle(false)
    })
  })
}
