import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { readTerminalTailFromHost } from './session-chain-client'
import { SESSION_CHAIN_INPUT_LINE_LIMIT, boundSessionChainInput } from './session-chain-prompt'
import { chainAbortError, workspaceRuntimeTarget } from './session-chain-support'
import type { SessionChain } from '../../../shared/session-chain-types'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { readConversationFleetTranscript } from './conversation-fleet-transcript-reader'

/** The readable conversation, including file references and structured tool results. */
export function formatSessionWorkOutput(messages: readonly NativeChatMessage[]): string {
  return messages
    .flatMap((message) => {
      if (message.role === 'reasoning' || message.role === 'system') {
        return []
      }
      const body = message.blocks
        .flatMap((block) => {
          if (block.type === 'text' && !block.providerFrame) {
            return [block.text]
          }
          if (block.type === 'image-ref') {
            return [`Attached image: ${block.path ?? block.url ?? block.alt ?? '(image)'}`]
          }
          if (block.type === 'tool-call') {
            const input =
              typeof block.input === 'string' ? block.input : JSON.stringify(block.input)
            return [`Used tool: ${block.name}${input && input !== '{}' ? `\nInput: ${input}` : ''}`]
          }
          if (block.type === 'tool-result') {
            return [`${block.isError ? 'Tool error' : 'Tool result'}: ${block.output}`]
          }
          return []
        })
        .filter((text) => text.trim())
        .join('\n')
      return body
        ? [
            `${message.role === 'user' ? 'Person' : message.role === 'assistant' ? 'Agent' : 'Tool'}:\n${body}`
          ]
        : []
    })
    .join('\n\n')
}

/** Reuse Conversation's host-owned reader for both agent and person handoffs. */
export async function readSessionWorkOutput(
  chain: Pick<SessionChain, 'worktreeId'> & { hostId?: string | null },
  paneKey: string | undefined,
  handle: string | (() => Promise<string>),
  signal: AbortSignal
): Promise<string> {
  const target = workspaceRuntimeTarget(chain.worktreeId)
  const source = paneKey ? useAppStore.getState().agentStatusByPaneKey?.[paneKey] : undefined
  const belongs = source && (!source.worktreeId || source.worktreeId === chain.worktreeId)
  const session = belongs ? source.providerSession : undefined
  const sourceSessionId = session?.id
  const sourceTranscriptPath = session?.transcriptPath
  const sourceConnectionId = source?.connectionId
  const host = parseExecutionHostId(chain.hostId)
  const connectionId = host?.kind === 'ssh' ? host.targetId : source?.connectionId
  if (belongs && source.connectionId && host && host.id !== `ssh:${source.connectionId}`) {
    throw new Error('The source conversation does not belong to this execution host.')
  }
  const checkSource = (): void => {
    if (signal.aborted) {
      throw chainAbortError()
    }
    const current = paneKey ? useAppStore.getState().agentStatusByPaneKey?.[paneKey] : undefined
    if (
      session &&
      (current?.providerSession?.id !== sourceSessionId ||
        current?.providerSession?.transcriptPath !== sourceTranscriptPath ||
        current?.connectionId !== sourceConnectionId)
    ) {
      throw new Error('The source conversation changed while preparing its next step. Try again.')
    }
  }
  checkSource()
  if (session && source?.agentType) {
    let messages: NativeChatMessage[] | undefined
    try {
      if (connectionId) {
        const transcript = await readConversationFleetTranscript(
          {
            kind: 'provider',
            hostId: `ssh:${connectionId}`,
            ...(target.kind === 'environment'
              ? { runtimeEnvironmentId: target.environmentId }
              : {}),
            agent: source.agentType,
            sessionId: session.id,
            ...(session.transcriptPath ? { transcriptPath: session.transcriptPath } : {})
          },
          new Date().toISOString(),
          signal,
          true
        )
        checkSource()
        if (transcript.kind === 'file') {
          const bytes = Uint8Array.from(atob(transcript.file.contentBase64), (char) =>
            char.charCodeAt(0)
          )
          return boundSessionChainInput(new TextDecoder().decode(bytes))
        }
        throw new Error(transcript.message)
      }
      const result = await callRuntimeRpc<{ messages?: NativeChatMessage[] }>(
        target,
        'nativeChat.readSession',
        {
          agent: source.agentType,
          sessionId: session.id,
          transcriptPath: session.transcriptPath,
          limit: 200,
          capabilities: { transcriptPending: 1 }
        },
        { timeoutMs: 15_000, signal }
      )
      messages = result.messages
    } catch (error) {
      console.warn('[session-chain] conversation transcript unavailable', error)
    }
    checkSource()
    const readable = messages ? formatSessionWorkOutput(messages) : ''
    if (readable.trim()) {
      return boundSessionChainInput(readable)
    }
  }
  // Hook prose is preferable to terminal animation when a provider's transcript
  // is unavailable. Keep it explicitly identified as the latest response.
  const reply = belongs
    ? (source.lastAssistantMessage ?? source.lastCompletedAssistantMessage)
    : undefined
  if (reply?.trim()) {
    return boundSessionChainInput(`Latest agent response:\n${reply}`)
  }
  const terminal = typeof handle === 'function' ? await handle() : handle
  checkSource()
  const tail = await readTerminalTailFromHost(
    target,
    terminal,
    SESSION_CHAIN_INPUT_LINE_LIMIT,
    signal
  )
  checkSource()
  return tail.trim()
    ? `Approximate terminal output (conversation history unavailable):\n${boundSessionChainInput(tail)}`
    : ''
}
