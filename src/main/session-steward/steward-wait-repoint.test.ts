import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeCondition } from '../../shared/session-outcome-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { runtimeSessionWaitRepointer } from './steward-wait-repoint'

function wait(id: string, ref: string): SessionOutcomeCondition {
  return {
    id,
    kind: 'event',
    label: 'Billing session finishes',
    target: ref,
    event: { source: 'session', match: 'result', ref }
  } as SessionOutcomeCondition
}

/** `waiter-pane` waits on each ref; `picked` refs already hold their receipt. */
function waiterChain(refs: string[], picked: string[] = []): SessionChain {
  const conditions = refs.map((ref, index) => wait(`wait_${index}`, ref))
  return {
    id: 'chain-1',
    sourcePaneKey: 'waiter-pane',
    worktreeId: 'wt',
    hostId: 'local',
    state: 'waiting',
    updatedAt: 1,
    steps: [],
    outcomeSet: {
      revision: 4,
      attempts: [],
      continuation: { state: 'owned' },
      outcomes: [
        {
          id: 'after-billing',
          title: 'Continue after billing',
          finish: 'complete',
          revision: 1,
          status: 'pending',
          conditions,
          evidence: conditions
            .filter((condition) => picked.includes(condition.event!.ref!))
            .map((condition) => ({ conditionId: condition.id, outcomeRevision: 1 })),
          dependsOn: [],
          actions: []
        }
      ]
    }
  } as unknown as SessionChain
}

function runtime(chains: SessionChain[]) {
  const commits: { chain: SessionChain; input: Record<string, unknown> }[] = []
  const fake = {
    listSessionChains: () => chains,
    getSessionOutcomeService: () => ({
      commit: async (chain: SessionChain, input: Record<string, unknown>) => {
        commits.push({ chain, input })
        return chain
      }
    })
  } as unknown as Pick<OrcaRuntimeService, 'listSessionChains' | 'getSessionOutcomeService'>
  return { fake, commits }
}

describe('re-pointing waits on a merged session', () => {
  it('recommits the waiter’s plan to wait on the target, revision-bound', async () => {
    const { fake, commits } = runtime([waiterChain(['source-pane', 'other-pane'])])
    expect(
      await runtimeSessionWaitRepointer(fake)({ from: 'source-pane', to: 'target-pane' })
    ).toBe(1)
    expect(commits).toHaveLength(1)
    const { input } = commits[0]!
    expect(input).toMatchObject({ source: 'user', expectedRevision: 4 })
    const [outcome] = input.outcomes as { conditions: SessionOutcomeCondition[] }[]
    expect(outcome!.conditions.map((condition) => condition.event?.ref)).toEqual([
      'target-pane',
      'other-pane'
    ])
    expect(outcome!.conditions[0]).toMatchObject({ target: 'target-pane' })
  })

  it('leaves a wait that already holds the source’s result, and plans with no wait on it', async () => {
    const { fake, commits } = runtime([waiterChain(['source-pane'], ['source-pane'])])
    expect(
      await runtimeSessionWaitRepointer(fake)({ from: 'source-pane', to: 'target-pane' })
    ).toBe(0)
    const unrelated = runtime([waiterChain(['other-pane'])])
    expect(
      await runtimeSessionWaitRepointer(unrelated.fake)({ from: 'source-pane', to: 'target-pane' })
    ).toBe(0)
    expect([...commits, ...unrelated.commits]).toEqual([])
  })
})
