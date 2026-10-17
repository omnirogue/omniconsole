import { mkdirSync } from 'node:fs'
import { loadavg } from 'node:os'
import { join } from 'node:path'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/commit-message-agent-environment'
import { generateSessionSummaryTextFromPrompt } from '../text-generation/commit-message-text-generation'
import { isQuietBackgroundAgentRunsEnabled } from '../text-generation/quiet-background-runs'
import { lastRestoreSweepAgentStartAt } from '../pty/restore-sweep-activity'
import type { SessionSearchService } from './session-search-service'

const FIRST_RUN_DELAY_MS = 5 * 60_000
const INTERVAL_MS = 5 * 60_000
/** At most this many model summaries per interval: ~72 an hour on the cheapest model, newest first. */
const PER_RUN = 6
const MIN_TEXT_BYTES = 6_000
const SUMMARY_SETTLE_MS = 2 * 60_000
const ACTIVE_WITHIN_MS = 14 * 24 * 60 * 60_000
const USAGE_FRESH_MS = 30 * 60_000
const MAX_SESSION_PERCENT = 60
const MAX_WEEKLY_PERCENT = 80
const SUMMARY_MODEL = 'haiku'
/** Quiet background runs: no round while the 1-minute load average is above this. */
export const SUMMARY_MAX_LOAD_AVERAGE = 8
/** Quiet background runs: no round this soon after the app started or a restore sweep. */
export const SUMMARY_QUIET_AFTER_MS = 10 * 60_000
const APP_STARTED_AT = Date.now() - process.uptime() * 1000

export type SessionSummaryDeps = {
  service: () => SessionSearchService | null
  claudeUsage: () => ProviderRateLimits | null
  agentEnv: () => CommitMessageAgentEnvironmentResolvers | undefined
  userDataPath: string
  now?: () => number
  /** Defaults to this machine's 1-minute load average. */
  loadAverage?: () => number
  /** Defaults to when this process started. */
  appStartedAt?: number
  /** Defaults to the last background restore start main saw. */
  lastRestoreSweepAt?: () => number | null
  /** Defaults to the `quietBackgroundAgentRuns` setting (on). */
  quietBackgroundRuns?: () => boolean
}

export type SessionSummaryPauseReason = 'app-start' | 'restore-sweep' | 'load'

/**
 * Why a summary round waits (quiet background runs): summaries are the most deferrable Claude
 * work OmniConsole starts, so they never add load right after start, during a restore sweep's
 * aftermath or while the Mac is already busy. Null when a round may run.
 */
export function sessionSummaryPauseReason(
  deps: Omit<SessionSummaryDeps, 'service' | 'claudeUsage' | 'agentEnv' | 'userDataPath'>,
  now: number
): SessionSummaryPauseReason | null {
  if (!(deps.quietBackgroundRuns ?? isQuietBackgroundAgentRunsEnabled)()) {
    return null
  }
  if (now - (deps.appStartedAt ?? APP_STARTED_AT) < SUMMARY_QUIET_AFTER_MS) {
    return 'app-start'
  }
  const sweep = (deps.lastRestoreSweepAt ?? lastRestoreSweepAgentStartAt)()
  if (sweep !== null && now - sweep < SUMMARY_QUIET_AFTER_MS) {
    return 'restore-sweep'
  }
  const load = (deps.loadAverage ?? (() => loadavg()[0] ?? 0))()
  return load > SUMMARY_MAX_LOAD_AVERAGE ? 'load' : null
}

/**
 * Summaries spend the person's own Claude capacity, so they run only while that account reports
 * fresh usage well under its limits. Unknown, stale or failing usage is not spare capacity, and
 * stopping well short of a limit means a summary can never reach paid extra usage.
 */
export function hasSpareClaudeCapacity(usage: ProviderRateLimits | null, now: number): boolean {
  if (!usage || usage.status !== 'ok' || now - usage.updatedAt > USAGE_FRESH_MS) {
    return false
  }
  if (!usage.session || usage.session.usedPercent >= MAX_SESSION_PERCENT) {
    return false
  }
  return !usage.weekly || usage.weekly.usedPercent < MAX_WEEKLY_PERCENT
}

export async function runSessionSummaryRound(deps: SessionSummaryDeps): Promise<number> {
  const now = deps.now?.() ?? Date.now()
  const service = deps.service()
  if (
    !service ||
    sessionSummaryPauseReason(deps, now) !== null ||
    !hasSpareClaudeCapacity(deps.claudeUsage(), now)
  ) {
    return 0
  }
  const candidates = await service.summaryCandidates({
    limit: PER_RUN,
    minBytes: MIN_TEXT_BYTES,
    activeSinceMs: now - ACTIVE_WITHIN_MS,
    idleBeforeMs: now - SUMMARY_SETTLE_MS
  })
  if (candidates.length === 0) {
    return 0
  }
  const prepared = await prepareLocalCommitMessageAgentEnv('claude', deps.agentEnv(), {
    runtime: 'host'
  })
  if (!prepared.ok) {
    return 0
  }
  // Why: a private, empty working folder, so the one-shot run reads no project instructions.
  const cwd = join(deps.userDataPath, 'session-search', 'summarizer')
  mkdirSync(cwd, { recursive: true })
  let saved = 0
  for (const candidate of candidates) {
    const at = deps.now?.() ?? Date.now()
    if (
      sessionSummaryPauseReason(deps, at) !== null ||
      !hasSpareClaudeCapacity(deps.claudeUsage(), at)
    ) {
      break
    }
    const result = await generateSessionSummaryTextFromPrompt(
      candidate.prompt,
      { agentId: 'claude', model: SUMMARY_MODEL },
      { kind: 'local', cwd, ...(prepared.env ? { env: prepared.env } : {}) }
    )
    if (!result.success) {
      continue
    }
    if (
      await service.saveModelSummary(candidate.sessionKey, result.rawOutput, candidate.basisBytes)
    ) {
      saved += 1
    }
  }
  return saved
}

export function startSessionSummaries(deps: SessionSummaryDeps): () => void {
  if (process.env.OMNI_SESSION_SUMMARIES_DISABLED === '1') {
    return () => undefined
  }
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  const run = async (): Promise<void> => {
    await runSessionSummaryRound(deps).catch((error: unknown) =>
      console.error('[session-search] summary round failed:', error)
    )
    if (!stopped) {
      timer = setTimeout(() => void run(), INTERVAL_MS)
      timer.unref?.()
    }
  }
  timer = setTimeout(() => void run(), FIRST_RUN_DELAY_MS)
  timer.unref?.()
  return () => {
    stopped = true
    if (timer) {
      clearTimeout(timer)
    }
  }
}
