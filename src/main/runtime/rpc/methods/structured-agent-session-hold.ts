// `agentSession.hold` / `agentSession.release` — a surface saying it is bound to a session.
//
// The holder identity is scoped to the CONNECTION, not taken from the client verbatim: two clients
// are free to name their surfaces the same thing, and a hold that collides is one that a stranger
// can release.
//
// The registered cleanup is the backstop, and the ONLY thing that covers a client which vanishes —
// a paired client that disconnects mid-turn never gets to send its release. Registering it before taking
// the hold is deliberate: re-registering an id runs the previous cleanup synchronously, so the
// stale release lands before this hold rather than after it.

import { defineMethod, type RpcAnyMethod, type RpcContext } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredHost,
  requireStructuredCapability
} from './structured-agent-session-gate'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { HoldParams, ViewerHoldParams } from './structured-agent-session-schemas'

const HOLD_CLEANUP_PREFIX = 'agentSession.hold'

function holderKeyFor(ctx: RpcContext, holderId: string): string {
  const client = ctx.clientId?.trim() || (ctx.clientKind ?? 'runtime')
  return `${ctx.connectionId ?? 'local'}:${client}:${holderId}`
}

function holdCleanupIdFor(sessionId: string, holderKey: string): string {
  return `${HOLD_CLEANUP_PREFIX}:${holderKey}:${sessionId}`
}

export const STRUCTURED_AGENT_SESSION_HOLD_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'agentSession.hold',
    params: ViewerHoldParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      const holderKey = holderKeyFor(ctx, params.holderId)
      const cleanupId = holdCleanupIdFor(params.sessionId, holderKey)
      let cancelled = false
      let host: ReturnType<typeof requireStructuredHost> | undefined
      // Register the pending acquisition before either host installation or journal loading.
      ctx.runtime.registerSubscriptionCleanup(
        cleanupId,
        () => {
          cancelled = true
          host?.release(params.sessionId, holderKey)
        },
        ctx.connectionId
      )
      try {
        await ensureStructuredHostInstalled(ctx)
        if (cancelled) {
          throw new Error('agent_session_hold_cancelled')
        }
        host = requireStructuredHost(ctx)
        if (params.mode === 'viewer') {
          await host.revealSession(params.sessionId)
        }
        if (cancelled) {
          throw new Error('agent_session_hold_cancelled')
        }
        await host.hold(
          params.sessionId,
          holderKey,
          params.mode === 'viewer' ? { resume: false } : undefined
        )
        if (cancelled) {
          throw new Error('agent_session_hold_cancelled')
        }
      } catch (error) {
        // A cancelled predecessor must not tear down its replacement's cleanup.
        if (!cancelled) {
          ctx.runtime.cleanupSubscription(cleanupId)
        }
        throw error
      }
      return params.mode === 'viewer'
        ? {
            held: true as const,
            processState: host.processState(params.sessionId)
          }
        : { held: true as const }
    }
  }),
  defineMethod({
    name: 'agentSession.release',
    params: HoldParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      const holderKey = holderKeyFor(ctx, params.holderId)
      // Retires the backstop too; its release is a no-op against a holder already gone.
      ctx.runtime.cleanupSubscription(holdCleanupIdFor(params.sessionId, holderKey))
      getStructuredAgentSessionHost()?.release(params.sessionId, holderKey)
      return { released: true as const }
    }
  })
]
