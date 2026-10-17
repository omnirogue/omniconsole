import { FAMILIES, familyFor, type Family } from './session-prep-router-model-family'
import { estateRouterModelAlias } from './session-prep-router-model-alias'
import { checkAgentLaunchPreferences } from '../../shared/agent-launch-preference-check'
import { getAgentSessionOptionCatalog } from '../../shared/agent-session-option-catalog'
import { SESSION_PREP_EFFORTS, type SessionPrepEffort } from '../../shared/session-prep-types'
import type { TuiAgent } from '../../shared/tui-agent'
import type {
  SessionPrepRouterCandidate,
  SessionPrepRouterDecision,
  SessionPrepRouterRequest,
  SessionPrepRouterResult
} from './session-prep-router-types'

type Candidate = {
  provider: TuiAgent
  model: string
  family: Family | undefined
  efforts: SessionPrepEffort[]
}

function catalogEfforts(provider: TuiAgent, model: string): SessionPrepEffort[] {
  const catalog = getAgentSessionOptionCatalog(provider)
  const options =
    catalog?.models.find((entry) => entry.id === model)?.options ??
    catalog?.unknownModelOptions ??
    []
  const option = options.find((entry) => entry.id === 'effort')
  return option?.kind.type === 'select'
    ? SESSION_PREP_EFFORTS.filter(
        (effort) =>
          option.kind.type === 'select' &&
          option.kind.choices.some((choice) => choice.value === effort)
      )
    : []
}

function candidatesFor(request: SessionPrepRouterRequest): Candidate[] {
  const candidates: Candidate[] = []
  for (const listing of request.catalog?.agents ?? []) {
    if (
      !listing.discovered ||
      listing.error ||
      (request.enabledProviders && !request.enabledProviders.includes(listing.provider)) ||
      !getAgentSessionOptionCatalog(listing.provider)?.supportsWorkerLaunchPreferences
    ) {
      continue
    }
    for (const model of listing.models) {
      const family = familyFor(model.id)
      if (!family || !checkAgentLaunchPreferences(listing.provider, { model: model.id }).ok) {
        continue
      }
      const efforts = model.thinkingLevels
        ? SESSION_PREP_EFFORTS.filter((level) =>
            model.thinkingLevels?.some((entry) => entry.id === level)
          )
        : catalogEfforts(listing.provider, model.id)
      const launchEfforts = efforts.filter(
        (effort) => checkAgentLaunchPreferences(listing.provider, { model: model.id, effort }).ok
      )
      if (efforts.length && !launchEfforts.length) {
        continue
      }
      candidates.push({
        provider: listing.provider,
        model: model.id,
        family,
        efforts: launchEfforts
      })
    }
  }
  return candidates
}

/** Available means advertised by this host's CLI, never that a worker served this model. */
export function routerCandidateReceipt(
  request: SessionPrepRouterRequest
): SessionPrepRouterCandidate[] {
  const candidates = candidatesFor(request)
  return FAMILIES.map((family) => {
    const candidate = candidates.find((entry) => entry.family === family)
    return candidate
      ? {
          family,
          available: true,
          provider: candidate.provider,
          model: candidate.model,
          reason: 'Advertised by the execution host; served model is unverified'
        }
      : {
          family,
          available: false,
          reason:
            family === 'Gemini 3.8 Flash'
              ? 'No exact discovered ID; the static Gemini CLI entry may silently substitute 3.5'
              : 'No enabled launch adapter with an exact discovered model on the execution host'
        }
  })
}

// This is a conservative preference order, not a new classifier. Unknown intelligence stays out of
// standard/frontier; cost never lowers the capability floor. Sonnet sits ahead of Opus in standard because
// Sonnet 5.5 matched Opus 5.5 on 10 real tickets at about a third of the cost (Sal, 2026-10-11, decision 264).
// Frontier leads with Argon, followed by Opus 5.5 and Astra (Sal, 2026-10-14).
const PREFERENCE: Record<string, readonly Family[]> = {
  fast: [
    'Luna',
    'Gemini 3.8 Flash',
    'Sonnet',
    'Terra',
    'Kimi',
    'Grok',
    'Sol 6.1',
    'Argon',
    'Opus',
    'Astra'
  ],
  standard: ['Sol 6.1', 'Terra', 'Sonnet', 'Argon', 'Opus', 'Astra'],
  frontier: ['Argon', 'Opus', 'Astra']
}

