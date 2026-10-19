import type {
  AccountCapacityRow,
  CapacityProvider,
  CapacityWindow
} from './provider-account-capacity'
import { accountQuotaBurnRisk } from './account-quota-burn'
import {
  AGENT_LAUNCH_RECEIPT_MAX_EXCLUDED,
  type AgentLaunchAccountCandidate,
  type AgentLaunchAccountReceipt,
  type AgentLaunchHostId
} from './agent-launch-account'

/** Parity with the SSH relay's bound, so every host kind verifies to the same contract. */
export const LAUNCH_ACCOUNT_FRESH_MS = 60_000
export const LAUNCH_ACCOUNT_REFRESH_AFTER_MS = 30_000
export const LAUNCH_ACCOUNT_REFRESH_WAIT_MS = 15_000
export const LAUNCH_ACCOUNT_REFRESH_CONCURRENCY = 4

/**
 * - `require`: a Fable model; its window must be known, is counted, and must have room.
 * - `gate`: the model may resolve to Fable; an exhausted Fable window excludes the account.
 * - `ignore`: the model is known not to be Fable.
 */
export type LaunchFableRule = 'require' | 'gate' | 'ignore'

export type LaunchAccountBound = 'five-hour' | 'weekly' | 'fable-weekly'

export type LaunchAccountFresh = {
  state: 'fresh'
  remainingPercent: number
  boundBy: LaunchAccountBound
  fableVerified: boolean
}

export type LaunchAccountUnavailable = {
  state: 'stale' | 'unknown' | 'limited' | 'signed-out'
  reason: string
  until?: number
}

/** Unknown and stale are never spare capacity and never 0%: only `fresh` may be picked. */
export type LaunchAccountVerdict = LaunchAccountFresh | LaunchAccountUnavailable

export type LaunchAccountVerdictEntry = {
  row: AccountCapacityRow
  label: string
  verdict: LaunchAccountVerdict | { state: 'not-considered'; reason: string }
}

export type LaunchAccountChoice = {
  pick: { row: AccountCapacityRow; label: string; verdict: LaunchAccountFresh } | null
  verdicts: LaunchAccountVerdictEntry[]
  fable: LaunchFableRule
}

const BOUND_LABEL: Record<LaunchAccountBound, string> = {
  'five-hour': '5-hour',
  weekly: 'weekly',
  'fable-weekly': 'Fable weekly'
}

export function isKnownNonFableClaudeModel(model: string | null | undefined): boolean {
  return /\b(?:opus|sonnet|haiku)\b/i.test(model ?? '') && !/fable/i.test(model ?? '')
}

export function launchFableRule(
  provider: CapacityProvider,
  model: string | null | undefined
): LaunchFableRule {
  if (model && /fable/i.test(model)) {
    return 'require'
  }
  return provider === 'codex' || isKnownNonFableClaudeModel(model) ? 'ignore' : 'gate'
}

export type LaunchAccountClassifyOptions = {
  now: number
  freshMs: number
  fable: LaunchFableRule
  /**
   * When the Fable window itself was last read. A live statusline post moves `readingAt` but
   * carries the Fable window over from an older reading, so `readingAt` cannot vouch for it.
   * Omitted or null: unknown, so Fable is never verified.
   */
  fableReadingAt?: number | null
}

export function classifyLaunchAccountRow(
  row: AccountCapacityRow,
  options: LaunchAccountClassifyOptions
): LaunchAccountVerdict {
  if (row.state === 'checking') {
    return { state: 'unknown', reason: 'first reading in progress' }
  }
  if (row.state === 'signed-out' || !row.launchEnv) {
    const why = row.signedOutReason === 'revoked' || row.signedOutReason === 'expired'
    return {
      state: 'signed-out',
      reason: why ? `sign-in ${row.signedOutReason}` : 'not signed in'
    }
  }
  const counted: [LaunchAccountBound, CapacityWindow][] = []
  if (row.fiveHour) {
    counted.push(['five-hour', row.fiveHour])
  }
  if (row.weekly) {
    counted.push(['weekly', row.weekly])
  }
  if (options.fable === 'require' && row.fableWeekly) {
    counted.push(['fable-weekly', row.fableWeekly])
  }
  const exhausted = counted.find(([, window]) => window.remainingPercent <= 0)
  if (row.state === 'limited' || exhausted) {
    return {
      state: 'limited',
      reason: exhausted ? `${BOUND_LABEL[exhausted[0]]} window exhausted` : 'at its usage limit',
      ...(row.limitedUntil !== null ? { until: row.limitedUntil } : {})
    }
  }
  if (options.fable === 'gate' && row.fableWeekly && row.fableWeekly.remainingPercent <= 0) {
    return { state: 'limited', reason: 'Fable window exhausted' }
  }
  if ((!row.fiveHour && !row.weekly) || row.readingAt === null) {
    return { state: 'unknown', reason: 'no usage reading' }
  }
  if (options.fable === 'require' && !row.fableWeekly) {
    return { state: 'unknown', reason: 'no Fable reading' }
  }
  const age = options.now - row.readingAt
  if (row.state !== 'ready' || age > options.freshMs) {
    return {
      state: 'stale',
      reason: row.readingPausedUntil
        ? 'usage reading paused by the provider'
        : age > options.freshMs
          ? `reading ${Math.round(age / 1000)} s old`
          : 'no current usage reading'
    }
  }
  const fableAge = options.fableReadingAt == null ? null : options.now - options.fableReadingAt
  const fableFresh = fableAge !== null && fableAge <= options.freshMs
  if (options.fable === 'require' && !fableFresh) {
    return {
      state: 'stale',
      reason:
        fableAge === null
          ? 'no current Fable reading'
          : `Fable reading ${Math.round(fableAge / 1000)} s old`
    }
  }
  const burnRisk = accountQuotaBurnRisk(row, row.readingAt, options.now)
  if (burnRisk) {
    return {
      state: 'limited',
      reason:
        burnRisk.reason === 'low-reserve'
          ? `${burnRisk.window} quota has 10% or less remaining`
          : `${burnRisk.window} quota may run out in about ${Math.ceil(burnRisk.minutesToExhaustion)} min at the window-average burn rate`
    }
  }
  const [boundBy, bound] = counted.reduce((min, entry) =>
    entry[1].remainingPercent < min[1].remainingPercent ? entry : min
  )
  return {
    state: 'fresh',
    remainingPercent: bound.remainingPercent,
    boundBy,
    fableVerified: Boolean(fableFresh && row.fableWeekly && row.fableWeekly.remainingPercent > 0)
  }
}

