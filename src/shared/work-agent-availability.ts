import type { CatalogModel } from './agent-session-option-catalog'
import type { ProviderRateLimits, RateLimitWindow } from './rate-limit-types'
import type { TuiAgent } from './tui-agent'

export type WorkAgentStatus =
  | 'usable'
  | 'disabled'
  | 'cli-missing'
  | 'logged-out'
  | 'quota-exhausted'
  | 'health-check-failed'
  | 'model-unavailable'
  | 'unverified'
  | 'work-plan-required'

export type WorkAgentCapability = {
  status: WorkAgentStatus
  models: CatalogModel[]
  checkedAt: number
  /**
   * Set only when `admitUncheckedUsage` let an agent through without a current usage reading:
   * nothing says it is signed out or out of quota, but nothing current says it is not either.
   */
  usageUnchecked?: true
  /** Models a spent window of their own rules out (Claude's Fable week, a Gemini bucket). */
  unavailableModels?: CatalogModel[]
  /**
   * "Agent default" cannot be launched: the agent's own default model is spent, or a model is
   * and which one is the default is unknown, so leaving the model unset could start it.
   */
  defaultModelUnavailable?: true
}

/** A usage reading older than this is no evidence either way. */
export const WORK_AGENT_USAGE_FRESH_MS = 360_000

// The agents the rate-limit service reads usage for: its state keys by agent id, and Agent Teams
// through Claude's. Any other agent has no reading that could ever arrive.
const USAGE_FEED_AGENTS = new Set<TuiAgent>([
  'claude',
  'claude-agent-teams',
  'codex',
  'gemini',
  'kimi',
  'antigravity',
  'grok'
])

/** Whether a usage reading can arrive for this agent, so "not checked yet" can ever clear. */
export function hasUsageFeed(agent: TuiAgent): boolean {
  return USAGE_FEED_AGENTS.has(agent)
}

/** The windows a reading is judged by: Gemini's per-model buckets stand in for its session. */
function usageWindows(usage: ProviderRateLimits): RateLimitWindow[] {
  return [usage.buckets?.length ? null : usage.session, usage.weekly, usage.monthly].filter(
    (window): window is RateLimitWindow => window !== null && window !== undefined
  )
}

/** An old reading still rules an agent out while a window it showed spent has not reset. */
function stillExhausted(usage: ProviderRateLimits, now: number): boolean {
  return usageWindows(usage).some(
    (window) => window.usedPercent >= 100 && (window.resetsAt === null || window.resetsAt > now)
  )
}

/** A window that rules its model out: spent, and for an old reading, not reset since. */
function windowSpent(
  window: RateLimitWindow | null | undefined,
  now: number,
  stale: boolean
): boolean {
  return (
    !!window &&
    window.usedPercent >= 100 &&
    (!stale || window.resetsAt === null || window.resetsAt > now)
  )
}

/**
 * Why a reading rules a model out: `spent`, a window of its own is used up; `unmapped`, no quota
 * bucket names it, which is no proof it can run but no proof it is out of usage either.
 */
function modelRuledOut(
  model: CatalogModel,
  usage: ProviderRateLimits,
  now: number,
  stale: boolean
): 'spent' | 'unmapped' | null {
  if (/fable/i.test(model.id) && windowSpent(usage.fableWeekly, now, stale)) {
    return 'spent'
  }
  if (!usage.buckets?.length) {
    return null
  }
  const matching = usage.buckets.filter((bucket) =>
    `${model.id} ${model.label}`.toLowerCase().includes(bucket.name.toLowerCase())
  )
  if (!matching.length) {
    return 'unmapped'
  }
  return matching.some((bucket) => windowSpent(bucket, now, stale)) ? 'spent' : null
}

/**
 * The models a reading leaves runnable, with the spent ones named so a picker can show them out
 * of usage. A fresh reading leaves an unmapped model out as before, unnamed. "Agent default" is
 * spent when the agent's own default is, or, the default unknown, when any model is.
 */
