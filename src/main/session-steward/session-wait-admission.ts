/**
 * The host's half of admitting "wait for another session's result": the prompt asked for a session
 * wait (`next-outcome-wait-evidence.ts`); this checks the session it names. It must be another
 * session this computer runs, and waiting on it must not close a circle — two sessions each
 * waiting for the other would both wait forever.
 */

import type { SessionChain } from '../../shared/session-chain-types'
import {
  sessionOutcomeConditionKey,
  type SessionOutcomeCommit
} from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { locateAwaitedSession } from './steward-awaited-session'
import { stewardFeatureOn } from './steward-switches'
import { listSessionWaiters, sessionWaitCycle, type SessionWaiter } from './steward-waiters'

type Runtime = Parameters<typeof locateAwaitedSession>[0] &
  Pick<OrcaRuntimeService, 'listSessionChains'>

/** Session waits this commit adds; a wait the plan already held was admitted when it was filed. */
function newSessionWaits(
  input: Pick<SessionOutcomeCommit, 'outcomes'>,
  old: SessionChain | undefined
): { outcomeId: string; conditionId: string; ref: string }[] {
  return input.outcomes.flatMap((outcome) =>
    outcome.conditions.flatMap((condition) => {
      const ref = condition.event?.source === 'session' ? condition.event.ref : undefined
      const held = old?.outcomeSet?.outcomes
        .find((prior) => prior.id === outcome.id)
        ?.conditions.some(
          (prior) => sessionOutcomeConditionKey(prior) === sessionOutcomeConditionKey(condition)
        )
      return condition.kind === 'event' && ref && !held
        ? [{ outcomeId: outcome.id, conditionId: condition.id, ref }]
        : []
    })
  )
}

export function assertSessionWaitAdmission(
  runtime: Runtime,
  chain: Pick<SessionChain, 'id' | 'sourcePaneKey' | 'worktreeId' | 'sourceWorktreeId'>,
  input: Pick<SessionOutcomeCommit, 'outcomes'>,
  old: SessionChain | undefined,
  enabled: boolean = stewardFeatureOn('sessionWaits')
): void {
  const added = newSessionWaits(input, old)
  if (!added.length) {
    return
  }
  if (!enabled) {
    throw new Error(
      'Waiting on another session is switched off on this computer (Settings → Session steward). Nothing was filed.'
    )
  }
  const index = new Map(listSessionWaiters(runtime))
  for (const wait of added) {
    const cycle = sessionWaitCycle(index, chain.sourcePaneKey, wait.ref)
    if (cycle?.length === 2) {
      throw new Error(
        `A session cannot wait on its own result: pane ${wait.ref} is this conversation. Name the other session's pane from omni session list.`
      )
    }
    if (cycle) {
      throw new Error(
        `This wait would close a circle (${cycle.join(' → ')}): each session would wait for the next and none could finish. Nothing was filed.`
      )
    }
    const location = locateAwaitedSession(runtime, wait.ref)
    if (location.kind === 'remote') {
      throw new Error(
        `The session in pane ${wait.ref} runs on ${location.where}; a wait only reads sessions this computer runs. Nothing was filed.`
      )
    }
    if (location.kind === 'missing') {
      throw new Error(
        `No session on this computer has pane ${wait.ref}. Use the pane key omni outcome wait --on-session prints.`
      )
    }
    // Later waits of this same commit see this edge, so two of them cannot close a circle together.
    const edge: SessionWaiter = {
      paneKey: chain.sourcePaneKey,
      worktreeId: chain.sourceWorktreeId ?? chain.worktreeId,
      rowKey: '',
      chainId: chain.id,
      outcomeId: wait.outcomeId,
      conditionId: wait.conditionId,
      label: ''
    }
    index.set(wait.ref, [...(index.get(wait.ref) ?? []), edge])
  }
}
