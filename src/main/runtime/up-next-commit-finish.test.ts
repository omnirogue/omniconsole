/**
 * What a person's Done really commits on a pursuit.
 *
 * Live, twice: Done → Close was committed on a conversation whose stages were all finished, the
 * finish was recorded (`sessionFinish {action:'end'}`) — and the tab stayed open, because the
 * Outcome still carried the review the COMPOSER had authored for the person ("I have reviewed the
 * result", `up-next-plan-edit.ts:170-176`). The on-disk proof is in Sal's own profile: chains
 * `source_b3cefdb0…` (round-2 run) and `source_4caddd31…` (round-3 run), both with the finish
 * recorded, `my-review` open and no session receipt.
 *
 * Done IS that answer. Nothing else on the Outcome moves: another person's review, and every
 * mechanical criterion, still has to be earned.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../persistence/loading-store/write-scheduling', () => ({ scheduleSave: vi.fn() }))
vi.mock('./conversation-readiness', () => ({
  observeConversationReadiness: async () => ({ ready: true, free: true, unverifiable: false })
}))
vi.mock('./conversation-delivery', () => ({
  deliverToConversation: async () => ({ door: 'pty', deliveredAt: 99 })
}))

import type { SessionChain } from '../../shared/session-chain-types'
import type {
  SessionOutcomeCondition,
  SessionOutcomeDefinition
} from '../../shared/session-outcome-types'
import { UP_NEXT_RPC } from '../../shared/up-next-types'
import { conversationId, harness, rowKey, type UpNextHarness } from './rpc/methods/up-next-harness'

const MY_REVIEW: SessionOutcomeCondition = {
  id: 'my-review',
  kind: 'review',
  label: 'I have reviewed the result',
  target: 'outcome'
}

/** The pursuit the live run had: one finished stage, one criterion — the person's own review. */
function pursuit(conditions: SessionOutcomeCondition[] = [MY_REVIEW]): SessionChain {
  const outcome = {
    id: 'outcome',
    title: 'Here is the current work. Improve it and return the updated result.',
    finish: 'my-review',
    dependsOn: [],
    stepIds: ['work_seat_1'],
    actions: [],
    conditions
  } as unknown as SessionOutcomeDefinition
  return {
    id: 'source_1',
    sourcePaneKey: conversationId.paneKey,
    sourceRowKey: rowKey,
    worktreeId: conversationId.worktreeId,
    workspacePath: '/w',
    hostId: 'local',
    placement: 'local',
    steps: [{ id: 'work_seat_1', agent: 'claude', prompt: 'Improve', status: 'completed' }],
    currentIndex: 1,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 2,
    outcomeSet: {
      schemaVersion: 1,
      revision: 2,
      outcomes: [{ ...outcome, revision: 1, status: 'pending', evidence: [] }],
      removals: [],
      attempts: [],
      completedSteps: ['work_seat_1'],
      evidenceHistory: [],
      continuation: {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'epoch-1',
        state: 'owned',
        sourceReady: true
      },
      updatedAt: 2
    }
  } as unknown as SessionChain
}

const commitDone = async (host: UpNextHarness): Promise<void> => {
  await host.call(UP_NEXT_RPC.append, {
    conversationId,
    draft: { kind: 'done', finish: 'close' }
  })
  await host.call(UP_NEXT_RPC.commit, { conversationId })
}

const committed = (host: UpNextHarness): SessionOutcomeDefinition =>
  host.commits.at(-1)!.outcomes[0]!

describe("Done on a pursuit that is waiting for the person's own review", () => {
  it('records the finish AND answers that review, so the Outcome can be reached', async () => {
    const host = harness({}, { chains: [pursuit()] })

    await commitDone(host)

    expect(host.commits.at(-1)!.sessionFinish).toEqual({ action: 'end' })
    const outcome = committed(host)
    expect(outcome.conditions.map((condition) => condition.id)).toEqual(['session_finish_source'])
    // The plan's finish node was "comes back to me"; the person has answered it.
    expect(outcome.finish).toBe('complete')
  })

  it('leaves the finish bound to this conversation as the criterion that remains', async () => {
    const host = harness({}, { chains: [pursuit()] })

    await commitDone(host)

    expect(committed(host).conditions).toEqual([
      { id: 'session_finish_source', kind: 'session', target: conversationId.paneKey }
    ])
  })
})

describe('what Done never decides for anybody else', () => {
  it("keeps another person's review — their reply is theirs to give", async () => {
    const theirs: SessionOutcomeCondition = {
      id: 'review-emp_1',
      kind: 'review',
      label: 'Sal replied',
      target: 'emp_1',
      recipientId: 'emp_1'
    }
    const host = harness({}, { chains: [pursuit([theirs])] })

    await commitDone(host)

    expect(committed(host).conditions.map((condition) => condition.id)).toEqual([
      'review-emp_1',
      'session_finish_source'
    ])
    // The finish still names the review it is waiting on, so the validator's rule holds.
    expect(committed(host).finish).toBe('my-review')
  })

  it('keeps every mechanical criterion, and the owner review beside them', async () => {
    const verdict: SessionOutcomeCondition = {
      id: 'verified',
      kind: 'report',
      target: 'verify_seat_1'
    }
    const host = harness({}, { chains: [pursuit([MY_REVIEW, verdict])] })

    await commitDone(host)

    // The person answered their own question; a Verify's verdict is not theirs to declare.
    expect(committed(host).conditions.map((condition) => condition.id)).toEqual([
      'verified',
      'session_finish_source'
    ])
  })

  it('keeps a review an action of the outcome is waiting on', async () => {
    const chain = pursuit()
    const outcome = chain.outcomeSet!.outcomes[0]!
    const host = harness(
      {},
      {
        chains: [
          {
            ...chain,
            outcomeSet: {
              ...chain.outcomeSet!,
              outcomes: [
                {
                  ...outcome,
                  actions: [
                    {
                      id: 'ask',
                      instruction: 'Ask the owner to review the result.',
                      authority: 'existing-user-authority',
                      agent: 'claude',
                      conditionIds: ['my-review']
                    }
                  ]
                }
              ]
            }
          } as unknown as SessionChain
        ]
      }
    )

    await commitDone(host)

    expect(committed(host).conditions.map((condition) => condition.id)).toEqual([
      'my-review',
      'session_finish_source'
    ])
  })
})

it('still hands the choice back when there is no pursuit to record it on', async () => {
  const host = harness()

  await host.call(UP_NEXT_RPC.append, { conversationId, draft: { kind: 'done', finish: 'close' } })
  const answered = (await host.call(UP_NEXT_RPC.commit, { conversationId })) as {
    finish?: { action: string }
  }

  expect(answered.finish).toEqual({ action: 'end' })
  expect(host.commits).toEqual([])
})
