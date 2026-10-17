import type { Store } from '../persistence'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { AutomationRun } from '../../shared/automations-types'
import type { AutomationRunWriter } from './automation-run-writer'
import { collectAutomationRunUsage } from './run-usage-collection'
export async function recordAutomationCompletionUsage(
  store: Store,
  writer: AutomationRunWriter,
  run: AutomationRun,
  claudeUsage: ClaudeUsageStore | null,
  codexUsage: CodexUsageStore | null
): Promise<AutomationRun> {
  // Duplicate completions must not advance an already attributed usage window.
  if (run.usage) {
    return run
  }
  const usage = await collectAutomationRunUsage({
    automation: store.listAutomations().find((entry) => entry.id === run.automationId),
    run,
    claudeUsage,
    codexUsage
  })
  if (!store.listAutomationRuns(run.automationId).some((entry) => entry.id === run.id)) {
    return run
  }
  return writer.updateRun({
    runId: run.id,
    status: run.status,
    workspaceId: run.workspaceId,
    terminalSessionId: run.terminalSessionId,
    usage,
    error: run.error
  })
}
