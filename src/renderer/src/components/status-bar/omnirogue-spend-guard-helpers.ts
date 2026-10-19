import { formatOmniRogueCredits, formatOmniRogueShare } from './omnirogue-usage-helpers'

export type OmniRogueSpendGuardPeriod = 'session' | 'daily' | 'weekly' | 'monthly'

export type OmniRogueSpendGuardLimit = {
  period: OmniRogueSpendGuardPeriod
  limitCredits: number
  spentCredits: number
  /** ISO-8601 time the period's spend resets. */
  resetsAt?: string | null
  /** 0..1 share of the limit at which the guard starts warning. */
  warningRatio?: number
}

export type OmniRogueSpendGuardLevel = 'ok' | 'warning' | 'reached'

export type OmniRogueSpendGuardState = {
  level: OmniRogueSpendGuardLevel
  period: OmniRogueSpendGuardPeriod
  limitCredits: number
  spentCredits: number
  remainingCredits: number
  overageCredits: number
  /** spent / limit; exceeds 1 once the limit is overrun. */
  usedRatio: number
  warningRatio: number
  resetsAt: Date | null
}

export type OmniRogueSpendGuardLabels = {
  warningHeading: string
  reachedHeading: string
  warningBody: string
  reachedBody: string
  resetsIn: string
  progressAriaLabel: string
  raiseLimitAction: string
  reviewUsageAction: string
  dismissAction: string
  periodSession: string
  periodDaily: string
  periodWeekly: string
  periodMonthly: string
}

// Templates use {{name}} placeholders, filled by formatOmniRogueSpendGuardText.
export const OMNIROGUE_SPEND_GUARD_DEFAULT_LABELS: OmniRogueSpendGuardLabels = {
  warningHeading: '{{period}} spend limit almost reached',
  reachedHeading: '{{period}} spend limit reached',
  warningBody: '{{spent}} of {{limit}} credits used ({{percent}}). {{remaining}} credits left.',
  reachedBody:
    '{{spent}} of {{limit}} credits used. Credit spending is paused until the limit resets or you raise it.',
  resetsIn: 'Resets {{time}}',
  progressAriaLabel: '{{period}} spend limit: {{percent}} used',
  raiseLimitAction: 'Raise limit',
  reviewUsageAction: 'Review usage',
  dismissAction: 'Dismiss spend limit warning',
  periodSession: 'Session',
  periodDaily: 'Daily',
  periodWeekly: 'Weekly',
  periodMonthly: 'Monthly'
}

export const OMNIROGUE_SPEND_GUARD_DEFAULT_WARNING_RATIO = 0.8

const PERIOD_LABEL_KEYS: Record<OmniRogueSpendGuardPeriod, keyof OmniRogueSpendGuardLabels> = {
  session: 'periodSession',
  daily: 'periodDaily',
  weekly: 'periodWeekly',
  monthly: 'periodMonthly'
}

