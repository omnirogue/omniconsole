import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  conversationSourceRowKey,
  type ConversationSource
} from '../../../../shared/conversation-source'
import type { NextStepAdPauses } from '../../../../shared/next-step-ad-pauses'
import type {
  NextStepKeepGoingMode,
  NextStepKeepGoingState
} from '../../../../shared/next-step-keep-going'
import type {
  NextStepDecision,
  NextStepSuggestion,
  NextStepSuggestionSetStatus
} from '../../../../shared/next-step-suggestions'
import {
  NEXT_STEPS_RPC,
  type NextStepsAdPausesResult,
  type NextStepsCurrentResult,
  type NextStepsDecideResult,
  type NextStepsGenerateResult,
  type NextStepsKeepGoingResult,
  type NextStepsLinkTaskResult,
  type NextStepsListResult,
  type NextStepsOfferParsedResult
} from '../../../../shared/next-step-suggestions-rpc'

// Why local: suggestion sets live beside the prompt queue on this desktop's own runtime.
const LOCAL = { kind: 'local' } as const

/** Exactly the fields the host's strict schema accepts. */
function address(conversation: ConversationSource): ConversationSource {
  return {
    worktreeId: conversation.worktreeId,
    paneKey: conversation.paneKey,
    kind: conversation.kind,
    ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {})
  }
}

export function listNextStepSets(filter: {
  worktreeId?: string
  conversation?: ConversationSource
  statuses?: readonly NextStepSuggestionSetStatus[]
}): Promise<NextStepsListResult> {
  return callRuntimeRpc<NextStepsListResult>(LOCAL, NEXT_STEPS_RPC.list, {
    ...(filter.worktreeId ? { worktreeId: filter.worktreeId } : {}),
    ...(filter.conversation ? { conversation: address(filter.conversation) } : {}),
    ...(filter.statuses ? { statuses: filter.statuses } : {})
  })
}

/**
 * Asks the host for suggestions now. `force` (only the explicit "Suggest again") overrides the
 * skip rules; the host still refuses a turn that was already answered.
 */
export function generateNextStepSet(
  conversation: ConversationSource,
  force = false
): Promise<NextStepsGenerateResult> {
  return callRuntimeRpc<NextStepsGenerateResult>(LOCAL, NEXT_STEPS_RPC.generate, {
    conversation: address(conversation),
    ...(force ? { force: true } : {})
  })
}

export function decideNextStepSet(
  setId: string,
  decision: NextStepDecision,
  /** Only for a start set: the new conversation that takes it. */
  conversation?: ConversationSource
): Promise<NextStepsDecideResult> {
  return callRuntimeRpc<NextStepsDecideResult>(LOCAL, NEXT_STEPS_RPC.decide, {
    setId,
    decision,
    ...(conversation ? { conversation: address(conversation) } : {})
  })
}

/** The workspace's suggested starts for this hour; `force` asks the suggester again. */
export function suggestNextStepStart(params: {
  worktreeId: string
  taskId?: string
  agent?: string
  force?: boolean
}): Promise<NextStepsGenerateResult> {
  return callRuntimeRpc<NextStepsGenerateResult>(LOCAL, NEXT_STEPS_RPC.suggestStart, {
    worktreeId: params.worktreeId,
    ...(params.taskId ? { taskId: params.taskId } : {}),
    ...(params.agent ? { agent: params.agent } : {}),
    ...(params.force ? { force: true } : {})
  })
}

/** The conversation's current turn as the host knows it. */
export function readCurrentNextSteps(
  conversation: ConversationSource
): Promise<NextStepsCurrentResult> {
  return callRuntimeRpc<NextStepsCurrentResult>(LOCAL, NEXT_STEPS_RPC.current, {
    conversation: address(conversation)
  })
}

/** The hub card this conversation serves (null: none), for JEV's doneness goal on the host. */
export function linkNextStepTask(
  conversation: ConversationSource,
  taskId: string | null
): Promise<NextStepsLinkTaskResult> {
  return callRuntimeRpc<NextStepsLinkTaskResult>(LOCAL, NEXT_STEPS_RPC.linkTask, {
    conversation: address(conversation),
    taskId
  })
}

/** Offers the steps read from one reply; the host places them on the turn that wrote it. */
export function offerParsedNextStepSet(
  conversation: ConversationSource,
  messageId: string,
  suggestions: readonly NextStepSuggestion[]
): Promise<NextStepsOfferParsedResult> {
  return callRuntimeRpc<NextStepsOfferParsedResult>(LOCAL, NEXT_STEPS_RPC.offerParsed, {
    conversation: address(conversation),
    messageId,
    suggestions: suggestions.map(({ id, title, prompt, why, risk, kind }) => ({
      id,
      title,
      prompt,
      ...(why ? { why } : {}),
      risk,
      kind
    }))
  })
}

// Why a chain per conversation: requests reach the host in the order they were made, so an
// older "on" can never land after, and undo, a newer "off".
const keepGoingRequests = new Map<string, Promise<unknown>>()

export function setNextStepKeepGoing(
  conversation: ConversationSource,
  enabled: boolean,
  maxRounds?: number,
  reason?: 'person-acted' | 'person-typing',
  run: { mode?: NextStepKeepGoingMode; pushPrompt?: string } = {}
): Promise<NextStepKeepGoingState> {
  const key = conversationSourceRowKey(conversation)
  const send = () =>
    callRuntimeRpc<NextStepsKeepGoingResult>(LOCAL, NEXT_STEPS_RPC.keepGoing, {
      conversation: address(conversation),
      enabled,
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(reason ? { reason } : {}),
      // Only a push run names its mode, so an older host still reads a plain "Keep going".
      ...(run.mode === 'push-for-better' ? { mode: run.mode } : {}),
      ...(run.mode === 'push-for-better' && run.pushPrompt ? { pushPrompt: run.pushPrompt } : {})
    }).then((result) => result.state)
  return inKeepGoingOrder(key, send)
}

/** This conversation's ad-pause choice; null follows the global setting. */
export function setNextStepAdPauses(
  conversation: ConversationSource,
  adPauses: NextStepAdPauses | null
): Promise<NextStepKeepGoingState> {
  const send = () =>
    callRuntimeRpc<NextStepsAdPausesResult>(LOCAL, NEXT_STEPS_RPC.adPauses, {
      conversation: address(conversation),
      adPauses
    }).then((result) => result.state)
  return inKeepGoingOrder(conversationSourceRowKey(conversation), send)
}

function inKeepGoingOrder<T>(key: string, send: () => Promise<T>): Promise<T> {
  const previous = keepGoingRequests.get(key) ?? Promise.resolve()
  const request = previous.then(send, send)
  const settled = request.catch(() => undefined)
  keepGoingRequests.set(key, settled)
  void settled.then(() => {
    if (keepGoingRequests.get(key) === settled) {
      keepGoingRequests.delete(key)
    }
  })
  return request
}
