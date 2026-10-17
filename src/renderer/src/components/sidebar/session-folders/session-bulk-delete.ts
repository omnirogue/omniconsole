import { closeTerminalTab } from '@/components/terminal/terminal-tab-actions'
import { useAppStore } from '@/store'
import { buildTerminalTabRetirementPlan } from '@/store/slices/terminal-tab-retirement'

/** True when any pane in the tab reports a working agent; a bulk close leaves such a tab alone. */
export function isSessionTabWorking(tabId: string): boolean {
  const prefix = `${tabId}:`
  return Object.entries(useAppStore.getState().agentStatusByPaneKey).some(
    ([paneKey, status]) => paneKey.startsWith(prefix) && status?.state === 'working'
  )
}

const CLOSE_OUTCOME_TIMEOUT_MS = 15_000

/**
 * Ask main to drop the closed tab's saved row. Why: main owns saved terminal membership for
 * repos with a topology revision and rebases renderer saves onto it, so a tab with no live
 * terminal would otherwise come back on restart. Fail-open: an older preload without the
 * method, or a rejected call, must not turn a completed close into a failure.
 */
async function retireSavedTab(tabId: string): Promise<void> {
  try {
    await window.api.session.retireDeletedTerminalTab?.(tabId)
  } catch (error) {
    console.warn('[session-sidebar] saved tab retirement failed', error)
  }
}

/**
 * The PTYs a delete of this tab leaves running: another live tab on this computer, not a
 * paired-host mirror row, still shows them (`TerminalTabRetirementOptions.deleteSession`).
 */
export function deleteKeepsPtyIds(tabId: string): string[] {
  return buildTerminalTabRetirementPlan(useAppStore.getState(), tabId, { deleteSession: true })
    .sharedPtyIds
}

/**
 * Close one conversation's tab the way a person would (history kept, reopenable from
 * Recently closed) and report what was observed. The running-process prompt is skipped
 * because the caller already confirmed the batch and skipped working tabs; a pinned tab
 * may still decline, and a close that never reports back is "unverified", not "closed".
 * It is a delete, so the pane's PTY ends even when a paired-host mirror row still lists it
 * (Recently closed reopens the history in a new terminal, never this process), and those
 * mirror rows go with it. `endProcess: false` removes the row only, ending no terminal: the
 * person let go of a row this computer cannot verify, and a PTY it still lists may be a live
 * session shown elsewhere.
 */
export function closeSessionTabForBulk(
  tabId: string,
  options: { captureRecentlyClosed?: boolean; endProcess?: boolean } = {}
): Promise<'closed' | 'declined' | 'unverified'> {
  const endProcess = options.endProcess !== false
  // Why planned here: closeTab builds the same plan but reports nothing back, and the mirror
  // rows must be read before the close removes the tab that named them.
  const mirrorTabIds = endProcess
    ? buildTerminalTabRetirementPlan(useAppStore.getState(), tabId, { deleteSession: true })
        .mirrorTabIds
    : []
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('unverified'), CLOSE_OUTCOME_TIMEOUT_MS)
    const settle = (outcome: 'closed' | 'declined'): void => {
      clearTimeout(timer)
      resolve(outcome)
    }
    closeTerminalTab(tabId, {
      reason: 'user',
      captureRecentlyClosed: options.captureRecentlyClosed !== false,
      skipRunningProcessConfirm: true,
      ...(endProcess ? { deleteSession: true } : { localPtyTeardownOwnedExternally: true }),
      onClosed: () => {
        for (const mirrorTabId of mirrorTabIds) {
          // Why no teardown: the PTY it listed is already ending with the deleted tab.
          closeTerminalTab(mirrorTabId, {
            reason: 'cleanup',
            captureRecentlyClosed: false,
            skipRunningProcessConfirm: true,
            rejectPinned: true,
            localPtyTeardownOwnedExternally: true
          })
        }
        void Promise.all([tabId, ...mirrorTabIds].map(retireSavedTab)).then(() => settle('closed'))
      },
      onCancel: () => settle('declined')
    })
  })
}