const LEVEL_SEVERITY: Record<OmniRogueSpendGuardLevel, number> = {
  ok: 0,
  warning: 1,
  reached: 2
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function resolveWarningRatio(value: number | undefined): number {
  if (isFiniteNumber(value) && value > 0 && value < 1) {
    return value
  }
  return OMNIROGUE_SPEND_GUARD_DEFAULT_WARNING_RATIO
}

function parseResetsAt(value: string | null | undefined): Date | null {
  if (!value) {
    return null
  }
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : new Date(time)
}

export function mergeOmniRogueSpendGuardLabels(
  overrides: Partial<OmniRogueSpendGuardLabels> | undefined
): OmniRogueSpendGuardLabels {
  if (!overrides) {
    return OMNIROGUE_SPEND_GUARD_DEFAULT_LABELS
  }
  const merged = { ...OMNIROGUE_SPEND_GUARD_DEFAULT_LABELS }
  for (const key of Object.keys(merged) as (keyof OmniRogueSpendGuardLabels)[]) {
    const value = overrides[key]
    // Blank overrides would render an empty heading or button, so they keep the default.
    if (typeof value === 'string' && value.trim() !== '') {
      merged[key] = value
    }
  }
  return merged
}

/** Null when the limit is missing or unusable (no positive cap, non-finite spend). */
export function resolveOmniRogueSpendGuard(
  limit: OmniRogueSpendGuardLimit | null | undefined
): OmniRogueSpendGuardState | null {
  if (!limit || !isFiniteNumber(limit.limitCredits) || limit.limitCredits <= 0) {
    return null
  }
  if (!isFiniteNumber(limit.spentCredits)) {
    return null
  }
  // Refunds can push net spend negative; that is still zero usage against the cap.
  const spentCredits = Math.max(0, limit.spentCredits)
  const usedRatio = spentCredits / limit.limitCredits
  const warningRatio = resolveWarningRatio(limit.warningRatio)
  let level: OmniRogueSpendGuardLevel = 'ok'
  if (usedRatio >= 1) {
    level = 'reached'
  } else if (usedRatio >= warningRatio) {
    level = 'warning'
  }
  return {
    level,
    period: limit.period,
    limitCredits: limit.limitCredits,
    spentCredits,
    remainingCredits: Math.max(0, limit.limitCredits - spentCredits),
    overageCredits: Math.max(0, spentCredits - limit.limitCredits),
    usedRatio,
    warningRatio,
    resetsAt: parseResetsAt(limit.resetsAt)
  }
}

/** The most severe guard across limits; ties go to the one closest to (or furthest past) its cap. */
export function pickOmniRogueSpendGuard(
  limits: readonly OmniRogueSpendGuardLimit[] | null | undefined
): OmniRogueSpendGuardState | null {
  let picked: OmniRogueSpendGuardState | null = null
  for (const limit of limits ?? []) {
    const state = resolveOmniRogueSpendGuard(limit)
    if (!state) {
      continue
    }
    if (!picked) {
      picked = state
      continue
    }
    const severityDelta = LEVEL_SEVERITY[state.level] - LEVEL_SEVERITY[picked.level]
    if (severityDelta > 0 || (severityDelta === 0 && state.usedRatio > picked.usedRatio)) {
      picked = state
    }
  }
  return picked
}

export function formatOmniRogueSpendGuardText(
  template: string,
  values: Readonly<Record<string, string>>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match)
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Relative reset time ("in 3 hours", "tomorrow"); null once the reset is not in the future. */
export function formatOmniRogueSpendGuardResetTime(
  resetsAt: Date | null,
  now: Date,
  locale = 'en-US'
): string | null {
  if (!resetsAt) {
    return null
  }
  const deltaMs = resetsAt.getTime() - now.getTime()
  if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
    return null
  }
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  if (deltaMs < HOUR_MS) {
    return format.format(Math.max(1, Math.ceil(deltaMs / MINUTE_MS)), 'minute')
  }
  if (deltaMs < DAY_MS) {
    return format.format(Math.round(deltaMs / HOUR_MS), 'hour')
  }
  return format.format(Math.round(deltaMs / DAY_MS), 'day')
}

export type OmniRogueSpendGuardCopy = {
  heading: string
  body: string
  resetNote: string | null
  progressAriaLabel: string
  percent: string
}

export function buildOmniRogueSpendGuardCopy(
  state: OmniRogueSpendGuardState,
  labels: OmniRogueSpendGuardLabels,
  now: Date,
  locale?: string
): OmniRogueSpendGuardCopy {
  const percent = formatOmniRogueShare(state.usedRatio)
  const values = {
    period: labels[PERIOD_LABEL_KEYS[state.period]],
    spent: formatOmniRogueCredits(state.spentCredits),
    limit: formatOmniRogueCredits(state.limitCredits),
    remaining: formatOmniRogueCredits(state.remainingCredits),
    overage: formatOmniRogueCredits(state.overageCredits),
    percent
  }
  const reached = state.level === 'reached'
  const resetTime = formatOmniRogueSpendGuardResetTime(state.resetsAt, now, locale)
  return {
    heading: formatOmniRogueSpendGuardText(
      reached ? labels.reachedHeading : labels.warningHeading,
      values
    ),
    body: formatOmniRogueSpendGuardText(reached ? labels.reachedBody : labels.warningBody, values),
    resetNote: resetTime
      ? formatOmniRogueSpendGuardText(labels.resetsIn, { time: resetTime })
      : null,
    progressAriaLabel: formatOmniRogueSpendGuardText(labels.progressAriaLabel, values),
    percent
  }
}

/** What the person dismissed: escalating to "reached" or entering a new period shows it again. */
export function omniRogueSpendGuardDismissKey(state: OmniRogueSpendGuardState): string {
  return `${state.period}:${state.level}:${state.resetsAt?.toISOString() ?? ''}`
}
