/** The real readings behind `SessionObserveSources`: this runtime, its chat host and next steps. */

import { conversationSourceRowKey, type ConversationSource } from '../../shared/conversation-source'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  getNextStepKeepGoingController,
  getNextStepSuggestionService
} from '../next-steps/next-step-suggestion-slot'
import { currentNextSteps } from '../next-steps/next-step-turn-answers'
import { conversationPlanWaits } from '../runtime/conversation-chain-ownership'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { UNREAD_TURN, type SessionLatestTurn } from './session-manage-freeform'
import {
  readLatestTurn,
  snapshotLatestTurn,
  type ConversationNeverReplied
} from './session-manage-latest-turn'
import type { SessionObserveSources } from './session-manage-observe'
import { readSessionOwnSteps, type SessionOwnSteps } from './session-manage-steps'
import { readRuntimeSessionPrompt } from './session-prompt-runtime'

export type SessionManageRuntime = Pick<
  OrcaRuntimeService,
  | 'resolveTerminalPane'
  | 'getTerminalLivenessVerdict'
  | 'getTerminalAgentStatus'
  | 'getFreshAgentHookStatusForHandle'
  | 'getLastAgentHookRowForPane'
  | 'readTerminalAgentEvidence'
  | 'hasTerminalExitReceipt'
  | 'getTerminalTitleAgentStatus'
  | 'readPromptQueue'
  | 'readTerminal'
  | 'listSessionChains'
>

export const SESSION_EVIDENCE_TIMEOUT_MS = 3_000

/** The session's own open steps, read the way the tray reads them (`nextSteps.current`). */
export function readRuntimeOwnSteps(source: ConversationSource | null): Promise<SessionOwnSteps> {
  const service = getNextStepSuggestionService()
  return readSessionOwnSteps(
    service ? (conversation) => currentNextSteps(service, conversation) : null,
    source
  )
}

/** Only the structured host can positively establish that a conversation has never replied. */
export function runtimeNeverReplied(
  _runtime: Pick<OrcaRuntimeService, 'getLastAgentHookRowForPane'>
): ConversationNeverReplied {
  return (source) => {
    if (source.kind === 'structured') {
      const state = source.sessionId
        ? getStructuredAgentSessionHost()?.turnState(source.sessionId)
        : null
      return Boolean(state && !state.hasTurn && !state.running && !state.awaitingStart)
    }
    // Missing hooks also occur on existing conversations; absence cannot authorize a first prompt.
    return false
  }
}

/** The latest finished turn the next-steps host holds, read as one revision (`latest-turn`). */
export async function readRuntimeLatestTurn(
  source: ConversationSource,
  neverReplied: ConversationNeverReplied
): Promise<SessionLatestTurn> {
  const service = getNextStepSuggestionService()
  try {
    return service ? await readLatestTurn(service, source, neverReplied) : UNREAD_TURN
  } catch {
    return UNREAD_TURN
  }
}

/** The same reading, synchronously, from what the host holds in memory now. */
export function snapshotRuntimeLatestTurn(
  source: ConversationSource,
  neverReplied: ConversationNeverReplied
): SessionLatestTurn {
  const service = getNextStepSuggestionService()
  try {
    return service ? snapshotLatestTurn(service, source, neverReplied) : UNREAD_TURN
  } catch {
    return UNREAD_TURN
  }
}

export function isKeepGoingOn(source: ConversationSource): boolean {
  return getNextStepKeepGoingController()?.list({ conversation: source })[0]?.enabled === true
}

export function createRuntimeObserveSources(runtime: SessionManageRuntime): SessionObserveSources {
  return {
    resolvePane(paneKey, worktreeId) {
      try {
        const pane = runtime.resolveTerminalPane(paneKey, worktreeId)
        return { handle: pane.handle, connected: pane.connected === true, ptyId: pane.ptyId }
      } catch {
        return null
      }
    },
    livenessUnverifiable(handle) {
      const verdict = runtime.getTerminalLivenessVerdict(handle)
      return verdict?.status === 'unverifiable' ? verdict.reason : null
    },
    async agentStatus(handle) {
      try {
        const status = await runtime.getTerminalAgentStatus(handle)
        return { running: status.isRunningAgent, status: status.status }
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (message === 'terminal_exited' || message === 'terminal_gone') {
          return 'gone'
        }
        throw error
      }
    },
    hook(handle) {
      const hook = runtime.getFreshAgentHookStatusForHandle(handle)
      return hook
        ? {
            state: hook.state,
            ...(hook.workingMode ? { workingMode: hook.workingMode } : {}),
            ...(hook.prompt ? { prompt: hook.prompt } : {}),
            interactivePrompt: hook.interactivePrompt,
            ...(hook.failed ? { failed: true } : {}),
            ...(hook.failureReason ? { failureReason: hook.failureReason } : {}),
            updatedAt: hook.updatedAt,
            ...(hook.agentPid !== undefined ? { agentPid: hook.agentPid } : {})
          }
        : null
    },
    exitReceipt: (handle) => runtime.hasTerminalExitReceipt(handle),
    titleStatus: (handle) => {
      try {
        return runtime.getTerminalTitleAgentStatus(handle)
      } catch {
        return null
      }
    },
    lastHook(paneKey) {
      const row = runtime.getLastAgentHookRowForPane(paneKey)
      if (!row) {
        return null
      }
      return {
        state: row.state,
        ...(row.workingMode ? { workingMode: row.workingMode } : {}),
        ...(row.prompt ? { prompt: row.prompt } : {}),
        interactivePrompt: row.interactivePrompt ?? null,
        ...(row.failed ? { failed: true } : {}),
        ...(row.failureReason ? { failureReason: row.failureReason } : {}),
        updatedAt: row.receivedAt,
        ...(row.restoredUnconfirmed ? { restored: true } : {}),
        ...(row.agentType ? { agent: row.agentType } : {}),
        ...(row.agentPid !== undefined ? { agentPid: row.agentPid } : {})
      }
    },
    evidence(handle, expectedAgent) {
      // A wedged SSH relay must not hold the whole list; a late reading is no reading.
      return withTimeout(
        runtime.readTerminalAgentEvidence(handle, expectedAgent),
        SESSION_EVIDENCE_TIMEOUT_MS,
        null
      )
    },
    chat(sessionId) {
      const host = getStructuredAgentSessionHost()
      if (!host) {
        return null
      }
      const held = host.listSessionTabs().some((tab) => tab.sessionId === sessionId)
      const summary = host
        .liveSessionStatusSummaries()
        .find((entry) => entry.sessionId === sessionId)
      return {
        held,
        reading: summary
          ? {
              status: summary.status,
              ...(summary.failed ? { failed: true } : {}),
              ...(summary.failureReason ? { failureReason: summary.failureReason } : {}),
              updatedAt: summary.updatedAt
            }
          : null
      }
    },
    queue(source) {
      return runtime.readPromptQueue(conversationSourceRowKey(source))
    },
    async ownSteps(source) {
      return (await readRuntimeOwnSteps(source)).steps.map((step) => step.title)
    },
    keepGoing: isKeepGoingOn,
    planWaits: (source) => conversationPlanWaits(runtime.listSessionChains(), source),
    prompt: (row, terminal) => readRuntimeSessionPrompt(runtime, row, terminal)
  }
}
