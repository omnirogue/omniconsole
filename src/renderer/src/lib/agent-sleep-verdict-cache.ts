import type { IdleKeepReason } from '../../../shared/idle-auto-close-settings'
import type { AgentHibernationCandidate } from './agent-hibernation-planner'
import type { AgentSleepPolicy } from './agent-sleep-policy'

/**
 * How long a keep that main or the process table answered stands for the same pane facts. Why:
 * re-reading every confirmed pane's screen and processes every minute is real work for main; a
 * cached keep only keeps longer, and acting always re-reads (G4).
 */
export const AGENT_SLEEP_VERDICT_TTL_MS = 5 * 60 * 1000
/** A keep in shadow stands longer: nothing acts on it, so its would-line can wait a little. */
export const AGENT_SLEEP_SHADOW_KEEP_TTL_MS = 15 * 60 * 1000

type CachedVerdict = { signature: string; until: number; act: boolean; keep: IdleKeepReason | null }

const verdictByCandidateId = new Map<string, CachedVerdict>()

/** A still-valid verdict for these exact pane facts, or null when the guards must run again. */
export function cachedAgentSleepVerdict(
  candidate: AgentHibernationCandidate,
  policy: AgentSleepPolicy,
  now: number
): { keep: IdleKeepReason | null } | null {
  const cached = verdictByCandidateId.get(candidate.id)
  if (!cached || cached.signature !== candidate.signature || now >= cached.until) {
    return null
  }
  // Why: a cached would-do never stands in for an act; a cached keep always may.
  return cached.keep !== null || cached.act === policy.act ? { keep: cached.keep } : null
}

export function cacheAgentSleepVerdict(
  candidate: AgentHibernationCandidate,
  policy: AgentSleepPolicy,
  now: number,
  keep: IdleKeepReason | null
): void {
  verdictByCandidateId.set(candidate.id, {
    signature: candidate.signature,
    // Why until the facts change: a shadow would-do acts on nothing and its line is written once,
    // so re-reading it every few minutes (40 idle agents, forever, for everyone) bought nothing.
    until:
      keep === null && !policy.act
        ? Number.POSITIVE_INFINITY
        : now + (policy.act ? AGENT_SLEEP_VERDICT_TTL_MS : AGENT_SLEEP_SHADOW_KEEP_TTL_MS),
    act: policy.act,
    keep
  })
}

/** Forgets verdicts for panes that are no longer candidates. */
export function pruneAgentSleepVerdicts(liveCandidateIds: ReadonlySet<string>): void {
  for (const id of verdictByCandidateId.keys()) {
    if (!liveCandidateIds.has(id)) {
      verdictByCandidateId.delete(id)
    }
  }
}

export function clearAgentSleepVerdicts(): void {
  verdictByCandidateId.clear()
}
