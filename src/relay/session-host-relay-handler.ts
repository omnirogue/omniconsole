/**
 * The SSH relay as a session host. It serves the same `sessionHost.*` methods as a paired runtime
 * over relay JSON-RPC, advertises through an optional `sessionHost` field on `pty.getCapabilities`
 * (absent, exactly like an older relay, until something can be carried out), and carries each
 * connection's client declaration: `sessionHost.declareClient`, once per connection, lost on
 * reconnect, so a stale connection is told to `renegotiate` rather than served on old terms.
 */

import { randomUUID } from 'node:crypto'
import {
  readClientSessionHostDeclaration,
  SSH_SESSION_HOST_CAPABILITIES_FIELD,
  type SessionHostAdvertisement
} from '../shared/session-host-capabilities'
import {
  SESSION_HOST_RELAY_DECLARE_METHOD,
  SessionHostRelayDeclarationSchema,
  type SessionHostRelayDeclarationResult
} from '../shared/session-host-client-declaration'
import { SESSION_HOST_RPC, type SessionHostMethod } from '../shared/session-host-protocol'
import { sessionHostRefusal } from '../shared/session-host-refusal'
import { SessionHostProcess } from '../main/session-host/session-host-process'
import { handleSessionHostRemoteCall } from '../main/session-host/session-host-remote-gate'
import type { RelayDispatcher, RequestContext } from './dispatcher'

type RelaySessionHostDispatcher = Pick<
  RelayDispatcher,
  'onRequest' | 'onClientDetached' | 'isPrimaryClient'
>

type Declaration = { isStale: () => boolean; declared: SessionHostAdvertisement; client: string }

let relayProcess: SessionHostProcess | null = null

/** This relay daemon's session host; package B installs its executor here. */
export function relaySessionHostProcess(): SessionHostProcess {
  relayProcess ??= new SessionHostProcess({
    kind: 'ssh-relay',
    incarnation: `relay-${randomUUID()}`
  })
  return relayProcess
}

const UNTRUSTED = sessionHostRefusal(
  'provenance-required',
  'This relay connection has not proved who it is, so it cannot use session host control. Nothing was changed.'
)
const UNDECLARED = sessionHostRefusal(
  'renegotiate',
  'This connection has not declared its session host support since it (re)connected; it is read again before anything is sent. Nothing was changed.'
)

export class RelaySessionHostHandler {
  private readonly declarations = new Map<number, Declaration>()

  constructor(
    private readonly dispatcher: RelaySessionHostDispatcher,
    private readonly host: SessionHostProcess = relaySessionHostProcess()
  ) {
    dispatcher.onRequest(SESSION_HOST_RELAY_DECLARE_METHOD, async (params, context) =>
      this.declare(params, context)
    )
    for (const method of Object.values(SESSION_HOST_RPC)) {
      dispatcher.onRequest(
        method,
        async (params, context) => await this.call(method, params, context)
      )
    }
    dispatcher.onClientDetached((clientId) => {
      this.declarations.delete(clientId)
    })
  }

  /** Spread into `pty.getCapabilities`; empty until an executor can carry something out. */
  ptyCapabilities(): Record<string, unknown> {
    const advertisement = this.host.advertisement()
    return advertisement
      ? {
          [SSH_SESSION_HOST_CAPABILITIES_FIELD]: {
            capabilities: advertisement.capabilities,
            ...advertisement.identity
          }
        }
      : {}
  }

  // Why the launch channel counts: it is the stdio of a process the client's own SSH login started.
  private trusted(context: RequestContext): boolean {
    return (
      context.sessionIdentity?.authenticated === true ||
      this.dispatcher.isPrimaryClient(context.clientId)
    )
  }

  private declare(
    params: Record<string, unknown>,
    context: RequestContext
  ): SessionHostRelayDeclarationResult {
    if (!this.trusted(context)) {
      return { status: 'refused', refusal: UNTRUSTED }
    }
    const parsed = SessionHostRelayDeclarationSchema.safeParse(params)
    if (!parsed.success) {
      return {
        status: 'refused',
        refusal: sessionHostRefusal(
          'invalid-request',
          'The session host declaration was malformed. Nothing was changed.'
        )
      }
    }
    this.declarations.set(context.clientId, {
      isStale: context.isStale,
      declared: readClientSessionHostDeclaration(parsed.data.capabilities),
      client: parsed.data.client
    })
    return { status: 'ok' }
  }

  private async call(
    method: SessionHostMethod,
    params: Record<string, unknown>,
    context: RequestContext
  ): Promise<unknown> {
    if (!this.trusted(context)) {
      return { status: 'refused', refusal: UNTRUSTED }
    }
    const declaration = this.declarations.get(context.clientId)
    if (!declaration || declaration.isStale()) {
      this.declarations.delete(context.clientId)
      return { status: 'refused', refusal: UNDECLARED }
    }
    return await handleSessionHostRemoteCall(this.host, method, params, {
      transport: 'ssh-relay',
      peer: `ssh:${declaration.client}`,
      declared: declaration.declared,
      connection: `relay-client:${context.clientId}`
    })
  }
}
