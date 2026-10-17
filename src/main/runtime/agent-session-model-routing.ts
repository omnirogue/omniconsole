import { agentLaunchRefusal } from '../../shared/agent-launch-account'
import type {
  AgentLaunchPreferences,
  RuntimeAgentSessionRpcCaller,
  RuntimeCreateAgentSessionRequest
} from '../../shared/agent-session-host-authority'
import { checkAgentLaunchPreferences } from '../../shared/agent-launch-preference-check'
import {
  SESSION_PREP_EFFORTS,
  type SessionPrepEffort,
  type SessionPrepRoutingReceipt
} from '../../shared/session-prep-types'
import {
  sessionPrepRoutingMode,
  type SessionPrepRouterCatalog,
  type SessionPrepRouterRequest,
  type SessionPrepRouterResult
} from '../session-prep/session-prep-router-cli'

type RoutedLaunch = {
  preferences: AgentLaunchPreferences | undefined
  routing?: SessionPrepRoutingReceipt
}

/** Only the verified new-session launcher opts in; caller choices and replay identity stay intact. */
export async function routeVerifiedAgentSessionModel(input: {
  request: RuntimeCreateAgentSessionRequest
  caller: RuntimeAgentSessionRpcCaller
  enabled: boolean
  executionTarget: NonNullable<SessionPrepRouterRequest['executionTarget']>
  runsInWsl: boolean
  catalog: (request: SessionPrepRouterRequest) => Promise<SessionPrepRouterCatalog>
  route: (request: SessionPrepRouterRequest) => Promise<SessionPrepRouterResult>
}): Promise<RoutedLaunch> {
  const { request, caller } = input
  const preferences = request.launchPreferences
  const unchanged = (routing?: SessionPrepRoutingReceipt): RoutedLaunch => ({
    preferences,
    ...(routing ? { routing } : {})
  })
  if (!input.enabled || !request.sshAccountSelection || !request.prompt?.trim()) {
    return unchanged()
  }
  if (
    preferences?.model ||
    preferences?.codexAccountId ||
    preferences?.openrouterCandidates !== undefined ||
    request.agentArgs !== undefined ||
    request.agentTemplateId ||
    caller.preparedLaunchEnv
  ) {
    return unchanged({ status: 'pinned', reason: 'Explicit launch choices retained' })
  }
  const mode = sessionPrepRoutingMode()
  if (mode === 'off') {
    return unchanged({ status: 'off', reason: 'Routing disabled' })
  }
  if (
    input.runsInWsl ||
    input.executionTarget.hostId !== request.sshAccountSelection.expectedHostId
  ) {
    return unchanged({
      status: 'unavailable',
      reason: 'Execution owner cannot be verified for model routing'
    })
  }
  if (
    preferences?.effort &&
    !SESSION_PREP_EFFORTS.includes(preferences.effort as SessionPrepEffort)
  ) {
    return unchanged({
      status: 'unavailable',
      reason: 'Router cannot represent this explicit effort; host default retained'
    })
  }
  const routingRequest: SessionPrepRouterRequest = {
    brief: request.prompt ?? '',
    title: (request.prompt ?? '').slice(0, 160),
    provider: request.agent,
    ...(preferences?.effort ? { effort: preferences.effort as SessionPrepEffort } : {}),
    enabledProviders: [request.agent],
    executionTarget: input.executionTarget,
    mode
  }
  let catalog: SessionPrepRouterCatalog
  let result: SessionPrepRouterResult
  try {
    catalog = await input.catalog(routingRequest)
    result = await input.route({ ...routingRequest, catalog })
  } catch {
    return unchanged({ status: 'unavailable', reason: 'Router unavailable; host default retained' })
  }
  const effectiveMode = sessionPrepRoutingMode(result.mode ?? mode)
  if ('unrouted' in result) {
    if (result.blocking && mode === 'live' && effectiveMode === 'live') {
      throw agentLaunchRefusal(
        'agent_session_routing_unavailable',
        `${result.unrouted}. Nothing launched.`
      )
    }
    return unchanged({
      status: result.status,
      reason: result.unrouted,
      elapsedMs: result.elapsedMs,
      version: result.version
    })
  }
  const effort = preferences?.effort ?? result.effort
  const found = catalog.agents
    .find((entry) => entry.provider === request.agent && entry.discovered)
    ?.models.find((model) => model.id === result.model)
  if (
    catalog.hostId !== input.executionTarget.hostId ||
    result.provider !== request.agent ||
    (preferences?.effort && result.effort !== preferences.effort) ||
    !found ||
    !checkAgentLaunchPreferences(request.agent, { model: result.model, effort }).ok ||
    (effort && !found.thinkingLevels?.some((level) => level.id === effort))
  ) {
    return unchanged({
      status: 'unavailable',
      reason:
        'Router choice did not preserve the advertised launch constraints; host default retained'
    })
  }
  const live = mode === 'live' && effectiveMode === 'live'
  return {
    preferences: live
      ? { ...preferences, model: result.model, ...(effort ? { effort } : {}) }
      : preferences,
    routing: {
      status: live ? 'selected' : effectiveMode === 'off' ? 'off' : 'shadow',
      reason: result.reason,
      tier: result.tier,
      elapsedMs: result.elapsedMs,
      version: result.version,
      selected: { provider: result.provider, model: result.model, effort },
      modelEvidence: result.modelEvidence
    }
  }
}
