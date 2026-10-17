import { getAgentSessionOptionCatalog } from '../../shared/agent-session-option-catalog'
import { withAgentTemplateInstructions } from '../../shared/agent-template-dispatch'
import { sessionPromptWithoutGuardrails } from '../../shared/session-prep-prompt'
import type { GateVerdict, SessionPrepLaunchLabel } from '../../shared/session-prep-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { SessionPrepHostError } from './session-prep-execution-host'
import type { SessionPrepHost } from './session-prep-host'
import type { SessionPrepLaunchContext } from './session-prep-launch'
import {
  routedDecision,
  sessionPrepItemLaunchChoice,
  sessionPrepLaunchLabel
} from './session-prep-launch-choice'
import type { SessionPrepBatchRecord, SessionPrepItemRecord } from './session-prep-records'
import {
  sessionPrepRoutingMode,
  type SessionPrepRouterRequest,
  type SessionPrepRouterResult
} from './session-prep-router-cli'

export type SessionPrepItemRoute =
  | (SessionPrepRouterResult & { at: number })
  /** Legacy persisted receipts remain readable. */
  | { unrouted: string; at: number }

export async function renderRoutedSessionPrepPrompt(
  ctx: Pick<SessionPrepLaunchContext, 'host' | 'now' | 'agentTemplate'>,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord,
  verdict: GateVerdict | null,
  render: (launch: SessionPrepLaunchLabel) => string
): Promise<string> {
  const { host } = ctx
  const choice = () => sessionPrepItemLaunchChoice(host, batch, item, verdict)
  const unrouted = render(sessionPrepLaunchLabel(choice()))
  await routeSessionPrepItem(
    host,
    batch,
    item,
    verdict,
    sessionPromptWithoutGuardrails(unrouted),
    ctx.now()
  )
  const template = ctx.agentTemplate?.(batch, item) ?? null
  if (template) {
    item.agentTemplateName = template.name
  } else {
    delete item.agentTemplateName
  }
  const route = routedDecision(item, host.routingMode?.())
  if (!route) {
    return withAgentTemplateInstructions(unrouted, template)
  }
  const routed = choice()
  const prompt = render(sessionPrepLaunchLabel(routed))
  return withAgentTemplateInstructions(
    routed.model === route.model ? `${prompt}${route.note}` : prompt,
    template
  )
}

async function routeSessionPrepItem(
  host: SessionPrepHost,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord,
  verdict: GateVerdict | null,
  brief: string,
  now: number
): Promise<void> {
  const choices = item.planned.choices
  if (choices?.model) {
    if (!item.route || !('status' in item.route) || item.route.status !== 'pinned') {
      item.route = {
        status: 'pinned',
        unrouted: 'Explicit model preserved; automatic routing skipped',
        requested: { provider: choices.agent, model: choices.model, effort: choices.effort },
        mode:
          host.routingMode?.(batch.source.routingMode) ??
          sessionPrepRoutingMode(batch.source.routingMode),
        at: now
      }
    }
    return
  }
  if (!item.route) {
    const started = Date.now()
    const request = sessionPrepRouterRequest(host, batch, item, Boolean(verdict?.ask), brief)
    let result: SessionPrepRouterResult
    if (request.mode === 'off') {
      result = { status: 'off', unrouted: 'Routing disabled', mode: 'off' }
    } else if (!host.routeDispatch) {
      result = {
        status: 'unavailable',
        unrouted: 'Dispatch router unavailable on this runtime',
        mode: request.mode
      }
    } else {
      try {
        if (host.discoverRouteModels) {
          request.catalog = await host.discoverRouteModels(request)
        }
        result = (await host.routeDispatch(request)) ?? {
          status: 'unavailable',
          unrouted: 'Dispatch router unavailable',
          mode: request.mode
        }
      } catch {
        result = {
          status: 'unavailable',
          unrouted: 'Dispatch router unavailable',
          mode: request.mode
        }
      }
    }
    item.route = { ...result, mode: request.mode, elapsedMs: Date.now() - started, at: now }
  }
  // A receipt is retained before the caller records a failed launch. Never retry a dispatch here.
  if (
    'blocking' in item.route &&
    item.route.blocking &&
    item.route.mode !== 'off' &&
    item.route.mode !== 'shadow' &&
    (host.routingMode?.(item.route.mode) ?? sessionPrepRoutingMode(item.route.mode)) === 'live'
  ) {
    throw new SessionPrepHostError(item.route.unrouted)
  }
}

const ROUTABLE_AGENTS: TuiAgent[] = ['claude', 'codex', 'omp', 'gemini', 'grok', 'kimi']

function sessionPrepRouterRequest(
  host: SessionPrepHost,
  batch: SessionPrepBatchRecord,
  item: SessionPrepItemRecord,
  needsQuestion: boolean,
  brief: string
): SessionPrepRouterRequest {
  const choices = item.planned.choices
  const enabledProviders = ROUTABLE_AGENTS.filter(
    (agent) =>
      host.isAgentEnabled(agent) &&
      getAgentSessionOptionCatalog(agent)?.supportsWorkerLaunchPreferences
  )
  const provider =
    choices?.agent ?? (needsQuestion && enabledProviders.includes('claude') ? 'claude' : undefined)
  return {
    brief,
    title: item.fields?.title ?? item.planned.title,
    mode:
      host.routingMode?.(batch.source.routingMode) ??
      sessionPrepRoutingMode(batch.source.routingMode),
    enabledProviders,
    ...(item.executionTarget ? { executionTarget: item.executionTarget } : {}),
    ...(provider ? { provider } : {}),
    ...(choices?.model ? { model: choices.model } : {}),
    ...(choices?.effort ? { effort: choices.effort } : {})
  }
}
