/** How agent sleep (R1) counts, logs and caches a pane it keeps awake. */

import { useAppStore } from '@/store'
import type { IdleKeepReason } from '../../../shared/idle-auto-close-settings'
import type { AgentHibernationCandidate } from './agent-hibernation-planner'
import { recordStaleDoneDrop } from './agent-sleep-audit'
import type { AgentSleepGuardVerdict } from './agent-sleep-guards'
import type { AgentSleepPolicy } from './agent-sleep-policy'
import { cacheAgentSleepVerdict, cachedAgentSleepVerdict } from './agent-sleep-verdict-cache'
import { rememberAgentPane } from './idle-auto-close/agent-pane-history'

export type KeptCounts = Partial<Record<IdleKeepReason, number>>

/** Keeps the window reads for free and that change by the second: never cached. */
const WINDOW_KEEPS: ReadonlySet<IdleKeepReason> = new Set([
  'visible',
  'thrash-exempt',
  'recent-touch',
  'interrupted-restore'
])

/** Counts a keep, drops a stale done entry (logged; dropped only when acting), caches the rest. */
export function noteAgentSleepKeep(
  candidate: AgentHibernationCandidate,
  verdict: AgentSleepGuardVerdict & { keep: IdleKeepReason },
  policy: AgentSleepPolicy,
  now: number,
  kept: KeptCounts
): void {
  kept[verdict.keep] = (kept[verdict.keep] ?? 0) + 1
  if (verdict.keep === 'shell-foreground') {
    recordStaleDoneDrop(candidate, policy, policy.act, now, verdict.evidence)
    if (policy.act) {
      // Why no resume record: there is no agent left to resume, only its stale done entry. The
      // pane is remembered so R2 never closes the shell holding that agent's transcript.
      rememberAgentPane(candidate.paneKey)
      useAppStore.getState().removeAgentStatus(candidate.paneKey)
    }
  }
  if (!WINDOW_KEEPS.has(verdict.keep)) {
    cacheAgentSleepVerdict(candidate, policy, now, verdict.keep)
  }
}

/** A keep from a cached verdict counts and ends there; true when the cache answered. */
export function takeCachedAgentSleepVerdict(
  candidate: AgentHibernationCandidate,
  policy: AgentSleepPolicy,
  now: number,
  kept: KeptCounts
): boolean {
  const cached = cachedAgentSleepVerdict(candidate, policy, now)
  if (cached?.keep) {
    kept[cached.keep] = (kept[cached.keep] ?? 0) + 1
  }
  return cached !== null
}
