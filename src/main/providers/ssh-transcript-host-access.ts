import {
  SSH_OMP_CHAT_METHOD,
  SSH_OMP_CHAT_CAPABILITY,
  type SshOmpChatResult
} from '../../shared/ssh-native-chat'
import type { AgentTranscriptHostAccess } from '../../shared/agent-transcript-host-access'
import type { NativeChatTranscriptPageResult } from '../../shared/native-chat-transcript-page'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isMethodNotFoundError } from '../ssh/ssh-filesystem-stream-reader'

export function createSshTranscriptHostAccess(
  mux: SshChannelMultiplexer
): AgentTranscriptHostAccess {
  const request = async (
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<unknown> => {
    try {
      return await mux.request(method, params, { signal, timeoutMs: 130_000 })
    } catch (error) {
      if (isMethodNotFoundError(error)) {
        throw new Error(
          'Update the SSH relay to capture this provider transcript on its owning host.'
        )
      }
      throw error
    }
  }
  return {
    readOmpTail: async (args, signal) => {
      const response = (await request(SSH_OMP_CHAT_METHOD, args, signal)) as {
        capability?: string
        agent?: string
        sessionId?: string
        result?: SshOmpChatResult
      }
      if (
        response?.capability !== SSH_OMP_CHAT_CAPABILITY ||
        response.agent !== args.agent ||
        response.sessionId !== args.sessionId ||
        !response.result
      ) {
        throw new Error(
          'omp_transcript_capability_unavailable: SSH host did not attest the requested session.'
        )
      }
      return response.result
    },
    resolveSource: async (agent, sessionId, signal) => {
      const result = await request('transcript.resolveSource', { agent, sessionId }, signal)
      if (result === null) {
        return null
      }
      const source = result as { agent?: unknown; sessionId?: unknown; filePath?: unknown }
      const sourceAgent = resolveNativeChatTranscriptAgent(agent) ?? agent
      if (
        source.agent !== sourceAgent ||
        source.sessionId !== sessionId ||
        typeof source.filePath !== 'string' ||
        !source.filePath
      ) {
        throw new Error('The owning SSH host returned an invalid transcript source identity.')
      }
      return source.filePath
    },
    readOpenCodePage: async (args, signal) => {
      const result = await request(
        'transcript.readOpenCodePage',
        {
          ...args,
          connectionId: undefined,
          ...(args.cursor ? { cursor: { ...args.cursor, connectionId: null } } : {})
        },
        signal
      )
      if (
        !result ||
        typeof result !== 'object' ||
        (result as NativeChatTranscriptPageResult).source?.connectionId !== null
      ) {
        throw new Error('The owning SSH host did not acknowledge its OpenCode transcript capture.')
      }
      return result as NativeChatTranscriptPageResult
    }
  }
}