export function selectRouterCandidate(
  request: SessionPrepRouterRequest,
  decision: SessionPrepRouterDecision
): SessionPrepRouterResult {
  const requestedModel = estateRouterModelAlias(request.model, request.provider)
  const candidates = routerCandidateReceipt(request)
  if (!request.catalog) {
    // Legacy hosts retain their estate decision; they do not claim cross-provider availability.
    const decisionModel =
      estateRouterModelAlias(decision.model, decision.provider) ?? decision.model
    if (
      (request.provider && request.provider !== decision.provider) ||
      (requestedModel && requestedModel !== decisionModel) ||
      (request.effort && request.effort !== decision.effort) ||
      (request.enabledProviders && !request.enabledProviders.includes(decision.provider))
    ) {
      return {
        status: 'unavailable',
        unrouted: 'The estate router could not preserve the requested choices',
        candidates,
        blocking: true
      }
    }
    return {
      ...decision,
      candidates,
      modelEvidence: 'estate-policy',
      selectionBasis: 'Existing estate policy; advertised and served availability unverified'
    }
  }
  const expectedHost =
    request.executionTarget?.hostId ??
    (request.executionTarget?.connectionId
      ? `ssh:${request.executionTarget.connectionId}`
      : 'local')
  if (request.catalog.hostId !== expectedHost) {
    return {
      status: 'unavailable',
      unrouted: 'Model discovery belongs to a different execution host',
      candidates,
      blocking: true
    }
  }
  const advertised = candidatesFor(request)
  // A pinned opaque model is valid when the exact model appears in the host listing.
  if (
    request.model &&
    !advertised.some(
      (entry) =>
        entry.model === requestedModel ||
        entry.model === request.model ||
        estateRouterModelAlias(entry.model, entry.provider) === requestedModel
    )
  ) {
    const listing = request.catalog.agents.find(
      (entry) =>
        entry.discovered &&
        !entry.error &&
        (!request.provider || entry.provider === request.provider) &&
        (!request.enabledProviders || request.enabledProviders.includes(entry.provider)) &&
        getAgentSessionOptionCatalog(entry.provider)?.supportsWorkerLaunchPreferences &&
        entry.models.some(
          (model) =>
            model.id === requestedModel ||
            model.id === request.model ||
            estateRouterModelAlias(model.id, entry.provider) === requestedModel
        )
    )
    if (listing) {
      const model = listing.models.find(
        (m) =>
          m.id === requestedModel ||
          m.id === request.model ||
          estateRouterModelAlias(m.id, listing.provider) === requestedModel
      )!
      advertised.push({
        provider: listing.provider,
        model: model.id,
        family: undefined,
        efforts: model.thinkingLevels
          ? SESSION_PREP_EFFORTS.filter((effort) =>
              model.thinkingLevels?.some((entry) => entry.id === effort)
            )
          : catalogEfforts(listing.provider, model.id)
      })
    }
  }
  const order = PREFERENCE[decision.tier] ?? PREFERENCE.frontier!
  const eligible = advertised.filter(
    (entry) =>
      (!request.provider || entry.provider === request.provider) &&
      (!request.model ||
        entry.model === requestedModel ||
        entry.model === request.model ||
        estateRouterModelAlias(entry.model, entry.provider) === requestedModel) &&
      (!request.effort || entry.efforts.includes(request.effort)) &&
      (request.model || (entry.family && order.includes(entry.family))) &&
      (request.model ||
        !decision.effort ||
        entry.efforts.length === 0 ||
        entry.efforts.some(
          (level) =>
            SESSION_PREP_EFFORTS.indexOf(level) >= SESSION_PREP_EFFORTS.indexOf(decision.effort!)
        ))
  )
  eligible.sort(
    (a, b) =>
      (a.family ? order.indexOf(a.family) : -1) - (b.family ? order.indexOf(b.family) : -1) ||
      Number(b.provider === decision.provider) - Number(a.provider === decision.provider)
  )
  const selected = eligible[0]
  if (!selected) {
    const relevant = request.catalog.agents.filter(
      (entry) => !request.provider || entry.provider === request.provider
    )
    const complete =
      relevant.length > 0 && relevant.every((entry) => entry.discovered && !entry.error)
    return {
      status: 'unavailable',
      blocking: complete && Boolean(request.model),
      candidates,
      unrouted: !complete
        ? 'Execution host model discovery is unavailable or pending'
        : request.model
          ? 'No advertised model can preserve the requested provider, model and effort'
          : 'No eligible automatic model; existing launch choices retained'
    }
  }
  const desired = request.effort ?? decision.effort
  const effort =
    request.effort ??
    (desired && selected.efforts.includes(desired)
      ? desired
      : selected.efforts.find(
          (level) =>
            desired && SESSION_PREP_EFFORTS.indexOf(level) >= SESSION_PREP_EFFORTS.indexOf(desired)
        ))
  return {
    ...decision,
    provider: selected.provider,
    model: selected.model,
    effort,
    candidates,
    modelEvidence: 'advertised',
    // The old escalation note names the estate model; do not append it after a different pick.
    note: selected.model === decision.model ? decision.note : '',
    selectionBasis:
      'Existing classifier tier; conservative unmeasured family preference; host-advertised IDs only'
  }
}
