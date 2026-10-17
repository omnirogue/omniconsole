import type { AutomationRun } from './automations-types'

export function shouldCloseFailedAutomationPane(
  run: Pick<
    AutomationRun,
    'status' | 'error' | 'ownsTerminal' | 'terminalPaneKey' | 'terminalPtyId'
  >
): boolean {
  return (
    run.ownsTerminal === true &&
    Boolean(run.terminalPaneKey && run.terminalPtyId) &&
    run.status === 'dispatch_failed' &&
    (run.error === 'Automation agent never started after the prompt was submitted.' ||
      /^Automation agent is blocked: .+\.$/s.test(run.error ?? ''))
  )
}
