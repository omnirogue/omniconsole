/**
 * The requesting Mac's side of session host control, over either transport. It negotiates before
 * sending anything, re-probes after a reconnect or a host restart, and turns every failure into an
 * explicit refusal: an unsupported host is never answered locally or by raw terminal input, and a
 * lost reply is `host-unreachable` (the outcome is unknown and nothing is resent automatically).
 */

import {
  SESSION_HOST_CLIENT_CAPABILITIES,
  type SessionHostAdvertisement
} from './session-host-capabilities'
import type { SessionHostIdentity } from './session-host-identity'
import {
  isSessionHostNegotiationCurrent,
  negotiateSessionHostCapabilities,
  requireSessionHostAction,
  requireSessionHostMethod,
  type SessionHostNegotiation
} from './session-host-negotiation'
import {
  SESSION_HOST_METHOD_CAPABILITY,
  SESSION_HOST_RPC,
  type SessionHostMethod,
  type SessionHostObserveParams,
  type SessionHostOperationParams,
  type SessionHostReleaseParams,
  type SessionHostRequest,
  type SessionHostWaitStatusParams
} from './session-host-protocol'
import {
  isSessionHostMethodMissing,
  sessionHostMissingMethodRefusal,
  type SessionHostReceivedRefusal
} from './session-host-refusal'
import {
  readSessionHostReply,
  SessionHostExecuteReplySchema,
  SessionHostObserveReplySchema,
  SessionHostOperationReplySchema,
  SessionHostWaitStatusReplySchema
} from './session-host-reply-schema'
import {
  requireRelocationBundleCapability,
  SessionHostBundleReadReplySchema,
  SessionHostBundleWriteReplySchema,
  type SessionHostBundleReadParams,
  type SessionHostBundleWriteParams
} from './session-host-relocation-bundle'
import { SessionHostStatsReplySchema } from './session-host-stats'
import type { z } from 'zod'

export type SessionHostTransportReply =
  | { ok: true; result: unknown; incarnation?: string }
  | { ok: false; error: unknown }

export type SessionHostClientTransport = {
  /** Reads the host's advertisement (`status.get` or `pty.getCapabilities`). */
  probe(): Promise<SessionHostAdvertisement>
  /** SSH only: declares this client's support on the current connection. */
  declare?(capabilities: readonly string[]): Promise<SessionHostReceivedRefusal | null>
  call(method: SessionHostMethod, params: unknown): Promise<SessionHostTransportReply>
  /** The current connection; a different value means a reconnect happened. */
  connection(): string | null
}

export type SessionHostClientReply<T> =
  | T
  | { status: 'refused'; refusal: SessionHostReceivedRefusal }

export const SESSION_HOST_UNREACHABLE: SessionHostReceivedRefusal = {
  code: 'host-unreachable',
  message:
    'That computer could not be reached or did not answer, so the outcome is unknown. Nothing is resent automatically.'
}

export class SessionHostClient {
  private negotiated: SessionHostNegotiation | null = null
  /** The host process the last reply came from; a change makes the negotiation stale. */
  private lastSeen: SessionHostIdentity | null = null

  constructor(
    private readonly transport: SessionHostClientTransport,
    private readonly local: readonly string[] = SESSION_HOST_CLIENT_CAPABILITIES
  ) {}

  negotiation(): SessionHostNegotiation | null {
    return this.negotiated
  }

  /**
   * Probes (and on SSH declares) afresh; nothing else is sent. Null when the host could not be
   * asked at all: that is `host-unreachable`, never "it predates session host control".
   */
  async negotiate(): Promise<SessionHostNegotiation | null> {
    this.negotiated = null
    let advertisement: SessionHostAdvertisement
    try {
      advertisement = await this.transport.probe()
    } catch {
      return null
    }
    const connection = this.transport.connection()
    let negotiation = negotiateSessionHostCapabilities({
      side: 'client',
      local: this.local,
      peer: advertisement,
      ...(connection ? { connection } : {})
    })
    if (negotiation.agreed.length > 0 && this.transport.declare) {
      let refusal: SessionHostReceivedRefusal | null
      try {
        refusal = await this.transport.declare(this.local)
      } catch {
        return null
      }
      if (refusal) {
        negotiation = {
          ...negotiation,
          peerStatus: 'malformed',
          agreed: [],
          detail: refusal.message
        }
      }
    }
    this.lastSeen = negotiation.peer
    this.negotiated = negotiation
    return negotiation
  }

  private async current(): Promise<SessionHostNegotiation | null> {
    const binding = { peer: this.lastSeen, connection: this.transport.connection() }
    return this.negotiated && isSessionHostNegotiationCurrent(this.negotiated, binding)
      ? this.negotiated
      : await this.negotiate()
  }

