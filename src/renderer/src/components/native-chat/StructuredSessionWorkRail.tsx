import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { ConversationWorkHeader } from './ConversationWorkHeader'
import { useStructuredAgentSessionReadObservation } from './use-structured-agent-session-read'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

export type StructuredWorkRailRead = { sessionId: string; target: RuntimeClientTarget }

export function StructuredSessionWorkRail({
  worktreeId,
  tabId,
  paneKey,
  read
}: {
  worktreeId: string
  tabId: string
  paneKey: string
  read: StructuredWorkRailRead
}) {
  const { state } = useStructuredAgentSessionReadObservation(read)
  const messages = projectStructuredAgentSessionMessages(state.items, [], state.submissions)
  return (
    <ConversationWorkHeader
      worktreeId={worktreeId}
      paneKey={paneKey}
      tabId={tabId}
      messages={messages}
    />
  )
}
