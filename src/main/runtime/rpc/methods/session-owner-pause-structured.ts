import { randomUUID } from 'node:crypto'
import {
  conversationSourceRowKey,
  structuredConversationSource
} from '../../../../shared/conversation-source'
import { promptQueuePending } from '../../../../shared/prompt-queue-types'
import type {
  SessionOwnerPauseParams,
  SessionOwnerPauseResult
} from '../../../../shared/session-owner-pause'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../../shared/structured-agent-session-mutation'
import { getNextStepKeepGoingController } from '../../../next-steps/next-step-suggestion-slot'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { PAUSE_SOURCE_CHANGED } from '../../../session-manage/session-owner-pause'
import { SessionManageRefusal } from '../../../session-manage/session-manage-refusal'
import { assertSessionOutcomeRuntime } from '../../session-outcome-host-boundary'
import type { RpcContext } from '../core'
import { requireStructuredHost, structuredCallerFor } from './structured-agent-session-gate'

export async function pauseOwnedStructured(
  context: RpcContext,
  expectedExecutionRuntimeId: string,
  target: Extract<SessionOwnerPauseParams['target'], { kind: 'structured' }>
): Promise<SessionOwnerPauseResult> {
  const host = requireStructuredHost(context)
  const keepGoing = getNextStepKeepGoingController()
  if (!keepGoing) {
    throw new Error('Keep going state is unavailable on the execution host.')
  }
  const source = structuredConversationSource(target.worktreeId, target.sessionId)
  const assertCurrent = () => {
    assertSessionOutcomeRuntime(context, expectedExecutionRuntimeId)
    const tab = host.listSessionTabs().find((item) => item.sessionId === target.sessionId)
    const history = host.history({ sessionId: target.sessionId, direction: 'tail', limit: 200 })
    const state = host.turnState(target.sessionId)
    if (
      context.signal?.aborted ||
      getStructuredAgentSessionHost() !== host ||
      getNextStepKeepGoingController() !== keepGoing ||
      tab?.workspaceId !== target.worktreeId ||
      !history.ok ||
      history.page.sessionId !== target.sessionId ||
      history.page.fence !== target.runtimeFence ||
      !state ||
      state.awaitingStart ||
      !state.lifecycleKnown ||
      state.activeTurnId !== target.turnId ||
      state.running !== (target.turnId !== null)
    ) {
      throw new SessionManageRefusal(PAUSE_SOURCE_CHANGED)
    }
  }
  let keepGoingStopped = false
  let dispatched = false
  let queuedPrompts = 0
  const stopKeepGoing = () => {
    assertCurrent()
    keepGoingStopped = keepGoing.onSessionManaged(
      source,
      'You paused this conversation from the sidebar.',
      'person-stopped'
    )
  }
  try {
    assertCurrent()
    const queue = context.runtime.readPromptQueue(conversationSourceRowKey(source))
    queuedPrompts = queue ? promptQueuePending(queue).length : 0
    const queued = queuedPrompts
      ? ` Its ${queuedPrompts} queued prompt${queuedPrompts === 1 ? '' : 's'} remain queued and may run when it is free.`
      : ''
    if (target.turnId === null) {
      stopKeepGoing()
      return {
        state: keepGoingStopped ? 'paused' : 'already-idle',
        message: `This conversation is already idle${keepGoingStopped ? '; Keep going is now off' : '; Keep going is off'}.${queued}`,
        keepGoingStopped,
        queuedPrompts
      }
    }
    const fields = { turnId: target.turnId }
    const result = await host.cancel(structuredCallerFor(context), {
      envelope: {
        sessionId: target.sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
        expectedRuntimeFence: target.runtimeFence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: target.sessionId,
          fields
        })
      },
      ...fields,
      beforeRun: () => {
        stopKeepGoing()
        dispatched = true
      }
    })
    if (!result.ok) {
      throw new Error(result.refusal.message)
    }
    if (result.value.turnId !== target.turnId || !result.value.cancelled) {
      throw new Error(
        'The provider did not confirm cancellation. Inspect this session before retrying.'
      )
    }
    return {
      state: 'paused',
      message: `The captured turn was cancelled; Keep going is off and its transcript is retained.${queued}`,
      keepGoingStopped,
      queuedPrompts
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'The pause could not be verified.'
    return {
      state:
        !dispatched && !keepGoingStopped && error instanceof SessionManageRefusal
          ? 'source-changed'
          : 'unverifiable',
      message: `${detail}${keepGoingStopped ? ' Keep going was turned off.' : ''}`,
      keepGoingStopped,
      queuedPrompts
    }
  }
}
