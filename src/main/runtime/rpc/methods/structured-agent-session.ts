// `agentSession.*` — the structured session RPC surface.
//
// Every method here is gated on the client advertising
// `agent-session.structured.v1`. A client that does not is told the surface does
// not exist rather than being handed a session it cannot render or drive; that
// is the whole visibility rule, because nothing else on the runtime publishes a
// structured session.

import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../../shared/agent-session-mutation-envelope'
import {
  projectBackgroundTaskEvent,
  projectBackgroundTaskHistory
} from './structured-agent-session-background-task-capability'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredCapability,
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor,
  supportsStructuredSessions
} from './structured-agent-session-gate'
import { attachFingerprintFields } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import { STRUCTURED_AGENT_SESSION_HOLD_METHODS } from './structured-agent-session-hold'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from './structured-agent-session-reveal'
import {
  AttachParams,
  CancelParams,
  ConversationCommandParams,
  CreateParams,
  CreateSupportParams,
  HistoryParams,
  HandoffStatusParams,
  OptionsParams,
  RespondParams,
  SendParams,
  SetOptionParams,
  SubscribeParams,
  UnsubscribeParams
} from './structured-agent-session-schemas'

import { STRUCTURED_AGENT_SESSION_STATUS_METHODS } from './structured-agent-session-status'
import { respondToApproval, respondToQuestion } from './structured-agent-session-responses'

const SUBSCRIPTION_PREFIX = 'agentSession'

function subscriptionIdFor(ctx: RpcContext, sessionId: string): string {
  const base = `${SUBSCRIPTION_PREFIX}:${ctx.connectionId ?? 'local'}:${sessionId}`
  // Shared control multiplexes several streams over one socket; the frame id
  // keeps one subscriber from evicting another on the same session.
  return ctx.requestId ? `${base}:${ctx.requestId}` : base
}

