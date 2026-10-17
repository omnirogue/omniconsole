import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { sessionOutcomeConnection } from '@/lib/session-outcome-connection'
import type { SessionOutcomeRuntimeTarget } from '../../../../shared/session-outcome-routing'

export type UpNextConnection = {
  assertCurrent: () => void
  call: <T>(method: string, params: Record<string, unknown>) => Promise<T>
}

export const LOCAL_UP_NEXT_CONNECTION: UpNextConnection = {
  assertCurrent: () => {},
  call: (method, params) => callRuntimeRpc({ kind: 'local' }, method, params)
}

/** Retain the negotiated runtime and pairing for the lifetime of this composer. */
export function upNextConnection(
  owner: SessionOutcomeRuntimeTarget,
  pairingRevision?: number
): UpNextConnection {
  if (owner.kind === 'local') {
    return LOCAL_UP_NEXT_CONNECTION
  }
  const connection = sessionOutcomeConnection(owner, pairingRevision)
  let negotiated: ReturnType<typeof connection.negotiate> | undefined
  return {
    assertCurrent: connection.assertCurrent,
    call: async <T>(method: string, params: Record<string, unknown>): Promise<T> => {
      const host = await (negotiated ??= connection.negotiate().catch((error: unknown) => {
        negotiated = undefined
        throw error
      }))
      if (host.capabilities.upNextRemoteOwnership !== 1) {
        throw new Error(
          'Update this execution host to use Up next. No local fallback is permitted.'
        )
      }
      return host.call<T>(method, params)
    }
  }
}