  private async send<T>(
    method: SessionHostMethod,
    params: unknown,
    schema: z.ZodType<T>,
    refusalFor: (negotiation: SessionHostNegotiation) => SessionHostReceivedRefusal | null,
    retried = false
  ): Promise<SessionHostClientReply<T>> {
    const negotiation = await this.current()
    if (!negotiation) {
      return { status: 'refused', refusal: SESSION_HOST_UNREACHABLE }
    }
    const refusal = refusalFor(negotiation)
    if (refusal) {
      return { status: 'refused', refusal }
    }
    let answer: SessionHostTransportReply
    try {
      answer = await this.transport.call(method, params)
    } catch (error) {
      answer = { ok: false, error }
    }
    if (!answer.ok) {
      this.negotiated = null
      return isSessionHostMethodMissing(answer.error)
        ? {
            status: 'refused',
            refusal: sessionHostMissingMethodRefusal(method, SESSION_HOST_METHOD_CAPABILITY[method])
          }
        : { status: 'refused', refusal: SESSION_HOST_UNREACHABLE }
    }
    if (
      answer.incarnation &&
      negotiation.peer &&
      answer.incarnation !== negotiation.peer.incarnation
    ) {
      this.lastSeen = { hostId: negotiation.peer.hostId, incarnation: answer.incarnation }
    }
    const read = readSessionHostReply(schema, answer.result)
    if (!read.ok) {
      return { status: 'refused', refusal: read.refusal }
    }
    const replied = read.reply as { status?: string; refusal?: { code?: string } }
    // Why one identical repeat: the host lost this connection's declaration (a reconnect); the
    // retry rule for `renegotiate` is to re-probe and send the same request again.
    if (!retried && replied.status === 'refused' && replied.refusal?.code === 'renegotiate') {
      this.negotiated = null
      return await this.send(method, params, schema, refusalFor, true)
    }
    return read.reply
  }

  observe(params: SessionHostObserveParams = {}) {
    return this.send(SESSION_HOST_RPC.observe, params, SessionHostObserveReplySchema, (n) =>
      requireSessionHostMethod(n, SESSION_HOST_RPC.observe)
    )
  }

  execute(request: SessionHostRequest) {
    return this.send(SESSION_HOST_RPC.execute, request, SessionHostExecuteReplySchema, (n) =>
      requireSessionHostAction(n, request.action, relocationProvider(request))
    )
  }

  reserve(request: SessionHostRequest) {
    return this.send(
      SESSION_HOST_RPC.reserve,
      request,
      SessionHostExecuteReplySchema,
      (n) =>
        requireSessionHostMethod(n, SESSION_HOST_RPC.reserve) ??
        requireSessionHostAction(n, request.action, relocationProvider(request))
    )
  }

  release(params: SessionHostReleaseParams) {
    return this.send(SESSION_HOST_RPC.release, params, SessionHostExecuteReplySchema, (n) =>
      requireSessionHostMethod(n, SESSION_HOST_RPC.release)
    )
  }

  operation(params: SessionHostOperationParams) {
    return this.send(SESSION_HOST_RPC.operation, params, SessionHostOperationReplySchema, (n) =>
      requireSessionHostMethod(n, SESSION_HOST_RPC.operation)
    )
  }

  relocationBundleRead(params: SessionHostBundleReadParams) {
    return this.send(
      SESSION_HOST_RPC.bundleRead,
      params,
      SessionHostBundleReadReplySchema,
      (n) =>
        requireSessionHostMethod(n, SESSION_HOST_RPC.bundleRead) ??
        requireRelocationBundleCapability(n, params.provider)
    )
  }

  relocationBundleWrite(params: SessionHostBundleWriteParams) {
    return this.send(
      SESSION_HOST_RPC.bundleWrite,
      params,
      SessionHostBundleWriteReplySchema,
      (n) =>
        requireSessionHostMethod(n, SESSION_HOST_RPC.bundleWrite) ??
        requireRelocationBundleCapability(n, params.provider)
    )
  }

  waitStatus(params: SessionHostWaitStatusParams) {
    return this.send(SESSION_HOST_RPC.waitStatus, params, SessionHostWaitStatusReplySchema, (n) =>
      requireSessionHostMethod(n, SESSION_HOST_RPC.waitStatus)
    )
  }

  /** Free memory, load and live sessions on that computer; refused before sending on older hosts. */
  hostStats() {
    return this.send(SESSION_HOST_RPC.hostStats, {}, SessionHostStatsReplySchema, (n) =>
      requireSessionHostMethod(n, SESSION_HOST_RPC.hostStats)
    )
  }
}

function relocationProvider(request: SessionHostRequest): 'claude' | 'codex' | undefined {
  const provider = (request.payload as { provider?: unknown }).provider
  return provider === 'claude' || provider === 'codex' ? provider : undefined
}
