import type { AutomationPrecheck, AutomationPrecheckResult } from '../../shared/automations-types'

export function unavailableAutomationPrecheckResult(
  precheck: AutomationPrecheck,
  error: string
): AutomationPrecheckResult {
  return {
    command: precheck.command,
    exitCode: null,
    timedOut: false,
    durationMs: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    error,
    startedAt: Date.now(),
    completedAt: Date.now()
  }
}
