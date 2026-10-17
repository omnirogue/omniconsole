import { normalizeSessionRoutingReceipt } from './session-routing-receipt'
import { validOpenRouterRoute } from './openrouter-route'
import {
  normalizeSessionReviewAssignment,
  normalizeSessionReviewRepairAssignment
} from './session-chain-review'
import { isSessionActionPresetId } from './session-action-presets'
import { isTuiAgent } from './tui-agent-config'
import { normalizeSessionChainHandoffStep } from './session-follow-up-rule'
import { normalizeSessionEffortParity } from './session-effort-parity'
import {
  STEP_ROUTES,
  STEP_WRITES,
  normalizeSessionChainRound,
  optionalString,
  readEnabledBy,
  readIdList,
  readPlanVersion,
  readSeat,
  readStepField,
  readStepPrompts,
  readStepStage,
  readStepVerdict,
  readWait
} from './session-chain-record-fields'
import type {
  SessionChainStep,
  SessionChainStepRole,
  SessionChainStepRoute,
  SessionChainStepStatus,
  SessionChainStepWrites
} from './session-chain-types'

const STEP_ROLES: readonly SessionChainStepRole[] = ['producer', 'worker', 'reviewer', 'repair']
const STEP_STATUSES: readonly SessionChainStepStatus[] = ['queued', 'launched', 'skipped', 'failed']

/**
 * @param problems collects the work-plan fields this build could not read, so a chain carrying one is
 * refused loudly instead of running with the field silently deleted.
 */
