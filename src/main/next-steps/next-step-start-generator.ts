/**
 * The suggester call for a session's first message: the same read-only runner, parsing and risk
 * floor as a turn's, asked for the best first steps in this workspace.
 */

import { getCommitMessageAgentSpec } from '../../shared/commit-message-agent-spec'
import type { ConsoleTaskCard, ConsoleWorkflowResult } from '../../shared/console-workflow-types'
import {
  buildNextStepStartPrompt,
  type NextStepStartCard
} from '../../shared/next-step-start-prompt'
import type { NextStepSuggestion } from '../../shared/next-step-suggestions'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { NextStepConversationLiveness } from './next-step-start-carry-over'
import { runNextStepSuggester, type NextStepGeneratorDeps } from './next-step-suggestion-generator'
import type { NextStepGenerateOutcome } from './next-step-suggestion-service'

export type NextStepStartRequest = {
  worktreeId: string
  /** The agent the new session runs; the suggester when settings choose none. */
  agent?: string
  /** The hub card the session was launched from. */
  taskId?: string
  carryOver: readonly NextStepSuggestion[]
}

/** What suggested starts add to the service's deps. */
export type NextStepStartServiceDeps = {
  /** One suggester call for a new session's first steps; absent = carry-over only. */
  generateStart?: (
    request: NextStepStartRequest,
    signal: AbortSignal
  ) => Promise<NextStepGenerateOutcome>
  /** The runner's lane for a workspace that has no conversation yet. */
  workspaceLaneOf?: (worktreeId: string) => string | null
  /** Carry-over is taken only from conversations this says are not live; absent = none. */
  isConversationLive?: NextStepConversationLiveness
}

export type NextStepStartGeneratorDeps = NextStepGeneratorDeps & {
  /** The hub's own card read (`/api/work/card/<id>`); absent = the card cannot be read here. */
  readTaskCard?: (args: { taskId: string }) => Promise<ConsoleWorkflowResult<ConsoleTaskCard>>
}

export const NEXT_STEP_START_CARD_TIMEOUT_MS = 10_000

/** The card's title, next action and description; never throws, never waits past the timeout. */
export async function readNextStepStartCard(
  read: NextStepStartGeneratorDeps['readTaskCard'],
  taskId: string,
  timeoutMs: number = NEXT_STEP_START_CARD_TIMEOUT_MS
): Promise<NextStepStartCard> {
  if (!read) {
    return { unavailable: true }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    const reading = read({ taskId })
    // Why: a read that loses the race must not surface later as an unhandled rejection.
    reading.catch(() => undefined)
    const result = await Promise.race([reading, timeout])
    if (!result?.ok) {
      return { unavailable: true }
    }
    const card = result.data
    return {
      title: card.title,
      ...(card.nextAction ? { nextAction: card.nextAction } : {}),
      // Why description: the desktop's card read carries no separate resume field.
      ...(card.description ? { resume: card.description } : {})
    }
  } catch (error) {
    console.warn('[next-steps] task card unavailable for', taskId, error)
    return { unavailable: true }
  } finally {
    clearTimeout(timer)
  }
}

export async function generateNextStepStart(
  deps: NextStepStartGeneratorDeps,
  request: NextStepStartRequest,
  signal: AbortSignal
): Promise<NextStepGenerateOutcome> {
  const card = request.taskId
    ? await readNextStepStartCard(deps.readTaskCard, request.taskId)
    : undefined
  if (signal.aborted) {
    return { ok: false, error: 'Suggestions were cancelled.' }
  }
  const workingSpec = isTuiAgent(request.agent)
    ? getCommitMessageAgentSpec(request.agent)
    : undefined
  return runNextStepSuggester(
    deps,
    { worktreeId: request.worktreeId, workingAgent: request.agent },
    (git) =>
      buildNextStepStartPrompt({
        ...(workingSpec ? { agentLabel: workingSpec.label } : {}),
        carryOver: request.carryOver,
        ...(git ? { git } : {}),
        ...(card ? { card } : {})
      }),
    signal
  )
}
