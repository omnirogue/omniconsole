import type { SidebarSession } from '@/lib/sidebar-sessions'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { getNativeChatSessionTransport } from '@/components/native-chat/native-chat-session-transport'

export async function readRoomSessionExcerpts(session: SidebarSession): Promise<string[]> {
  const host = parseExecutionHostId(session.hostId)
  if (session.unavailable || !host || host.kind === 'ssh' || !session.providerSession) {
    throw new Error(
      'This session cannot be read here. Open its chat on the owning host and copy the text you want to share.'
    )
  }
  const result = await getNativeChatSessionTransport(
    host.kind === 'runtime' ? host.environmentId : null
  ).readSession(
    session.agent,
    session.providerSession.id,
    6,
    session.providerSession.transcriptPath
  )
  if ('error' in result) {
    throw new Error(result.error)
  }
  return result.messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .flatMap((message) => {
      const text = message.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()
      return text
        ? [
            `${message.role === 'user' ? 'User' : 'AI'}: ${text.slice(0, 2000)}${text.length > 2000 ? '\n[Excerpt truncated]' : ''}`
          ]
        : []
    })
}
