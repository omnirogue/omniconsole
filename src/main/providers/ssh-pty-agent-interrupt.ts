import {
  ptyAgentInterruptReply,
  PTY_AGENT_INTERRUPT_METHOD
} from '../../shared/pty-agent-interrupt'
import type { IPtyProvider } from './types'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { isJsonRpcMethodNotFoundError } from './ssh-git-relay-errors'

export function createSshPtyAgentInterrupter(args: {
  mux: SshChannelMultiplexer
  toRelayPtyId: (id: string) => string
  hasPty: (id: string) => boolean
  getIncarnation: (id: string) => string | undefined
}): NonNullable<IPtyProvider['interruptAgent']> {
  let unsupported = false
  return async (id, proof, options) => {
    const relayId = args.toRelayPtyId(id)
    const isCurrent = () =>
      !args.mux.isDisposed() &&
      args.hasPty(id) &&
      args.getIncarnation(relayId) === proof.incarnationId &&
      options.isCurrent()
    if (unsupported || !proof.interruptToken || !proof.incarnationId) {
      return 'unsupported'
    }
    if (proof.ptyId !== id || !isCurrent() || options.signal.aborted) {
      return 'refused'
    }
    try {
      const parsed = ptyAgentInterruptReply.safeParse(
        await args.mux.request(
          PTY_AGENT_INTERRUPT_METHOD,
          { id: relayId, incarnationId: proof.incarnationId, interruptToken: proof.interruptToken },
          { timeoutMs: 5_000, signal: options.signal }
        )
      )
      if (!parsed.success || !isCurrent() || options.signal.aborted) {
        return 'unknown'
      }
      const reply = parsed.data
      return reply.id === relayId &&
        reply.incarnationId === proof.incarnationId &&
        reply.interruptToken === proof.interruptToken
        ? reply.outcome
        : 'unknown'
    } catch (error) {
      if (isJsonRpcMethodNotFoundError(error)) {
        unsupported = true
        return 'unsupported'
      }
      return 'unknown'
    }
  }
}
