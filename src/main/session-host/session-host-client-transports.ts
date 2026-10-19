/**
 * The two ways a Mac reaches an execution host, as `SessionHostClient` transports. A paired runtime
 * declares this client's support on its authenticated socket already, and stamps every reply with
 * its `runtimeId` (the incarnation). An SSH relay is probed with `pty.getCapabilities` and told this
 * client's declaration once per connection.
 */

import {
  readRelaySessionHostAdvertisement,
  readRuntimeSessionHostAdvertisement,
  type SessionHostAdvertisement
} from '../../shared/session-host-capabilities'
import type { SessionHostClientTransport } from '../../shared/session-host-client'
import {
  SESSION_HOST_RELAY_DECLARE_METHOD,
  type SessionHostRelayDeclarationResult
} from '../../shared/session-host-client-declaration'
import type { SessionHostReceivedRefusal } from '../../shared/session-host-refusal'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { SESSION_HOST_RPC } from '../../shared/session-host-protocol'

const SESSION_HOST_REQUEST_TIMEOUT_MS = 30_000
/** A restart waits up to 30 s on its host for the agent's own report, so its reply needs longer. */
const SESSION_HOST_RESTART_TIMEOUT_MS = 45_000

export function sessionHostCallTimeoutMs(method: string, params: unknown): number {
  return method === SESSION_HOST_RPC.execute &&
    (params as { action?: unknown } | null)?.action === 'restart'
    ? SESSION_HOST_RESTART_TIMEOUT_MS
    : SESSION_HOST_REQUEST_TIMEOUT_MS
}

export type RuntimeSessionHostRequest = (
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<RuntimeRpcResponse<unknown>>

/** `runtimeId` IS the incarnation; an advertisement that disagrees is not trusted. */
function runtimeAdvertisement(status: unknown): SessionHostAdvertisement {
  const advertisement = readRuntimeSessionHostAdvertisement(status)
  const runtimeId = (status as { runtimeId?: unknown } | null)?.runtimeId
  return advertisement.status === 'advertised' && advertisement.identity?.incarnation !== runtimeId
    ? { status: 'malformed', detail: 'runtime sessionHost incarnation is not its runtimeId' }
    : advertisement
}

export function runtimeSessionHostTransport(
  request: RuntimeSessionHostRequest
): SessionHostClientTransport {
  return {
    probe: async () => {
      const response = await request('status.get', undefined, SESSION_HOST_REQUEST_TIMEOUT_MS)
      if (!response.ok) {
        throw Object.assign(new Error(response.error.message), { code: response.error.code })
      }
      return runtimeAdvertisement(response.result)
    },
    call: async (method, params) => {
      const response = await request(method, params, sessionHostCallTimeoutMs(method, params))
      return response.ok
        ? { ok: true, result: response.result, incarnation: response._meta.runtimeId }
        : { ok: false, error: response.error }
    },
    connection: () => null
  }
}

export type SshSessionHostMultiplexer = {
  request(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number }
  ): Promise<unknown>
}

/**
 * `connection` must change whenever the relay connection is replaced (a new multiplexer), so the
 * declaration is sent again; `clientHostId` is this Mac's own session host id.
 */
export function sshSessionHostTransport(input: {
  mux: () => SshSessionHostMultiplexer
  connection: () => string | null
  clientHostId: string
}): SessionHostClientTransport {
  return {
    probe: async () =>
      readRelaySessionHostAdvertisement(
        await input
          .mux()
          .request('pty.getCapabilities', undefined, { timeoutMs: SESSION_HOST_REQUEST_TIMEOUT_MS })
      ),
    declare: async (capabilities): Promise<SessionHostReceivedRefusal | null> => {
      const result = (await input
        .mux()
        .request(
          SESSION_HOST_RELAY_DECLARE_METHOD,
          { capabilities: [...capabilities], client: input.clientHostId },
          { timeoutMs: SESSION_HOST_REQUEST_TIMEOUT_MS }
        )) as SessionHostRelayDeclarationResult | null
      return result?.status === 'ok'
        ? null
        : (result?.refusal ?? {
            code: 'invalid-request',
            message: 'The relay did not accept this client’s declaration.'
          })
    },
    call: async (method, params) => {
      try {
        const result = await input.mux().request(method, params as Record<string, unknown>, {
          timeoutMs: sessionHostCallTimeoutMs(method, params)
        })
        return { ok: true, result }
      } catch (error) {
        return { ok: false, error }
      }
    },
    connection: input.connection
  }
}
