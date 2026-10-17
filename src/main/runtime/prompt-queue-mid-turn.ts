/**
 * A decision or review answer may go to a Claude pane that is still working: Claude queues typed
 * input and reads it at its next step. Waiting for the turn to end held answers for hours, and
 * for good when the turn was the agent waiting on that very answer.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { PromptQueueEntry } from '../../shared/prompt-queue-types'
import type { ConversationReadiness } from './conversation-readiness'
import type { OrcaRuntimeService } from './omni-runtime'
import { isPromptQueueAnswer } from './prompt-queue-answer-retry'
import { sessionPromptBinding } from './session-prompt-binding'

type MidTurnRuntime = Pick<
  OrcaRuntimeService,
  'resolveTerminalPane' | 'getFreshAgentHookStatusForHandle' | 'readTerminal'
>

/** Claude reports working on its own attached terminal, with no question or approval open. */
export function claudeWorkingWithNothingOpen(
  runtime: MidTurnRuntime,
  source: ConversationSource
): boolean {
  try {
    const { handle } = runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
    const hook = runtime.getFreshAgentHookStatusForHandle(handle)
    return (
      hook?.state === 'working' &&
      hook.agentType === 'claude' &&
      hook.onAttachedPty === true &&
      hook.providerSessionOnly !== true &&
      !hook.interactivePrompt
    )
  } catch {
    return false
  }
}

/** A decision or review answer bound to Claude in a terminal. */
export function isClaudeTerminalAnswer(
  rowKey: string,
  source: ConversationSource,
  entry: PromptQueueEntry
): boolean {
  return (
    source.kind === 'pty' &&
    isPromptQueueAnswer(entry) &&
    sessionPromptBinding(rowKey, entry.id)?.receiver?.agent === 'claude'
  )
}

/** A hook report after which Claude still takes typed input: working or done, nothing open. */
export function claudeReportKeepsInput(report: unknown): boolean {
  const { payload, providerSessionOnly } = (report ?? {}) as {
    payload?: Record<string, unknown>
    providerSessionOnly?: unknown
  }
  return (
    providerSessionOnly !== true &&
    payload?.agentType === 'claude' &&
    (payload.state === 'working' || payload.state === 'done') &&
    payload.sessionBoundary !== true &&
    !payload.interactivePrompt
  )
}

/** Why: each tool call's report revoked the fence between paste and Enter, stranding the answer. */
export const CLAUDE_ANSWER_FENCE = {
  toleratesHookReport: claudeReportKeepsInput,
  toleratesPaneTurns: true
}

/** True when this answer may be typed now although its conversation is busy. */
export async function mayAnswerMidTurn(
  runtime: MidTurnRuntime,
  rowKey: string,
  source: ConversationSource,
  entry: PromptQueueEntry,
  readiness: Pick<ConversationReadiness, 'free' | 'unverifiable'>
): Promise<boolean> {
  if (
    readiness.free ||
    readiness.unverifiable ||
    !isClaudeTerminalAnswer(rowKey, source, entry) ||
    !claudeWorkingWithNothingOpen(runtime, source)
  ) {
    return false
  }
  try {
    const { handle } = runtime.resolveTerminalPane(source.paneKey, source.worktreeId)
    const screen = await runtime.readTerminal(handle, { screen: true })
    // Why: text the person is typing there would be sent along with the answer; a suggestion is not.
    return screen.source === 'screen' && (!screen.draft?.trim() || screen.draftSuggested === true)
  } catch {
    return false
  }
}
