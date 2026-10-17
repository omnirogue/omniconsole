/**
 * The one gate every `sessionHost.*` call from another computer passes, on either transport: the
 * connection's own declaration is negotiated against what this host can carry out, the method and
 * the action are each required, params are parsed strictly, and authority is built from the
 * authenticated peer plus the origin. Refusals are result values; nothing here throws to the wire.
 */

import type { SessionHostAdvertisement } from '../../shared/session-host-capabilities'
import {
  negotiateSessionHostCapabilities,
  requireSessionHostAction,
  requireSessionHostMethod
} from '../../shared/session-host-negotiation'
import {
  SESSION_HOST_RPC,
  type SessionHostMethod,
  type SessionHostRequest
} from '../../shared/session-host-protocol'
import { sessionHostRefusal, type SessionHostRefusal } from '../../shared/session-host-refusal'
import {
  parseSessionHostRequest,
  SessionHostHistoryParamsSchema,
  SessionHostObserveParamsSchema,
  SessionHostOperationParamsSchema,
  SessionHostReleaseParamsSchema,
  SessionHostTidyParamsSchema,
  SessionHostWaitStatusParamsSchema
} from '../../shared/session-host-schema'
import type { z } from 'zod'
import {
  requireRelocationBundleCapability,
  SessionHostBundleReadParamsSchema,
  SessionHostBundleWriteParamsSchema
} from '../../shared/session-host-relocation-bundle'
import {
  readRelocationBundleChunk,
  writeRelocationBundleChunk
} from '../session-manage/session-transfer-relocation-bundle'
import { SessionHostStatsParamsSchema } from '../../shared/session-host-stats'
import { sessionHostPeerHolder, type SessionHostRemoteAuthority } from './session-host-caller'
import {
  sessionHostNotSupportedYet,
  type SessionHostExecutionRequest
} from './session-host-executor'
import type { SessionHostService } from './session-host-service'
import type { SessionHostGateHost } from './session-host-process'
import { readSessionHostStats } from './session-host-stats'

export type SessionHostRemotePeer = {
  transport: SessionHostRemoteAuthority['transport']
  /** Authenticated and namespaced: `paired:<device>` or `ssh:<client host id>`. */
  peer: string
  /** What this connection declared; never read from a request. */
  declared: SessionHostAdvertisement
  connection: string | null
}

const refused = (refusal: SessionHostRefusal) => ({ status: 'refused' as const, refusal })

function parse<T>(
  schema: z.ZodType<T>,
  params: unknown
): { ok: true; value: T } | { ok: false; reply: ReturnType<typeof refused> } {
  const parsed = schema.safeParse(params)
  if (parsed.success) {
    return { ok: true, value: parsed.data }
  }
  const first = parsed.error.issues[0]
  const where = first?.path.length ? `${first.path.map(String).join('.')}: ` : ''
  return {
    ok: false,
    reply: refused(
      sessionHostRefusal(
        'invalid-request',
        `The request was refused as malformed (${where}${first?.message ?? 'invalid'}). Nothing was changed.`
      )
    )
  }
}

function hasOrigin(params: unknown): boolean {
  return typeof params === 'object' && params !== null && 'origin' in params
}

const PROVENANCE_REQUIRED = sessionHostRefusal(
  'provenance-required',
  'The request carries no origin (who asked, from which computer), so it was refused. Nothing was changed.'
)

function withoutOrigin(request: SessionHostRequest): SessionHostExecutionRequest {
  const { origin: _origin, ...rest } = request
  return rest as SessionHostExecutionRequest
}

function relocationProvider(request: SessionHostRequest): 'claude' | 'codex' | undefined {
  const provider = (request.payload as { provider?: unknown }).provider
  return provider === 'claude' || provider === 'codex' ? provider : undefined
}

