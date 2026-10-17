import {
  CLAUDE_SESSION_OPTION_CATALOG,
  CODEX_SESSION_OPTION_CATALOG
} from '../../shared/agent-session-option-catalog-claude-codex'
import { GEMINI_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-gemini-cursor'
import type { SessionPrepConnectorLaunch } from '../../shared/session-prep-connector'
import type { SessionPrepChoices, SessionPrepSteps } from '../../shared/session-prep-types'
import {
  choiceWords,
  modelAgentFamily,
  sanitizePlannedChoices,
  statedEfforts
} from './session-prep-choices'
import { estateRouterModelAlias } from './session-prep-router-model-alias'
import { sessionPrepTaskKind } from './session-prep-task-template'

const MODELS = [
  ...CLAUDE_SESSION_OPTION_CATALOG.models,
  ...CODEX_SESSION_OPTION_CATALOG.models,
  ...GEMINI_SESSION_OPTION_CATALOG.models
]

function oneChoice<T>(values: T[], kind: string): T | undefined {
  if (values.length > 1) {
    throw new Error(`More than one ${kind} was named; choose it explicitly before launching.`)
  }
  return values[0]
}

/** Read named choices with the same catalog and word guards as the interactive planner. */
function connectorChoices(text: string, launch: SessionPrepConnectorLaunch): SessionPrepChoices {
  const words = ` ${choiceWords(text)} `
  const literal = MODELS.filter((model) =>
    [model.id, model.label].some((name) => words.includes(` ${choiceWords(name)} `))
  )
  const candidates = literal.length
    ? literal
    : MODELS.filter(
        (model) =>
          // The provider name alone must not pin the historical model ending in "-codex".
          !model.id.endsWith('-codex') && sanitizePlannedChoices({ model: model.id }, text)?.model
      )
  const normalizedLaunchModel = launch.model
    ? (estateRouterModelAlias(launch.model, launch.provider) ?? launch.model)
    : undefined
  const model =
    normalizedLaunchModel ??
    oneChoice(
      candidates.map((entry) => entry.id),
      'model'
    )
  const agents = (['claude', 'codex', 'gemini'] as const).filter(
    (agent) => sanitizePlannedChoices({ agent }, text)?.agent
  )
  const agent =
    launch.provider ??
    (normalizedLaunchModel ? modelAgentFamily(normalizedLaunchModel) : undefined) ??
    oneChoice(agents, 'agent') ??
    (model ? modelAgentFamily(model) : undefined)
  const effort = launch.effort ?? oneChoice([...statedEfforts(text)], 'effort')
  if (effort === 'minimal' || effort === 'ultra') {
    throw new Error('Session prep does not support that explicit effort; use raw launch.')
  }
  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
}

/** One signed app request owns one native operation and remains one verbatim prep item. */
export function planSessionPrepConnector(
  request: string,
  launch: SessionPrepConnectorLaunch
): Awaited<ReturnType<SessionPrepSteps['plan']>> {
  return {
    items: [
      {
        title: launch.title,
        ask: request,
        anchor: request,
        changesCode: sessionPrepTaskKind(request) === 'code',
        direct: false,
        choices: connectorChoices(request, launch)
      }
    ],
    dropped: []
  }
}