function withModelWindows(
  base: WorkAgentCapability,
  usage: ProviderRateLimits,
  now: number,
  stale: boolean
): WorkAgentCapability {
  const verdicts = new Map(
    base.models.map((model) => [model, modelRuledOut(model, usage, now, stale)])
  )
  // Why an old reading keeps unmapped models: it admits the agent on no evidence at all, and
  // the buckets it lists are no fresher than the rest of it.
  const models = base.models.filter((model) => {
    const verdict = verdicts.get(model)
    return verdict === null || (stale && verdict === 'unmapped')
  })
  const spent = base.models.filter((model) => verdicts.get(model) === 'spent')
  if (!models.length) {
    return {
      status: 'quota-exhausted',
      models,
      checkedAt: base.checkedAt,
      ...(spent.length ? { unavailableModels: spent } : {})
    }
  }
  if (!spent.length) {
    return { ...base, models }
  }
  const agentDefault = base.models.find((model) => model.isDefault)
  const defaultSpent = agentDefault ? verdicts.get(agentDefault) === 'spent' : true
  return {
    ...base,
    models,
    unavailableModels: spent,
    ...(defaultSpent ? { defaultModelUnavailable: true as const } : {})
  }
}

/** Missing evidence never grants a launch. The owning host and account must answer every check. */
export function assessWorkAgentAvailability(input: {
  installed: boolean
  disabled: boolean
  models: CatalogModel[] | null
  usage: ProviderRateLimits | null
  now: number
  requiresWorkPlan?: boolean
  skipUsageGating?: boolean
  openrouterRouting?: boolean
  /**
   * Build + Review setup: a missing or old reading (the app polls every 15 minutes) keeps an
   * installed agent selectable, marked `usageUnchecked`, while a real reading is fetched. A
   * reading that says signed out, failed or exhausted still excludes it. Pass it only for an
   * agent that `hasUsageFeed`: for one without, no reading will ever arrive to confirm it.
   */
  admitUncheckedUsage?: boolean
  /**
   * A host-read CLI login, for an agent whose launch needs one (Kimi): `null` means not read yet
   * or not reported by that host. Omit it for an agent without such a check.
   */
  signedIn?: boolean | null
}): WorkAgentCapability {
  let models = input.models ?? []
  const result = (status: WorkAgentStatus): WorkAgentCapability => ({
    status,
    models: status === 'usable' ? models : [],
    checkedAt: input.now
  })
  if (input.requiresWorkPlan) {
    return result('work-plan-required')
  }
  if (input.disabled) {
    return result('disabled')
  }
  if (!input.installed) {
    return result('cli-missing')
  }
  if (input.signedIn === false) {
    return result('logged-out')
  }
  if (input.signedIn === null) {
    return result('unverified')
  }
  if (input.skipUsageGating) {
    return result('usable')
  }
  if (input.openrouterRouting) {
    models = models.filter((model) => model.openrouterRouting === 'omp-openrouter-routing-v1')
    return result(models.length ? 'usable' : 'unverified')
  }
  const usage = input.usage
  if (
    usage?.usageMetadata?.failureKind === 'missing-credentials' ||
    usage?.usageMetadata?.failureKind === 'stale-token'
  ) {
    return result('logged-out')
  }
  if (!usage || input.now - usage.updatedAt > WORK_AGENT_USAGE_FRESH_MS) {
    // Why only these: an old 'ok' (or a first read still in flight) proves nothing against the
    // agent; an old failure or 'unavailable' (Grok signed out reads so) is not waved through.
    const unchecked = !usage || ['ok', 'idle', 'fetching'].includes(usage.status)
    if (input.admitUncheckedUsage && unchecked) {
      if (usage && stillExhausted(usage, input.now)) {
        return result('quota-exhausted')
      }
      return input.models?.length && usage
        ? withModelWindows({ ...result('usable'), usageUnchecked: true }, usage, input.now, true)
        : input.models?.length
          ? { ...result('usable'), usageUnchecked: true }
          : result('model-unavailable')
    }
    return result('unverified')
  }
  if (usage.status !== 'ok') {
    return result('health-check-failed')
  }
  const windows = usageWindows(usage)
  if (windows.length === 0 && !usage.buckets?.length) {
    return result('unverified')
  }
  if (windows.some((window) => window.usedPercent >= 100)) {
    return result('quota-exhausted')
  }
  if (!input.models?.length) {
    return result('model-unavailable')
  }
  return withModelWindows(result('usable'), usage, input.now, false)
}
