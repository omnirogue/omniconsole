/**
 * What revokes conversation write fences (`conversation-write-fence.ts`): every change main hears
 * of for a conversation: a hook report for its pane, a turn signal, a chat status change. A
 * next-steps store change names no conversation, so its owner calls `recheckWriteFences` instead.
 */

import type { ConversationSource } from '../../shared/conversation-source'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import type { TurnSignal } from '../next-steps/next-step-turn-signal'
import { revokeWriteFencesWhere } from './conversation-write-fence'

type StatusHost = Pick<StructuredAgentSessionHost, 'subscribeStatus'>

const SUBSCRIBER_ID = 'conversation-write-fences'

const onPane = (paneKey: string) => (source: ConversationSource) =>
  source.kind === 'pty' && source.paneKey === paneKey

const onSession = (sessionId: string) => (source: ConversationSource) =>
  source.kind === 'structured' && source.sessionId === sessionId

function signalConversation(signal: TurnSignal): ConversationSource | undefined {
  return signal.kind === 'finished'
    ? signal.turn.conversation
    : signal.kind === 'ignore'
      ? undefined
      : signal.conversation
}

export function followConversationChangesForWriteFences(options: {
  subscribeHookReports: (listener: (report: { paneKey: string }) => void) => () => void
  subscribeTurnSignals: (listener: (signal: TurnSignal) => void) => () => void
  getHost: () => StatusHost | null
  subscribeHostChanges: (listener: (host: StatusHost | null) => void) => () => void
}): () => void {
  const unsubscribeHooks = options.subscribeHookReports((report) =>
    revokeWriteFencesWhere(onPane(report.paneKey), 'hook', report)
  )
  const unsubscribeTurns = options.subscribeTurnSignals((signal) => {
    const conversation = signalConversation(signal)
    if (conversation) {
      revokeWriteFencesWhere(
        (source) =>
          conversation.kind === 'structured' && conversation.sessionId
            ? onSession(conversation.sessionId)(source)
            : onPane(conversation.paneKey)(source),
        'turn'
      )
    }
  })
  let detach: (() => void) | null = null
  const attach = (host: StatusHost | null): void => {
    detach?.()
    detach = host
      ? host.subscribeStatus({
          id: SUBSCRIBER_ID,
          emit: (event) => {
            if (event.type === 'status') {
              revokeWriteFencesWhere(onSession(event.session.sessionId), 'turn')
            }
          }
        })
      : null
  }
  attach(options.getHost())
  const unsubscribeHost = options.subscribeHostChanges(attach)
  return () => {
    unsubscribeHooks()
    unsubscribeTurns()
    unsubscribeHost()
    detach?.()
    detach = null
  }
}
