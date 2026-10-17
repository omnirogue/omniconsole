/**
 * The requesting side's real transports: a paired runtime through its authenticated runtime RPC
 * (`callRuntimeEnvironment`), an SSH relay through its live multiplexer. Main starts one
 * `RemoteSessionHosts`; session-manage and the Work card read it.
 */

import { parseExecutionHostId } from '../../shared/execution-host'
import type { SessionHostClientTransport } from '../../shared/session-host-client'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import {
  runtimeSessionHostTransport,
  sshSessionHostTransport
} from '../session-host/session-host-client-transports'
import { activeRuntimeSessionHost } from '../session-host/session-host-runtime'
import { getSshProviderAuthority } from '../ssh/ssh-provider-authority'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { RemoteSessionHosts } from './remote-session-hosts'

let current: RemoteSessionHosts | null = null

export function getRemoteSessionHosts(): RemoteSessionHosts | null {
  return current
}

/** Resolves a host key to its transport; SSH also needs this Mac's own session host id. */
export function runtimeRemoteHostConnect(
  userDataPath: string
): (hostKey: string) => Promise<SessionHostClientTransport | null> {
  return async (hostKey) => {
    const host = parseExecutionHostId(hostKey)
    if (!host || host.kind === 'local') {
      return null
    }
    if (host.kind === 'runtime') {
      return runtimeSessionHostTransport((method, params, timeoutMs) =>
        callRuntimeEnvironment(userDataPath, host.environmentId, method, params, timeoutMs)
      )
    }
    const service = await activeRuntimeSessionHost()
      ?.service()
      .catch(() => null)
    const clientHostId = service?.identity.hostId
    if (!clientHostId) {
      return null
    }
    return sshSessionHostTransport({
      mux: () => {
        const mux = getActiveMultiplexer(host.targetId)
        if (!mux) {
          // Why thrown: not connected is "cannot be asked" (unverifiable), never "exited".
          throw new Error('That SSH host is not connected.')
        }
        return mux
      },
      connection: () => {
        const authority = getSshProviderAuthority(host.targetId)
        return `${authority.providerEpoch}:${authority.connectionGeneration}`
      },
      clientHostId
    })
  }
}

/** Main calls this once; the returned function stops it. */
export function startRemoteSessionHosts(input: { userDataPath: string }): () => void {
  const hosts = new RemoteSessionHosts({
    connect: runtimeRemoteHostConnect(input.userDataPath),
    now: Date.now
  })
  current = hosts
  return () => {
    if (current === hosts) {
      current = null
    }
  }
}
