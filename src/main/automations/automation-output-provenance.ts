import type { AgentStatusIpcPayload } from '../../shared/agent-status-ipc-payload'
import type {
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunOutputSnapshot
} from '../../shared/automations-types'
import { readAutomationFinalTurn } from './automation-final-turn'
import type { OrchestrationCompatibilityTerminalAuthority } from '../runtime/omni-runtime'
import {
  matchesAutomationOutputAuthority,
  nativeLaunchMatchesAutomationBinding,
  type AutomationOutputBinding
} from './automation-output-binding'

export type ResolveAutomationFinalOutput = (
  run: AutomationRun,
  result: AutomationDispatchResult
) => AutomationRunOutputSnapshot | null

/** Incoming snapshot metadata is only a capture hint; it cannot grant final-message authority. */
export function withoutClaimedAssistantProvenance(
  result: AutomationDispatchResult
): AutomationDispatchResult {
  if (result.outputSnapshot?.provenance !== 'assistant_message') {
    return result
  }
  const { provenance: _provenance, ...outputSnapshot } = result.outputSnapshot
  return { ...result, outputSnapshot }
}

/** The locator comes from main's current native hook observation, not dispatch IPC or saved paths. */
export function createAutomationFinalOutputResolver(
  readNativeStatus: (paneKey: string) => readonly AgentStatusIpcPayload[],
  readFinalTurn: typeof readAutomationFinalTurn = readAutomationFinalTurn,
  readBinding: (run: AutomationRun) => AutomationOutputBinding | null = () => null,
  readAuthority: (
    terminalHandle: string
  ) => OrchestrationCompatibilityTerminalAuthority | null = () => null,
  now: () => number = Date.now
): ResolveAutomationFinalOutput {
  return (run) => {
    const binding = readBinding(run)
    if (
      !binding ||
      binding.runId !== run.id ||
      binding.automationId !== run.automationId ||
      !Number.isFinite(binding.startedAt) ||
      !matchesAutomationOutputAuthority(binding, readAuthority(binding.terminalHandle))
    ) {
      return null
    }
    const { startedAt } = binding
    const row = readNativeStatus(binding.paneKey).find(
      (entry) =>
        entry.paneKey === binding.paneKey &&
        entry.worktreeId === binding.workspaceId &&
        nativeLaunchMatchesAutomationBinding(binding, entry.launchToken) &&
        (!entry.terminalHandle || entry.terminalHandle === binding.terminalHandle) &&
        entry.connectionId === null &&
        entry.state === 'done' &&
        !entry.failed &&
        !entry.interrupted &&
        !entry.sessionBoundary &&
        !entry.providerSessionOnly &&
        !entry.restoredUnconfirmed &&
        entry.observation?.origin === 'hook' &&
        entry.observation.kind === 'transition' &&
        Number.isFinite(entry.stateStartedAt) &&
        Number.isFinite(entry.receivedAt) &&
        entry.stateStartedAt >= startedAt &&
        entry.receivedAt >= entry.stateStartedAt &&
        (entry.agentType === 'claude' || entry.agentType === 'codex') &&
        entry.providerSession?.key === 'session_id' &&
        Boolean(entry.providerSession.transcriptPath) &&
        entry.agentType === binding.agent
    )
    const readAt = now()
    if (
      !row?.providerSession?.transcriptPath ||
      !Number.isFinite(readAt) ||
      row.receivedAt > readAt
    ) {
      return null
    }
    // Snapshot primitives before reading: later hook updates cannot retarget this proof.
    const nativeTurn = {
      agent: row.agentType as 'claude' | 'codex',
      sessionId: row.providerSession.id,
      transcriptPath: row.providerSession.transcriptPath,
      startedAt,
      // Stop may precede the native final record; only already-written host-time evidence counts.
      completedAt: readAt
    }
    const proven = readFinalTurn(nativeTurn)
    if (
      !proven ||
      !Number.isFinite(proven.completedAt) ||
      proven.completedAt < startedAt ||
      proven.completedAt > readAt ||
      !matchesAutomationOutputAuthority(binding, readAuthority(binding.terminalHandle))
    ) {
      return null
    }
    return {
      format: 'plain_text',
      content: proven.content,
      capturedAt: proven.completedAt,
      truncated: false,
      provenance: 'assistant_message'
    }
  }
}
