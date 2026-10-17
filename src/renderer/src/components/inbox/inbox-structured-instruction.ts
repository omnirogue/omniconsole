import type { SidebarSession } from '@/lib/sidebar-sessions'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type {
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionSendResult
} from '../../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOutboxEntry,
  structuredAgentSessionSendRequest
} from '../../../../shared/structured-agent-session-outbox'
import { createStructuredAgentSessionOperationId } from '../../../../shared/structured-agent-session-mutation'

export async function sendInboxStructuredInstruction(session: SidebarSession, text: string) {
  const host = parseExecutionHostId(session.hostId)
  const sessionId = session.structuredSessionId
  if (session.unavailable || !sessionId || !host || host.kind === 'ssh') {
    throw new Error('The selected AI conversation is unavailable on its execution host.')
  }
  const target =
    host.kind === 'runtime'
      ? { kind: 'environment' as const, environmentId: host.environmentId }
      : { kind: 'local' as const }
  const history = await callStructuredAgentSession<AgentSessionHistoryResult>(
    target,
    'agentSession.history',
    { sessionId, direction: 'tail', limit: 1 }
  )
  const fence = history.page.fence
  if (history.page.sessionId !== sessionId || !Number.isSafeInteger(fence) || fence === undefined) {
    throw new Error(
      'The AI ownership could not be verified. Open its conversation and update its runtime before sending.'
    )
  }
  const entry = createStructuredAgentSessionOutboxEntry({
    sessionId,
    clientMessageId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
    text,
    attachments: [],
    queuedAt: Date.now()
  })
  const result = await callStructuredAgentSession<
    AgentSessionMutationResult<AgentSessionSendResult>
  >(target, 'agentSession.send', structuredAgentSessionSendRequest(entry, fence))
  if (!result.ok) {
    throw new Error(result.refusal.message)
  }
  if (result.value.submission.dispatchState !== 'accepted') {
    throw new Error(
      result.value.submission.reason ??
        'The AI has not confirmed this instruction. Check the conversation before sending again.'
    )
  }
}