export function launchAccountLabel(row: AccountCapacityRow): string {
  if (row.isSystem) {
    return 'System login'
  }
  const name = row.email ?? `account ${row.accountId}`
  return `${name}${row.detail ? ` (${row.detail})` : ''}${row.sourceLabel ? ` · ${row.sourceLabel}` : ''}`
}

/** Fresh rows only, most headroom first; ties go to the default account, then choice id. */
export function chooseVerifiedLaunchAccount(
  rows: readonly AccountCapacityRow[],
  options: {
    provider: CapacityProvider
    model?: string | null
    now: number
    fableReadingAt?: (row: AccountCapacityRow) => number | null
  }
): LaunchAccountChoice {
  const fable = launchFableRule(options.provider, options.model)
  // Why: a System pin launches the *selected* account (claude fallback, codex snapshot
  // restore), so while a managed account is the default the System row is that same login.
  const managedDefault = rows.some((row) => !row.isSystem && row.isDefault)
  const verdicts: LaunchAccountVerdictEntry[] = rows.map((row) => ({
    row,
    label: launchAccountLabel(row),
    verdict:
      row.isSystem && managedDefault
        ? { state: 'not-considered', reason: 'not considered: same login as the selected default' }
        : classifyLaunchAccountRow(row, {
            now: options.now,
            freshMs: LAUNCH_ACCOUNT_FRESH_MS,
            fable,
            fableReadingAt: options.fableReadingAt?.(row) ?? null
          })
  }))
  const fresh = verdicts
    .flatMap((entry) =>
      entry.verdict.state === 'fresh'
        ? [{ row: entry.row, label: entry.label, verdict: entry.verdict }]
        : []
    )
    .sort(
      (a, b) =>
        b.verdict.remainingPercent - a.verdict.remainingPercent ||
        Number(b.row.isDefault) - Number(a.row.isDefault) ||
        a.row.choiceId.localeCompare(b.row.choiceId)
    )
  return { pick: fresh[0] ?? null, verdicts, fable }
}

export function launchAccountCandidates(
  verdicts: readonly LaunchAccountVerdictEntry[]
): AgentLaunchAccountCandidate[] {
  return verdicts.map(({ row, label, verdict }) => ({
    label,
    choiceId: row.choiceId,
    state: verdict.state,
    reason:
      verdict.state === 'fresh'
        ? `${verdict.remainingPercent}% left (${BOUND_LABEL[verdict.boundBy]})`
        : verdict.reason,
    ...('until' in verdict && verdict.until !== undefined ? { until: verdict.until } : {})
  }))
}

export function launchRefusalText(
  provider: CapacityProvider,
  hostLabel: string,
  verdicts: readonly LaunchAccountVerdictEntry[]
): string {
  const accounts = launchAccountCandidates(verdicts)
    .map((account) => `${account.label}: ${account.reason}`)
    .join('; ')
  return `No ${provider} account on ${hostLabel} has fresh verified capacity (a reading at most ${LAUNCH_ACCOUNT_FRESH_MS / 1000} s old with room left): ${accounts || 'no accounts found'}. Nothing launched.`
}

export function launchAccountReceipt(args: {
  hostId: AgentLaunchHostId
  provider: CapacityProvider
  choice: LaunchAccountChoice & { pick: NonNullable<LaunchAccountChoice['pick']> }
  now: number
}): AgentLaunchAccountReceipt {
  const { pick, verdicts } = args.choice
  const verified = verdicts.filter((entry) => entry.verdict.state === 'fresh').length
  const share = `${pick.verdict.remainingPercent}%, ${BOUND_LABEL[pick.verdict.boundBy]}`
  return {
    policy: 'best-verified',
    hostId: args.hostId,
    provider: args.provider,
    label: pick.label,
    choiceId: pick.row.choiceId,
    remainingPercent: pick.verdict.remainingPercent,
    boundBy: pick.verdict.boundBy,
    readingAt: pick.row.readingAt!,
    readingAgeMs: Math.max(0, args.now - pick.row.readingAt!),
    fableVerified: pick.verdict.fableVerified,
    verified,
    considered: verdicts.filter((entry) => entry.verdict.state !== 'not-considered').length,
    excluded: launchAccountCandidates(verdicts.filter((entry) => entry.verdict.state !== 'fresh'))
      .slice(0, AGENT_LAUNCH_RECEIPT_MAX_EXCLUDED)
      .map(({ label, reason }) => ({ label, reason })),
    why:
      verified > 1
        ? `most fresh verified headroom (${share}) of ${verified} verified accounts`
        : `the only account with fresh verified headroom (${share})`
  }
}
