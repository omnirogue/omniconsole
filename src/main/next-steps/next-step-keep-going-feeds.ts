/**
 * What "Keep going" reads beyond turn signals: whether an agent is waiting on the person (a
 * question or permission prompt) or its last turn failed, for PTY hook rows and chat sessions.
 */

import type { AgentStatusPayload } from '../../shared/agent-status-types'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  structuredConversationSource,
  type ConversationSource
} from '../../shared/conversation-source'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { NextStepKeepGoingAttention } from './next-step-keep-going-guards'

type AttentionHost = Pick<
  StructuredAgentSessionHost,
  'subscribeStatus' | 'liveSessionStatusSummaries' | 'turnState'
>

const SUBSCRIBER_ID = 'next-step-keep-going'

export function hookRowAttention(
  row: Pick<AgentStatusPayload, 'state' | 'interactivePrompt' | 'failed'>
): NextStepKeepGoingAttention | null {
  if (row.state === 'waiting' || row.state === 'blocked' || row.interactivePrompt) {
    return 'agent-waiting'
  }
  // A failure is a failure whatever state it is reported in.
  return row.failed ? 'turn-failed' : null
}

export function chatSummaryAttention(
  summary: Pick<AgentSessionStatusSummary, 'status' | 'failed' | 'sessionId'>,
  host: Pick<AttentionHost, 'turnState'> | null
): NextStepKeepGoingAttention | null {
  if (summary.status === 'attention') {
    return 'agent-waiting'
  }
  // Any failure signal is a failure, whatever status it arrives with.
  return summary.failed || host?.turnState(summary.sessionId)?.outcome === 'failed'
    ? 'turn-failed'
    : null
}

export function readChatAttention(
  host: AttentionHost | null,
  source: ConversationSource
): NextStepKeepGoingAttention | null {
  const summary = host
    ?.liveSessionStatusSummaries()
    .find((entry) => entry.sessionId === source.sessionId)
  return summary ? chatSummaryAttention(summary, host) : null
}

/** A chat session's `attention` status never becomes a turn signal; this reports it. */
export function followChatAttention(options: {
  getHost: () => AttentionHost | null
  subscribeHostChanges: (listener: (host: AttentionHost | null) => void) => () => void
  onAttention: (conversation: ConversationSource, attention: NextStepKeepGoingAttention) => void
}): () => void {
  let detach: (() => void) | null = null
  const attach = (host: AttentionHost | null): void => {
    detach?.()
    detach = host
      ? host.subscribeStatus({
          id: SUBSCRIBER_ID,
          emit: (event) => {
            if (event.type !== 'status') {
              return
            }
            const attention = chatSummaryAttention(event.session, host)
            if (attention) {
              const { workspaceId, sessionId } = event.session
              options.onAttention(structuredConversationSource(workspaceId, sessionId), attention)
            }
          }
        })
      : null
  }
  attach(options.getHost())
  const unsubscribeHost = options.subscribeHostChanges(attach)
  return () => {
    unsubscribeHost()
    detach?.()
    detach = null
  }
}
