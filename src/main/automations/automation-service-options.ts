import type { Automation } from '../../shared/automations-types'
import type { ClaudeUsageStore } from '../claude-usage/store'
import type { CodexUsageStore } from '../codex-usage/store'
import type { PublishAutomationsChanged } from '../../shared/runtime-client-events'
import type { ResolveAutomationFinalOutput } from './automation-output-provenance'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { AutomationRunTerminalObserver } from './run-completion-watcher'

/** Optional integrations owned by the authority that creates the automation service. */
export type AutomationServiceOptions = {
  tickMs?: number
  claudeUsage?: ClaudeUsageStore
  codexUsage?: CodexUsageStore
  allowRemoteHostScheduling?: boolean
  headlessDispatcher?: HeadlessAutomationDispatcher
  terminalObserver?: AutomationRunTerminalObserver
  onAutomationsChanged?: PublishAutomationsChanged
  resolveFinalOutput?: ResolveAutomationFinalOutput
  /** A routine in a project leads each run with the project's brief (routine-project.ts). */
  resolveProjectBrief?: (automation: Automation) => Promise<string | null>
}