export async function handleSessionHostRemoteCall(
  host: SessionHostGateHost,
  method: SessionHostMethod,
  params: unknown,
  peer: SessionHostRemotePeer
): Promise<unknown> {
  const negotiation = negotiateSessionHostCapabilities({
    side: 'host',
    local: host.capabilities(),
    peer: peer.declared,
    ...(peer.connection ? { connection: peer.connection } : {})
  })
  const methodRefusal = requireSessionHostMethod(negotiation, method)
  if (methodRefusal) {
    return refused(methodRefusal)
  }
  let service: SessionHostService
  try {
    service = await host.service()
  } catch (error) {
    return refused(
      sessionHostRefusal(
        'storage-unavailable',
        `${error instanceof Error ? error.message : String(error)} Nothing was changed.`
      )
    )
  }
  const executor = service.executor()
  const authority = (origin: SessionHostRemoteAuthority['origin']): SessionHostRemoteAuthority => ({
    kind: 'remote',
    transport: peer.transport,
    peer: peer.peer,
    origin
  })
  switch (method) {
    case SESSION_HOST_RPC.execute:
    case SESSION_HOST_RPC.reserve: {
      if (!hasOrigin(params)) {
        return refused(PROVENANCE_REQUIRED)
      }
      const parsed = parseSessionHostRequest(params)
      if (!parsed.ok) {
        return refused(sessionHostRefusal('invalid-request', parsed.message))
      }
      const { request } = parsed
      const actionRefusal = requireSessionHostAction(
        negotiation,
        request.action,
        relocationProvider(request)
      )
      if (actionRefusal) {
        return refused(actionRefusal)
      }
      return method === SESSION_HOST_RPC.execute
        ? await service.execute(withoutOrigin(request), authority(request.origin))
        : await service.reserve(withoutOrigin(request), authority(request.origin))
    }
    case SESSION_HOST_RPC.release: {
      if (!hasOrigin(params)) {
        return refused(PROVENANCE_REQUIRED)
      }
      const parsed = parse(SessionHostReleaseParamsSchema, params)
      return parsed.ok
        ? await service.release(parsed.value, authority(parsed.value.origin))
        : parsed.reply
    }
    case SESSION_HOST_RPC.observe: {
      const parsed = parse(SessionHostObserveParamsSchema, params)
      return parsed.ok ? await service.observe(parsed.value) : parsed.reply
    }
    case SESSION_HOST_RPC.operation: {
      const parsed = parse(SessionHostOperationParamsSchema, params)
      return parsed.ok ? service.operation(parsed.value) : parsed.reply
    }
    case SESSION_HOST_RPC.tidy: {
      if (!hasOrigin(params)) {
        return refused(PROVENANCE_REQUIRED)
      }
      const parsed = parse(SessionHostTidyParamsSchema, params)
      if (!parsed.ok) {
        return parsed.reply
      }
      return executor.tidy
        ? await executor.tidy(parsed.value, authority(parsed.value.origin))
        : refused(sessionHostNotSupportedYet('tidy'))
    }
    case SESSION_HOST_RPC.history: {
      const parsed = parse(SessionHostHistoryParamsSchema, params)
      if (!parsed.ok) {
        return parsed.reply
      }
      return executor.history
        ? await executor.history(parsed.value)
        : refused(sessionHostNotSupportedYet('history'))
    }
    case SESSION_HOST_RPC.bundleRead:
    case SESSION_HOST_RPC.bundleWrite:
      return await relocationBundleCall(service, method, params, negotiation, peer)
    case SESSION_HOST_RPC.waitStatus: {
      const parsed = parse(SessionHostWaitStatusParamsSchema, params)
      if (!parsed.ok) {
        return parsed.reply
      }
      return executor.waitStatus
        ? await executor.waitStatus(parsed.value)
        : refused(sessionHostNotSupportedYet('waitStatus'))
    }
    case SESSION_HOST_RPC.hostStats: {
      const parsed = parse(SessionHostStatsParamsSchema, params ?? {})
      return parsed.ok ? await readSessionHostStats(service) : parsed.reply
    }
  }
}

/** Only the peer that ran the relocation's step on this host may move its files. */
async function relocationBundleCall(
  service: SessionHostService,
  method: typeof SESSION_HOST_RPC.bundleRead | typeof SESSION_HOST_RPC.bundleWrite,
  params: unknown,
  negotiation: ReturnType<typeof negotiateSessionHostCapabilities>,
  peer: SessionHostRemotePeer
): Promise<unknown> {
  const holder = sessionHostPeerHolder(peer.peer)
  if (method === SESSION_HOST_RPC.bundleRead) {
    const parsed = parse(SessionHostBundleReadParamsSchema, params)
    if (!parsed.ok) {
      return parsed.reply
    }
    const refusal = requireRelocationBundleCapability(negotiation, parsed.value.provider)
    return refusal
      ? { status: 'refused', refusal }
      : await readRelocationBundleChunk(service.store, parsed.value, holder)
  }
  const parsed = parse(SessionHostBundleWriteParamsSchema, params)
  if (!parsed.ok) {
    return parsed.reply
  }
  const refusal = requireRelocationBundleCapability(negotiation, parsed.value.provider)
  return refusal
    ? { status: 'refused', refusal }
    : await writeRelocationBundleChunk(service.store, parsed.value, holder)
}
