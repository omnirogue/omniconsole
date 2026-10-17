import { z } from 'zod'
import { defineStreamingMethod } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredHost
} from './structured-agent-session-gate'

export const STRUCTURED_AGENT_SESSION_STATUS_METHODS = [
  defineStreamingMethod({
    name: 'agentSession.subscribeStatus',
    params: z.object({}),
    handler: async (_params, ctx, emit) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      const id = `agentSessionStatus:${ctx.connectionId ?? 'local'}:${ctx.requestId ?? 'default'}`
      let closed = false
      let dispose = () => {}
      const cleanup = () => {
        closed = true
        ctx.signal?.removeEventListener('abort', onAbort)
        dispose()
      }
      let registration: { releaseIfCurrent: () => void }
      if (typeof ctx.runtime.registerOwnedSubscriptionCleanup === 'function') {
        registration = ctx.runtime.registerOwnedSubscriptionCleanup(id, cleanup, ctx.connectionId)
      } else {
        ctx.runtime.registerSubscriptionCleanup(id, cleanup, ctx.connectionId)
        registration = { releaseIfCurrent: () => ctx.runtime.cleanupSubscription(id) }
      }
      const onAbort = () => registration.releaseIfCurrent()
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      if (ctx.signal?.aborted) {
        onAbort()
      }
      if (closed) {
        return
      }
      dispose = host.subscribeStatus({ id, emit })
      if (closed) {
        dispose()
      }
    }
  })
]