export function normalizeSessionChainStep(
  value: unknown,
  problems?: string[]
): SessionChainStep | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  if (record.kind === 'handoff') {
    return normalizeSessionChainHandoffStep(record)
  }
  // Why: a kind this build does not know cannot run; dropping it beats running it as an agent.
  if (record.kind !== undefined && record.kind !== 'agent') {
    return null
  }
  if (record.review !== undefined && !normalizeSessionReviewAssignment(record.review)) {
    return null
  }
  if (
    record.reviewRepair !== undefined &&
    !normalizeSessionReviewRepairAssignment(record.reviewRepair)
  ) {
    return null
  }
  const id = optionalString(record.id)
  const prompt = typeof record.prompt === 'string' ? record.prompt : ''
  if (!id || !isTuiAgent(record.agent) || !prompt.trim()) {
    return null
  }
  if (
    !validOpenRouterRoute({
      agent: record.agent,
      model: typeof record.model === 'string' ? record.model : undefined,
      openrouterCandidates: record.openrouterCandidates
    })
  ) {
    return null
  }
  const status = STEP_STATUSES.includes(record.status as SessionChainStepStatus)
    ? (record.status as SessionChainStepStatus)
    : 'queued'
  const effortParity = normalizeSessionEffortParity(record.effortParity) ?? undefined
  const routing = normalizeSessionRoutingReceipt(record.routing)
  const found: string[] = []
  const seat = readStepField(found, id, 'seat', record.seat, readSeat)
  const verdict = readStepField(found, id, 'verdict', record.verdict, readStepVerdict)
  const readsFrom = readStepField(found, id, 'readsFrom', record.readsFrom, readIdList)
  const readsWinnerOf = readStepField(
    found,
    id,
    'readsWinnerOf',
    record.readsWinnerOf,
    optionalString
  )
  const enabledBy = readStepField(found, id, 'enabledBy', record.enabledBy, readEnabledBy)
  const wait = readStepField(found, id, 'wait', record.wait, readWait)
  // WP-2 lowers a gate node's fail route onto its seat as a step id and WP-3 reads it structurally
  // (`sessionVerdictFailRoute`). Without this line a reloaded chain drops it and a failing gate
  // blocks instead of routing to its repair — fail-closed, but not what the plan said.
  const onFail = readStepField(found, id, 'onFail', record.onFail, optionalString)
  const planNodeId = readStepField(found, id, 'planNodeId', record.planNodeId, optionalString)
  // A stage marker and the prompts queued into a stage are the composer's own record of what
  // the person asked for. Dropping either would change what the chain does: the stage would
  // read as its compiled parts, and a queued prompt would never be sent.
  const stage = readStepField(found, id, 'stage', record.stage, readStepStage)
  const prompts = readStepField(found, id, 'prompts', record.prompts, readStepPrompts)
  const planVersion = readStepField(found, id, 'planVersion', record.planVersion, readPlanVersion)
  const route = readStepField(found, id, 'route', record.route, (entry) =>
    STEP_ROUTES.includes(entry as SessionChainStepRoute)
      ? (entry as SessionChainStepRoute)
      : undefined
  )
  const writes = readStepField(found, id, 'writes', record.writes, (entry) =>
    STEP_WRITES.includes(entry as SessionChainStepWrites)
      ? (entry as SessionChainStepWrites)
      : undefined
  )
  if (found.length) {
    problems?.push(...found)
    return null
  }
  const step: SessionChainStep = {
    id,
    ...(normalizeSessionReviewAssignment(record.review)
      ? { review: normalizeSessionReviewAssignment(record.review) }
      : {}),
    ...(normalizeSessionReviewRepairAssignment(record.reviewRepair)
      ? { reviewRepair: normalizeSessionReviewRepairAssignment(record.reviewRepair) }
      : {}),
    agent: record.agent,
    ...(optionalString(record.outcomeId) ? { outcomeId: optionalString(record.outcomeId) } : {}),
    ...(STEP_ROLES.includes(record.role as SessionChainStepRole)
      ? { role: record.role as SessionChainStepRole }
      : {}),
    ...(optionalString(record.replacedStepId)
      ? { replacedStepId: optionalString(record.replacedStepId) }
      : {}),
    ...(optionalString(record.editorStepId)
      ? { editorStepId: optionalString(record.editorStepId) }
      : {}),
    prompt,
    ...(isSessionActionPresetId(record.presetId) ? { presetId: record.presetId } : {}),
    ...(optionalString(record.model) ? { model: optionalString(record.model) } : {}),
    ...(record.openrouterCandidates !== undefined
      ? { openrouterCandidates: [...(record.openrouterCandidates as string[])] }
      : {}),
    ...(optionalString(record.effort) ? { effort: optionalString(record.effort) } : {}),
    ...(effortParity ? { effortParity } : {}),
    ...(routing ? { routing } : {}),
    ...(optionalString(record.accountChoiceId)
      ? { accountChoiceId: optionalString(record.accountChoiceId) }
      : {}),
    ...(optionalString(record.group) ? { group: optionalString(record.group) } : {}),
    ...(normalizeSessionChainRound(record.round)
      ? { round: normalizeSessionChainRound(record.round) }
      : {}),
    ...(seat ? { seat } : {}),
    ...(verdict ? { verdict } : {}),
    ...(readsFrom ? { readsFrom } : {}),
    ...(readsWinnerOf ? { readsWinnerOf } : {}),
    ...(enabledBy ? { enabledBy } : {}),
    ...(wait ? { wait } : {}),
    ...(planNodeId ? { planNodeId } : {}),
    ...(stage ? { stage } : {}),
    ...(prompts?.length ? { prompts } : {}),
    ...(planVersion ? { planVersion } : {}),
    ...(readPlanVersion(record.supersededBy)
      ? { supersededBy: readPlanVersion(record.supersededBy) }
      : {}),
    ...(route ? { route } : {}),
    ...(writes ? { writes } : {}),
    status,
    ...(optionalString(record.launchedTabId)
      ? { launchedTabId: optionalString(record.launchedTabId) }
      : {}),
    ...(optionalString(record.launchedPaneKey)
      ? { launchedPaneKey: optionalString(record.launchedPaneKey) }
      : {}),
    ...(typeof record.launchedAt === 'number' ? { launchedAt: record.launchedAt } : {}),
    ...(optionalString(record.hubThreadId)
      ? { hubThreadId: optionalString(record.hubThreadId) }
      : {}),
    ...(typeof record.hubSettledAt === 'number' ? { hubSettledAt: record.hubSettledAt } : {})
  }
  // `onFail` has one owner in the types (`WorkPlanRuntimeStep = SessionChainAgentStep & {onFail?}`),
  // so it is attached rather than declared a second time here.
  return onFail ? ({ ...step, onFail } as SessionChainStep) : step
}
