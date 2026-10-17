/**
 * Adoption's wait re-pointer (Phase 3 §3): when a session is merged or handed off into another,
 * every open "wait for its result" on it is recommitted to wait on the target instead, through the
 * outcome service, bound to the waiter's current revision. The new ref resets the old receipt, and
 * commit re-runs S3's wait admission (switch, no cycle, local target).
 */

import type { SessionChain } from '../../shared/session-chain-types'
import {
  sessionOutcomeDefinition,
  type SessionOutcomeDefinition
} from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import type { SessionWaitRepointer } from '../session-manage/session-transfer-adoption'
import { listSessionWaiters, type SessionWaiter } from './steward-waiters'

/** The waiter's outcomes with each open wait on `from` now on `to`, and how many moved. */
export function repointedOutcomes(
  chain: Pick<SessionChain, 'outcomeSet'>,
  waits: readonly Pick<SessionWaiter, 'outcomeId' | 'conditionId'>[],
  from: string,
  to: string
): { outcomes: SessionOutcomeDefinition[]; moved: number } {
  let moved = 0
  const open = new Set(waits.map((wait) => `${wait.outcomeId}\n${wait.conditionId}`))
  const outcomes = (chain.outcomeSet?.outcomes ?? []).map((outcome) => {
    const definition = sessionOutcomeDefinition(outcome)
    return {
      ...definition,
      conditions: definition.conditions.map((condition) => {
        if (
          condition.kind !== 'event' ||
          condition.event?.source !== 'session' ||
          condition.event.ref !== from ||
          !open.has(`${outcome.id}\n${condition.id}`)
        ) {
          return condition
        }
        moved += 1
        return {
          ...condition,
          ...(condition.target === from ? { target: to } : {}),
          event: { ...condition.event, ref: to }
        }
      })
    }
  })
  return { outcomes, moved }
}

export function runtimeSessionWaitRepointer(
  runtime: Pick<OrcaRuntimeService, 'listSessionChains' | 'getSessionOutcomeService'>
): SessionWaitRepointer {
  return async ({ from, to }) => {
    const waits = listSessionWaiters(runtime).get(from) ?? []
    let moved = 0
    for (const chainId of new Set(waits.map((wait) => wait.chainId))) {
      const chain = runtime.listSessionChains().find((entry) => entry.id === chainId)
      const set = chain?.outcomeSet
      if (!chain || !set) {
        continue
      }
      const next = repointedOutcomes(
        chain,
        waits.filter((wait) => wait.chainId === chainId),
        from,
        to
      )
      if (next.moved === 0) {
        continue
      }
      // Why `user`: the waiter's plan is unchanged in intent; only what it waits on was merged.
      await runtime.getSessionOutcomeService().commit(chain, {
        source: 'user',
        expectedRevision: set.revision,
        outcomes: next.outcomes
      })
      moved += next.moved
    }
    return moved
  }
}
