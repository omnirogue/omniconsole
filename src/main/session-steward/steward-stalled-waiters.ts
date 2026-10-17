/**
 * Waiters that could not be woken: a session waiting on another session's result whose next step
 * is blocked with a reason starting "Stalled: " (its conversation exited and could not be resumed,
 * WP-S3). They join the steward's own Stalled list, `session list` and the pile-up count.
 */

import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionStewardStalled } from '../../shared/session-steward-status'
import { isFinishedOutcomeChain } from '../runtime/session-outcome-source-uniqueness'
import type { StewardPassMemory } from './steward-pass'
import type { StewardStateData } from './steward-state-store'

export const STEWARD_STALLED_PREFIX = 'Stalled: '

export type StewardStalledWaiter = { at: number; reason: string }

/** Waiting pane → why it is Stalled, from each live plan's newest attempt. */
export function stalledWaitersFromChains(
  chains: readonly SessionChain[]
): Map<string, StewardStalledWaiter> {
  const stalled = new Map<string, StewardStalledWaiter>()
  for (const chain of chains) {
    const set = chain.outcomeSet
    if (!set || chain.quarantine || chain.state === 'cancelled' || isFinishedOutcomeChain(chain)) {
      continue
    }
    const newest = set.attempts.reduce<(typeof set.attempts)[number] | null>(
      (best, attempt) => (!best || attempt.updatedAt > best.updatedAt ? attempt : best),
      null
    )
    if (newest?.state !== 'blocked' || !newest.error?.startsWith(STEWARD_STALLED_PREFIX)) {
      continue
    }
    const known = stalled.get(chain.sourcePaneKey)
    if (!known || newest.updatedAt > known.at) {
      stalled.set(chain.sourcePaneKey, {
        at: newest.updatedAt,
        reason: newest.error.slice(STEWARD_STALLED_PREFIX.length)
      })
    }
  }
  return stalled
}

/** The steward's own Stalled sessions, then waiters that could not be woken; newest first. */
export function stewardStalledList(
  data: Pick<StewardStateData, 'sessions'>,
  memory: Pick<StewardPassMemory, 'seen' | 'titles'>,
  waiters: ReadonlyMap<string, StewardStalledWaiter>
): SessionStewardStalled[] {
  // Why the last pass's rows: an archived or closed session is no longer Stalled in view.
  const own = Object.entries(data.sessions).flatMap(([paneKey, session]) =>
    session.stalled && (memory.seen.size === 0 || memory.seen.has(paneKey))
      ? [
          {
            paneKey,
            title: session.title ?? paneKey,
            at: session.stalled.at,
            reason: session.stalled.reason
          }
        ]
      : []
  )
  const listed = new Set(own.map((entry) => entry.paneKey))
  const waiting = [...waiters]
    .filter(([paneKey]) => !listed.has(paneKey))
    .map(([paneKey, waiter]) => ({
      paneKey,
      title: memory.titles.get(paneKey) ?? data.sessions[paneKey]?.title ?? paneKey,
      at: waiter.at,
      reason: waiter.reason
    }))
  return [...own, ...waiting].toSorted((left, right) => right.at - left.at)
}
