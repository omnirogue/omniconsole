import {
  discoverSessionOutcomeRoutingModels,
  type OutcomeRoutingAccounts
} from './session-outcome-routing-models'
import type { CommitMessageModelCapability } from '../../shared/commit-message-agent-spec'
import type { SessionChain, SessionChainAgentStep } from '../../shared/session-chain-types'
import {
  SESSION_PREP_EFFORTS,
  type SessionPrepEffort,
  type SessionPrepRoutingReceipt
} from '../../shared/session-prep-types'
import { checkAgentLaunchPreferences } from '../../shared/agent-launch-preference-check'
import {
  sessionPrepRoutingMode,
  type SessionPrepRouterRequest,
  type SessionPrepRouterResult,
  type SessionPrepRoutingMode
} from '../session-prep/session-prep-router-cli'

export type OutcomeRoutingActor = Pick<
  SessionChainAgentStep,
  'agent' | 'model' | 'effort' | 'accountChoiceId' | 'openrouterCandidates' | 'routing'
> & { prompt?: string; instruction?: string }
export type SessionOutcomeModelRouter = OutcomeRoutingAccounts & {
  routeSessionOutcomeModel?: (request: SessionPrepRouterRequest) => Promise<SessionPrepRouterResult>
}

/** Only unnamed choices on ordinary actors; canonical review assignment never calls this. */
export async function routeSessionOutcomeDefaultModel(
  runtime: SessionOutcomeModelRouter,
  chain: SessionChain,
  actor: OutcomeRoutingActor,
  models: CommitMessageModelCapability[]
): Promise<string | undefined> {
  if (
    !runtime.routeSessionOutcomeModel ||
    actor.model ||
    actor.accountChoiceId ||
    actor.openrouterCandidates?.length
  ) {
    return undefined
  }
  const record = (receipt: SessionPrepRoutingReceipt) => {
    // Outcome actions have a strict wire schema; only agent steps carry additive receipts.
    if (actor.prompt !== undefined) {
      actor.routing = receipt
    }
  }
  const initialMode = runtime.getDispatchRoutingMode?.() ?? sessionPrepRoutingMode()
  if (initialMode === 'off') {
    record({ status: 'off', reason: 'Dispatch routing is off; existing defaults retained' })
    return undefined
  }
  if (actor.effort && !SESSION_PREP_EFFORTS.includes(actor.effort as SessionPrepEffort)) {
    record({
      status: 'unavailable',
      reason: 'Router cannot represent this explicit effort; host default retained'
    })
    return undefined
  }
  const verified = await discoverSessionOutcomeRoutingModels(runtime, chain, actor.agent, models)
  if (verified.unavailableReason) {
    record({ status: 'unavailable', reason: verified.unavailableReason })
    return undefined
  }
  const candidates = verified.models
  const fallback = candidates.find(
    (model) =>
      // This new fallback must not spend Fable credits; existing configured defaults stay unchanged.
      !/(?:^|\/)(?:claude-)?fable(?:$|-|\[)/i.test(model.id) &&
      checkAgentLaunchPreferences(actor.agent, { model: model.id, effort: actor.effort }).ok &&
      (!actor.effort || model.thinkingLevels?.some((level) => level.id === actor.effort))
  )
  const currentMode = (requested: SessionPrepRoutingMode = initialMode) => {
    const mode = runtime.getDispatchRoutingMode?.(requested) ?? sessionPrepRoutingMode(requested)
    // A shadow decision does not become live if the host setting changes while probing.
    return initialMode === 'shadow' && mode === 'live' ? 'shadow' : mode
  }
  const fallbackModel = () => (currentMode() === 'live' ? fallback?.id : undefined)
  const hostId = chain.hostId ?? 'local'
  const brief = actor.prompt ?? actor.instruction ?? ''
  let result: SessionPrepRouterResult
  try {
    result = await runtime.routeSessionOutcomeModel({
      title: 'workflow-outcome-model',
      mode: initialMode,
      brief,
      provider: actor.agent,
      ...(actor.effort ? { effort: actor.effort as SessionPrepEffort } : {}),
      enabledProviders: [actor.agent],
      executionTarget: { path: chain.workspacePath, hostId },
      catalog: {
        hostId,
        observedAt: Date.now(),
        agents: [{ provider: actor.agent, discovered: true, models: candidates }]
      }
    })
  } catch {
    record({
      status: 'unavailable',
      reason: 'Router unavailable; verified workflow default retained'
    })
    return fallbackModel()
  }
  const mode = currentMode(result.mode ?? initialMode)
  if ('unrouted' in result) {
    record({
      status: result.status,
      reason: result.unrouted,
      elapsedMs: result.elapsedMs,
      version: result.version
    })
    if (result.blocking && mode === 'live') {
      throw new Error(result.unrouted)
    }
    return mode === 'live' ? fallback?.id : undefined
  }
  record({
    status: mode === 'live' ? 'selected' : mode === 'shadow' ? 'shadow' : 'off',
    reason: result.reason,
    tier: result.tier,
    elapsedMs: result.elapsedMs,
    version: result.version,
    selected: { provider: result.provider, model: result.model, effort: result.effort },
    modelEvidence: result.modelEvidence
  })
  if (mode !== 'live') {
    return undefined
  }
  const found = candidates.find((model) => model.id === result.model)
  const effort = actor.effort ?? result.effort
  if (
    result.provider !== actor.agent ||
    (actor.effort && result.effort !== actor.effort) ||
    !found ||
    !checkAgentLaunchPreferences(actor.agent, { model: result.model, effort }).ok ||
    (effort && !found.thinkingLevels?.some((level) => level.id === effort))
  ) {
    record({
      status: 'unavailable',
      reason:
        'Router choice did not preserve verified workflow launch constraints; verified workflow default retained'
    })
    return fallbackModel()
  }
  actor.effort ??= result.effort
  return result.model
}
