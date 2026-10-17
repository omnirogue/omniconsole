import { parseNativeChatSessionModel } from '../../../../shared/native-chat-session-model'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { NativeChatSessionTransport } from './native-chat-session-transport'
import { parseRuntimeNativeChatReadSessionResult } from './native-chat-runtime-contract'
import type { SshOmpChatResult } from '../../../../shared/ssh-native-chat'

/** Polls are serialized, cancelled on hide, and always resolve on the SSH owner. */
export function createSshOmpChatTransport(connectionId: string): NativeChatSessionTransport {
  let readWindow: { sessionId: string; limit: number } | undefined
  const read = async (agent: string, sessionId: string, limit = 300, signal?: AbortSignal) => {
    try {
      if (agent !== 'omp') {
        throw new Error('This SSH transcript transport requires OMP.')
      }
      readWindow = {
        sessionId,
        limit: Math.min(
          Math.max(limit, readWindow?.sessionId === sessionId ? readWindow.limit : 0),
          2000
        )
      }
      return await callRuntimeRpc<SshOmpChatResult>(
        { kind: 'local' },
        'nativeChat.readSshOmpSession',
        { connectionId, agent, sessionId, limit: readWindow.limit },
        { signal, timeoutMs: 140_000 }
      )
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'SSH transcript unavailable.' }
    }
  }
  return {
    readSession: async (agent, sessionId, limit) =>
      parseRuntimeNativeChatReadSessionResult(await read(agent, sessionId, limit)),
    subscribe: (args, onFrame) => {
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      let lastSnapshot: string | undefined
      const poll = async (): Promise<void> => {
        const result = await read(args.agent, args.sessionId, args.limit, controller.signal)
        if (controller.signal.aborted) {
          return
        }
        const snapshot = JSON.stringify(result)
        if (snapshot !== lastSnapshot) {
          lastSnapshot = snapshot
          onFrame(
            'messages' in result
              ? {
                  type: 'snapshot',
                  messages: result.messages,
                  hasMore: result.hasMore,
                  lifecycle: result.lifecycle,
                  model: parseNativeChatSessionModel(result.model)
                }
              : {
                  type: 'snapshot',
                  messages: [],
                  hasMore: false,
                  ...('notFound' in result && result.notFound
                    ? { pending: true }
                    : { error: result.error })
                }
          )
        }
        timer = setTimeout(() => {
          void poll()
        }, 1500)
      }
      void poll()
      return () => {
        controller.abort()
        if (timer) {
          clearTimeout(timer)
        }
      }
    }
  }
}