export const STRUCTURED_AGENT_SESSION_METHODS: RpcAnyMethod[] = [
  ...STRUCTURED_AGENT_SESSION_STATUS_METHODS,
  defineMethod({
    name: 'agentSession.conversationCommand',
    params: ConversationCommandParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      await ensureHostInstalled(ctx)
      const host = requireHost(ctx)
      await host.revealSession(params.envelope.sessionId)
      const result = await host.conversationCommand(callerFor(ctx), params)
      if (result.ok && result.value.command === 'clear' && result.value.replacementSessionId) {
        const replacement = host
          .conversationReplacements()
          .find((entry) => entry.sourceSessionId === params.envelope.sessionId)
        if (replacement) {
          await ctx.runtime.replaceStructuredAgentSessionTab(replacement)
        }
        await host.close(params.envelope.sessionId)
      }
      return result
    }
  }),
  defineMethod({
    name: 'agentSession.createSupport',
    params: CreateSupportParams,
    handler: async (params, ctx) => {
      if (!supportsStructuredSessions(ctx)) {
        throw new Error('structured_agent_session_unsupported')
      }
      return ctx.runtime.getStructuredAgentSessionCreateSupport(
        params.worktree,
        params.agent,
        params.transport
      )
    }
  }),
  defineMethod({
    name: 'agentSession.create',
    params: CreateParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      if (params.envelope.expectedRuntimeFence !== null) {
        throw new Error('agent_session_operation_invalid')
      }
      if ('worktree' in params) {
        // Everything up to `attach` is pre-commit: it definitively created nothing, so it answers
        // with a refusal envelope rather than a throw a remote client cannot tell from a lost reply.
        const prepared = await resolveUncommittedStructuredCreate(async () => {
          const intentFingerprint = computeAgentSessionPayloadFingerprint({
            method: 'agentSession.create',
            sessionId: params.envelope.sessionId,
            // `resumeFrom` is part of the intent, not a detail of it: without it here, a retry of
            // "adopt this conversation" would replay as, or conflict with, a blank create. The
            // canonicalizer drops `undefined`, so plain creates keep the digest they always had.
            fields: {
              worktree: params.worktree,
              agent: params.agent,
              ...(params.options ? { options: params.options } : {}),
              resumeFrom: params.resumeFrom
            }
          })
          const conflict = agentSessionFingerprintConflict(params.envelope, intentFingerprint)
          if (conflict) {
            return { refusal: conflict }
          }
          // An adoption replay reads the record this operation already committed, so the host
          // has to be installed before the intent resolves — otherwise the replay finds nothing
          // and re-runs source discovery against a transcript that may now be gone.
          await ensureHostInstalled(ctx)
          const resolved = await ctx.runtime.resolveStructuredAgentSessionCreateIntent({
            ...params,
            callerKey: callerFor(ctx).callerKey,
            applyNewSessionDefaults: !params.resumeFrom
          })
          const hostFingerprint = computeAgentSessionPayloadFingerprint({
            method: 'agentSession.attach',
            sessionId: params.envelope.sessionId,
            fields: attachFingerprintFields({ ...resolved, envelope: params.envelope })
          })
          await ensureHostInstalled(ctx)
          return { resolved, hostFingerprint }
        })
        if ('refusal' in prepared) {
          return { ok: false as const, refusal: prepared.refusal }
        }
        const { resolved, hostFingerprint } = prepared
        const result = await requireHost(ctx).attach(
          callerFor(ctx, 'agent-session-create', params.envelope.clientOperationId),
          {
            ...resolved,
            envelope: { ...params.envelope, payloadFingerprint: hostFingerprint }
          }
        )
        if (!result.ok) {
          return result
        }
        // Past `attach` a failure no longer proves the session does not exist, so a lost tab
        // publication cannot answer "nothing was created" — it answers "unknown", which is the
        // one code a client retries by re-reading rather than by creating a second chat.
        try {
          await ctx.runtime.publishStructuredAgentSessionTab({
            workspaceId: resolved.location.workspaceId,
            sessionId: result.value.sessionId,
            agent: resolved.provider,
            activate: true
          })
        } catch (error) {
          console.warn('[agent-session] create committed before tab publication failed', error)
          return {
            ok: false as const,
            refusal: {
              code: 'agent_session_operation_unknown' as const,
              message: 'The chat may have been created, but its tab could not be confirmed.'
            }
          }
        }
        return result
      }
      await ensureHostInstalled(ctx)
      return requireHost(ctx).attach(
        callerFor(ctx, 'agent-session-create', params.envelope.clientOperationId),
        params
      )
    }
  }),
  defineMethod({
    name: 'agentSession.ensure',
    params: AttachParams,
    handler: async (params, ctx) => {
      await ensureHostInstalled(ctx)
      return requireHost(ctx).attach(
        callerFor(ctx, 'agent-session-resume', params.envelope.clientOperationId),
        params
      )
    }
  }),
  defineMethod({
    name: 'agentSession.send',
    params: SendParams,
    handler: async (params, ctx) => requireHost(ctx).send(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.cancel',
    params: CancelParams,
    handler: async (params, ctx) => requireHost(ctx).cancel(callerFor(ctx), params)
  }),
  defineMethod({
    // Releasing a chat view, not ending a conversation: the record and journal stay on disk so the
    // same session can be attached again. Only the provider child and the in-memory entry go.
    name: 'agentSession.close',
    params: OptionsParams,
    handler: async (params, ctx) => {
      const host = requireHost(ctx)
      await host.close(params.sessionId)
      // Terminal-disposal closes use this RPC without the session-tabs retirement RPC.
      if (typeof host.setSessionTabVisibility === 'function') {
        await host.setSessionTabVisibility(params.sessionId, false)
      }
      return { ok: true as const }
    }
  }),
  defineMethod({
    name: 'agentSession.respondToApproval',
    params: RespondParams,
    handler: async (params, ctx) => respondToApproval(ctx, params)
  }),
  defineMethod({
    name: 'agentSession.respondToQuestion',
    params: RespondParams,
    handler: async (params, ctx) => respondToQuestion(ctx, params)
  }),
  defineMethod({
    name: 'agentSession.setOption',
    params: SetOptionParams,
    handler: async (params, ctx) => requireHost(ctx).setOption(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.handoffStatus',
    params: HandoffStatusParams,
    handler: async (params, ctx) => requireHost(ctx).handoffStatus(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.options',
    params: OptionsParams,
    handler: async (params, ctx) => requireHost(ctx).readOptions(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.history',
    params: HistoryParams,
    handler: async (params, ctx) =>
      projectBackgroundTaskHistory(requireHost(ctx).history(params), ctx)
  }),
  defineStreamingMethod({
    name: 'agentSession.subscribe',
    params: SubscribeParams,
    handler: async (params, ctx, emit) => {
      const host = requireHost(ctx)
      const subscriptionId = subscriptionIdFor(ctx, params.sessionId)
      // A live stream is a surface too: it keeps a session from being evicted while it is read and
      // releases that retention when the transport dies without a word.
      //
      // Retain-only: reading history must never be what starts a provider process. Current clients
      // explicitly hold every open surface before subscribing.
      const streamHolder = `subscription:${subscriptionId}`
      let closed = false
      let dispose = (): void => {}
      let releaseTransportSubscription = (): void => {}
      const onTransportAbort = (): void => releaseTransportSubscription()
      const cleanup = () => {
        closed = true
        ctx.signal?.removeEventListener('abort', onTransportAbort)
        dispose()
        host.release(params.sessionId, streamHolder)
      }
      let registration: { releaseIfCurrent: () => void }
      if (typeof ctx.runtime.registerOwnedSubscriptionCleanup === 'function') {
        registration = ctx.runtime.registerOwnedSubscriptionCleanup(
          subscriptionId,
          cleanup,
          ctx.connectionId
        )
      } else {
        ctx.runtime.registerSubscriptionCleanup(subscriptionId, cleanup, ctx.connectionId)
        registration = { releaseIfCurrent: () => ctx.runtime.cleanupSubscription(subscriptionId) }
      }
      releaseTransportSubscription = registration.releaseIfCurrent
      ctx.signal?.addEventListener('abort', onTransportAbort, { once: true })
      if (ctx.signal?.aborted) {
        onTransportAbort()
      }
      if (closed) {
        return
      }
      // The host emits the opening snapshot (or the missed batch) synchronously
      // inside open(), so nothing between here and there can interleave.
      dispose = host.subscribe({
        id: subscriptionId,
        sessionId: params.sessionId,
        emit: (event) => emit(projectBackgroundTaskEvent(event, ctx)),
        ...(params.cursor ? { cursor: params.cursor } : {})
      })
      if (closed) {
        dispose()
      } else {
        // Fire-and-forget, but never unhandled: a resume that refuses leaves the stream holding a
        // readable session, which is exactly what the client sees anyway.
        void host
          .hold(params.sessionId, streamHolder, { resume: false })
          .catch((error: unknown) =>
            console.warn('[agent-session] stream hold failed', params.sessionId, error)
          )
      }
    }
  }),
  defineMethod({
    name: 'agentSession.unsubscribe',
    params: UnsubscribeParams,
    handler: async (params, ctx) => {
      requireHost(ctx)
      const connection = ctx.connectionId ?? 'local'
      const base = `${SUBSCRIPTION_PREFIX}:${connection}:${params.sessionId}`
      if (params.subscriptionId) {
        ctx.runtime.cleanupSubscription(`${base}:${params.subscriptionId}`)
        return { unsubscribed: true }
      }
      ctx.runtime.cleanupSubscription(base)
      ctx.runtime.cleanupSubscriptionsByPrefix(`${base}:`)
      return { unsubscribed: true }
    }
  }),
  ...STRUCTURED_AGENT_SESSION_HOLD_METHODS,
  ...STRUCTURED_AGENT_SESSION_REVEAL_METHODS
]
