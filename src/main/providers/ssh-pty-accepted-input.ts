import {
  PTY_ACCEPTED_INPUT_VERSION,
  type PtyAcceptedInputResult
} from '../../shared/pty-accepted-input'
import { isPtyIncarnationId } from '../../shared/pty-incarnation'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS } from './ssh-agent-session-create-operation'
import type { IPtyProvider } from './types'

export function createSshPtyAcceptedWriter(args: {
  mux: SshChannelMultiplexer
  toRelayPtyId: (id: string) => string
  hasPty: (id: string) => boolean
  getIncarnation: (relayPtyId: string) => string | undefined
}): NonNullable<IPtyProvider['writeAccepted']> {
  let capabilityProbe: Promise<boolean> | null = null
  const supportsAcceptedInput = async (): Promise<boolean> => {
    const probe =
      capabilityProbe ??
      args.mux
        .request('pty.getCapabilities', undefined, {
          timeoutMs: SSH_AGENT_SESSION_CAPABILITY_PROBE_TIMEOUT_MS
        })
        .then(
          (result) =>
            (result as { acceptedInputVersion?: unknown } | null)?.acceptedInputVersion ===
            PTY_ACCEPTED_INPUT_VERSION,
          () => false
        )
    capabilityProbe = probe
    const supported = await probe
    if (!supported && capabilityProbe === probe) {
      capabilityProbe = null
    }
    return supported
  }
  return async (id, data, options): Promise<boolean> => {
    try {
      const relayPtyId = args.toRelayPtyId(id)
      const incarnationId = args.getIncarnation(relayPtyId)
      if (!isPtyIncarnationId(incarnationId) || !args.hasPty(id) || args.mux.isDisposed()) {
        return false
      }
      if (
        !(await supportsAcceptedInput()) ||
        args.mux.isDisposed() ||
        !args.hasPty(id) ||
        args.getIncarnation(relayPtyId) !== incarnationId ||
        options?.isCurrent?.() === false
      ) {
        return false
      }
      const result = (await args.mux.request(
        'pty.writeAccepted',
        { id: relayPtyId, incarnationId, data },
        { timeoutMs: 15_000 }
      )) as PtyAcceptedInputResult | null
      return result?.accepted === true && result.incarnationId === incarnationId
    } catch {
      // A lost acknowledgement is unconfirmed input; replay could approve the next request.
      return false
    }
  }
}
