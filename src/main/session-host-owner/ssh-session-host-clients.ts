/**
 * One session host client per SSH connection, for this Mac's own writers. A new relay connection
 * (a new multiplexer) gets a new client, so its declaration is sent again (`renegotiate`).
 */

import { randomUUID } from 'node:crypto'
import { SessionHostClient } from '../../shared/session-host-client'
import {
  sshSessionHostTransport,
  type SshSessionHostMultiplexer
} from '../session-host/session-host-client-transports'
import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'

const clients = new Map<string, { mux: SshSessionHostMultiplexer; client: SessionHostClient }>()
const connections = new WeakMap<object, string>()

/** Null when the target is not connected here, or this Mac has no session host identity yet. */
export function sshSessionHostClientFor(connectionId: string): SessionHostClient | null {
  let mux: SshSessionHostMultiplexer | undefined
  try {
    mux = getActiveMultiplexer(connectionId)
  } catch {
    return null
  }
  const hostId = activeRuntimeSessionHost()?.current()?.identity.hostId
  if (!mux || !hostId) {
    return null
  }
  const held = clients.get(connectionId)
  if (held?.mux === mux) {
    return held.client
  }
  const connection = connections.get(mux) ?? randomUUID()
  connections.set(mux, connection)
  const current = mux
  const client = new SessionHostClient(
    sshSessionHostTransport({
      mux: () => current,
      connection: () => connection,
      clientHostId: hostId
    })
  )
  clients.set(connectionId, { mux: current, client })
  return client
}
