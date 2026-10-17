import { estateRouterModelAlias } from './session-prep-router-model-alias'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import {
  findCatalogModel,
  getAgentSessionOptionCatalog
} from '../../shared/agent-session-option-catalog'
import {
  SESSION_PREP_EFFORTS,
  type GateVerdict,
  type SessionPrepChoices,
  type SessionPrepEffort,
  type SessionPrepLaunchLabel
} from '../../shared/session-prep-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { SessionPrepHostError } from './session-prep-execution-host'
import { modelAgentFamily } from './session-prep-choices'
import type { SessionPrepHost } from './session-prep-host'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'
import {
  sessionPrepRoutingMode,
  type SessionPrepRouterDecision,
  type SessionPrepRoutingMode
} from './session-prep-router-cli'

/** What one item launches with, and why a stated choice could not be honoured. */
export type SessionPrepLaunchChoice = SessionPrepLaunchLabel & {
  effort?: SessionPrepEffort
  notes: string[]
  /** Live automatic model provenance; never present for an explicit model choice. */
  routedModel?: string
}

/**
 * Person's choice first, then the dispatch router's pick, then (for effort) the preparer's
 * recommendation, then the source agent's defaults. An accepted question moves an item with no
 * stated agent to Claude, which asks it.
 */
export function resolveSessionPrepLaunchChoice(input: {
  isAgentEnabled: (agent: TuiAgent) => boolean
  sourceAgent: TuiAgent
  choices?: SessionPrepChoices
  recommendedEffort?: SessionPrepEffort
  needsQuestion: boolean
  /** The dispatch router's pick for what the person left unnamed. */
  route?: Pick<SessionPrepRouterDecision, 'provider' | 'model' | 'effort'>
}): SessionPrepLaunchChoice {
  const { choices, route } = input
  const notes: string[] = []
  const fallback =
    input.needsQuestion && input.isAgentEnabled('claude') ? 'claude' : input.sourceAgent
  let agent = fallback
  if (choices?.agent && input.isAgentEnabled(choices.agent)) {
    agent = choices.agent
  } else if (choices?.agent) {
    throw new SessionPrepHostError(
      `${choices.agent} is turned off in Settings; the explicit choice was preserved`
    )
  } else if (route && input.isAgentEnabled(route.provider)) {
    agent = route.provider
  }
  const routed = route?.provider === agent ? route : undefined
  if (!getAgentSessionOptionCatalog(agent)?.supportsWorkerLaunchPreferences) {
    if (choices?.model || choices?.effort) {
      throw new SessionPrepHostError(`${agent} cannot apply the requested model or effort`)
    }
    return { agent, notes }
  }
  const model = estateRouterModelAlias(choices?.model, agent) ?? routed?.model
  const family = model ? modelAgentFamily(model) : null
  if (
    model &&
    ((family && family !== agent && agent !== 'omp') || (choices?.agent && choices.agent !== agent))
  ) {
    throw new SessionPrepHostError(
      `Model ${model} is not available on ${agent}; the explicit choice was preserved`
    )
  }
  const stated = choices?.effort
  // Why the router's effort is not raise-only: it is the pick for effort nobody named.
  // Naming a model keeps its launch default unless the person also named effort.
  const wanted =
    stated ??
    (choices?.model ? undefined : (routed?.effort ?? raisedEffort(input.recommendedEffort)))
  const effort = wanted ? offeredEffort(agent, model, wanted) : undefined
  if (stated && effort !== stated) {
    if (agent === 'gemini') {
      notes.push(`${agent} uses its default thinking level; ${stated} effort was noted`)
    } else {
      throw new SessionPrepHostError(
        `${stated} effort is not offered for ${model ?? agent}; the explicit choice was preserved`
      )
    }
  }
  return {
    agent,
    ...(model ? { model } : {}),
    ...(!choices?.model && routed?.model === model ? { routedModel: model } : {}),
    ...(effort ? { effort } : {}),
    notes
  }
}

// Why raise only: with no stated effort the agent's own default stands (Sal's sessions run at his
// usual effort); the preparer may lift a hard task above it but never quietly lowers it.
const RECOMMENDATION_FLOOR = SESSION_PREP_EFFORTS.indexOf('high')

function raisedEffort(recommended: SessionPrepEffort | undefined): SessionPrepEffort | undefined {
  return recommended && SESSION_PREP_EFFORTS.indexOf(recommended) >= RECOMMENDATION_FLOOR
    ? recommended
    : undefined
}

/** The wanted level when the model's effort menu has it, else the highest offered level below. */
function offeredEffort(
  agent: TuiAgent,
  model: string | undefined,
  wanted: SessionPrepEffort
): SessionPrepEffort | undefined {
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog) {
    return undefined
  }
  const catalogModel = model ? findCatalogModel(catalog, model) : undefined
  const options = catalogModel?.options ?? catalog.unknownModelOptions ?? []
  const option = options.find((entry) => entry.id === 'effort')
  if (!option || option.kind.type !== 'select') {
    return undefined
  }
  const offered = new Set(option.kind.choices.map((choice) => String(choice.value)))
  const ceiling = SESSION_PREP_EFFORTS.indexOf(wanted)
  for (let index = ceiling; index >= 0; index -= 1) {
    const level = SESSION_PREP_EFFORTS[index]!
    if (offered.has(level)) {
      return level
    }
  }
  return undefined
}

export function sessionPrepLaunchPreferences(
  choice: SessionPrepLaunchChoice
): AgentLaunchPreferences | undefined {
  if (!choice.model && !choice.effort) {
    return undefined
  }
  return {
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort } : {})
  }
}

export function sessionPrepItemLaunchChoice(
  host: SessionPrepHost,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord,
  verdict: GateVerdict | null
): SessionPrepLaunchChoice {
  return resolveSessionPrepLaunchChoice({
    isAgentEnabled: (agent) => host.isAgentEnabled(agent),
    sourceAgent: batch.source.agent,
    choices: item.planned.choices,
    recommendedEffort: item.fields?.effort,
    needsQuestion: Boolean(verdict?.ask),
    route: routedDecision(item, host.routingMode?.())
  })
}

/** The router's decision for the item, when it answered. */
export function routedDecision(
  item: SessionPrepItemRecord,
  hostMode?: SessionPrepRoutingMode
): SessionPrepRouterDecision | undefined {
  return item.route &&
    'provider' in item.route &&
    item.route.mode !== 'off' &&
    item.route.mode !== 'shadow' &&
    hostMode !== 'off' &&
    hostMode !== 'shadow' &&
    sessionPrepRoutingMode(item.route.mode) === 'live'
    ? item.route
    : undefined
}

export function sessionPrepLaunchLabel(choice: SessionPrepLaunchChoice): SessionPrepLaunchLabel {
  return {
    agent: choice.agent,
    ...(choice.model ? { model: choice.model } : {}),
    ...(choice.effort ? { effort: choice.effort } : {})
  }
}
