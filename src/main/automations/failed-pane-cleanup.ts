import type { AutomationRun } from '../../shared/automations-types'
import { shouldCloseFailedAutomationPane } from '../../shared/automation-failed-pane'

export function createFailedAutomationPaneCleanup(
  close?: (run: AutomationRun) => Promise<void>
): (run: AutomationRun) => Promise<void> {
  const closing = new Map<string, Promise<void>>()
  return async (run) => {
    if (!close || !shouldCloseFailedAutomationPane(run)) {
      return
    }
    const existing = closing.get(run.id)
    if (existing) {
      return existing
    }
    const pending = Promise.resolve()
      .then(() => close(run))
      .catch((error) => {
        console.error('[automations] Failed to close blocked automation pane:', error)
      })
      .finally(() => closing.delete(run.id))
    closing.set(run.id, pending)
    await pending
  }
}

export type AutomationPaneCloseHost = {
  getTerminalHandleForPaneKey(paneKey: string): string | null
  showTerminal?(handle: string): Promise<{ ptyId?: string | null }>
  closeTerminal?(handle: string): Promise<unknown>
}

export async function closeOwnedAutomationRunTerminal(
  runtime: AutomationPaneCloseHost,
  run: AutomationRun
): Promise<void> {
  if (!shouldCloseFailedAutomationPane(run) || !runtime.closeTerminal || !runtime.showTerminal) {
    return
  }
  const handle = runtime.getTerminalHandleForPaneKey(run.terminalPaneKey!)
  if (!handle) {
    return
  }
  const terminal = await runtime.showTerminal(handle)
  // Why: a tab can be reused or its pane replaced while the completion observation settles.
  if (
    terminal.ptyId !== run.terminalPtyId ||
    runtime.getTerminalHandleForPaneKey(run.terminalPaneKey!) !== handle
  ) {
    return
  }
  await runtime.closeTerminal(handle)
}
