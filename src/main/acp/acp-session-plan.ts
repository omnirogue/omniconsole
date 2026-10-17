import { nativeChatPlanBlock, readNativeChatPlan } from '../../shared/native-chat-plan'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'

export function publishAcpSessionPlan(
  input: {
    agent: string
    acpSessionId: string
    assistantRecordId: string
    events?: StructuredAgentSessionEventSink
  },
  update: unknown
): void {
  const plan = readNativeChatPlan(update)
  if (!plan || !input.events) {
    return
  }
  const recordId = `${input.assistantRecordId}:plan`
  input.events.appendItem(
    {
      provider: 'legacy',
      agent: input.agent,
      sessionId: input.acpSessionId,
      recordId
    },
    { kind: 'message', role: 'system', blocks: [nativeChatPlanBlock(plan)] },
    { coalescingKey: recordId }
  )
  input.events.publish()
}
