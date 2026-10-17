/**
 * Who is waiting on whom: every pending "wait for another session's result" (`event.source:
 * 'session'`, `session-outcome-event.ts`) across this host's plans, keyed by the awaited session's
 * pane key. A wait stops being listed the moment its waiter holds the receipt, so an awaited
 * session is kept (never archived by the steward or by a Tier 1 finish) exactly until the waiter
 * has picked up its result. The rules loop, Tier 2 and `session list`'s `waitedOnBy` read this.
 */

import type { SessionChain } from '../../shared/session-chain-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { isFinishedOutcomeChain } from '../runtime/session-outcome-source-uniqueness'

export type SessionWaiter = {
  /** The waiting conversation: its pane, workspace and sidebar row. */
  paneKey: string
  worktreeId: string
  rowKey: string
  chainId: string
  outcomeId: string
  conditionId: string
  /** How the waiter's plan names the wait ("Billing session finishes"). */
  label: string
}

/** Awaited session pane key → the conversations waiting on its result. */
export type SessionWaiters = ReadonlyMap<string, readonly SessionWaiter[]>

/** The index over plans already read; pure, so a caller holding the chains pays no second read. */
export function sessionWaitersFromChains(chains: readonly SessionChain[]): SessionWaiters {
  const waiters = new Map<string, SessionWaiter[]>()
  for (const chain of chains) {
    const set = chain.outcomeSet
    if (!set || set.completion || chain.quarantine || isFinishedOutcomeChain(chain)) {
      continue
    }
    for (const outcome of set.outcomes) {
      if (outcome.status === 'satisfied') {
        continue
      }
      for (const condition of outcome.conditions) {
        const event = condition.event
        if (condition.kind !== 'event' || event?.source !== 'session' || !event.ref) {
          continue
        }
        const picked = outcome.evidence.some(
          (entry) =>
            entry.conditionId === condition.id && entry.outcomeRevision === outcome.revision
        )
        if (picked) {
          continue
        }
        const list = waiters.get(event.ref) ?? []
        list.push({
          paneKey: chain.sourcePaneKey,
          worktreeId: chain.sourceWorktreeId ?? chain.worktreeId,
          rowKey: chain.sourceRowKey ?? '',
          chainId: chain.id,
          outcomeId: outcome.id,
          conditionId: condition.id,
          label: condition.label ?? condition.target
        })
        waiters.set(event.ref, list)
      }
    }
  }
  return waiters
}

export function listSessionWaiters(
  runtime: Pick<OrcaRuntimeService, 'listSessionChains'>
): SessionWaiters {
  return sessionWaitersFromChains(runtime.listSessionChains())
}

/**
 * The circle a new wait of `waiter` on `awaited` would close, as the pane keys around it
 * (`[waiter, awaited, …, waiter]`), or null when there is none. Waiting on itself is a circle too.
 */
export function sessionWaitCycle(
  waiters: SessionWaiters,
  waiter: string,
  awaited: string
): string[] | null {
  if (waiter === awaited) {
    return [waiter, waiter]
  }
  // Edges run waiter → awaited; a path from `awaited` back to `waiter` closes the circle.
  const awaiting = new Map<string, Set<string>>()
  for (const [target, list] of waiters) {
    for (const entry of list) {
      const next = awaiting.get(entry.paneKey) ?? new Set<string>()
      next.add(target)
      awaiting.set(entry.paneKey, next)
    }
  }
  const seen = new Set<string>([awaited])
  const walk = (at: string, path: string[]): string[] | null => {
    for (const next of awaiting.get(at) ?? []) {
      if (next === waiter) {
        return [...path, next]
      }
      if (!seen.has(next)) {
        seen.add(next)
        const found = walk(next, [...path, next])
        if (found) {
          return found
        }
      }
    }
    return null
  }
  return walk(awaited, [waiter, awaited])
}

/**
 * The first unanswered event wait (a Jira reply, a session result, a time) in a pane's own live
 * plan, as its label; null when it waits on nothing. The idle rules keep that pane while it waits.
 */
export function pendingEventWaitOf(
  chains: readonly SessionChain[],
  paneKey: string
): string | null {
  for (const chain of chains) {
    const set = chain.outcomeSet
    if (
      chain.sourcePaneKey !== paneKey ||
      !set ||
      set.completion ||
      chain.quarantine ||
      isFinishedOutcomeChain(chain)
    ) {
      continue
    }
    for (const outcome of set.outcomes) {
      if (outcome.status === 'satisfied') {
        continue
      }
      for (const condition of outcome.conditions) {
        if (condition.kind !== 'event' || !condition.event) {
          continue
        }
        const picked = outcome.evidence.some(
          (entry) =>
            entry.conditionId === condition.id && entry.outcomeRevision === outcome.revision
        )
        if (!picked) {
          return condition.label ?? condition.target ?? 'an event'
        }
      }
    }
  }
  return null
}
