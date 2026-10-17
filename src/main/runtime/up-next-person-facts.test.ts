/**
 * Which ASK a reply answers.
 *
 * One person has one `review` condition on the Outcome however many times they are asked, so the
 * receipt that answered the first request looks exactly like an answer to the second. The reading
 * that decides whether held work may run has to tell them apart, or a deliberate second review of
 * the same reviewer opens its own gate the moment the request goes out.
 */

import { describe, expect, it } from 'vitest'
import type { SessionChain } from '../../shared/session-chain-types'
import type { SessionOutcomeEvidence } from '../../shared/session-outcome-types'
import {
  upNextReviewAnswers,
  upNextReviewOpen,
  upNextReviewReplaced,
  upNextReviewReplies,
  upNextReviewSettled
} from './up-next-person-facts'
import { projectUpNext } from './up-next-projection'

/** One ask to emp_1, delivered at `savedAt`. */
function ask(id: string, savedAt: number) {
  return {
    id,
    kind: 'handoff' as const,
    status: 'delivered' as const,
    handoff: {
      savedAt,
      includeSummary: true,
      deliverables: { kind: 'files' as const, paths: ['src/a.ts'] },
      disposition: 'feedback' as const,
      action: 'review' as const,
      recipients: [
        {
          employeeId: 'emp_1',
          name: 'Jordan Taylor',
          operationId: `op_${id}`,
          delivery: 'sent' as const,
          at: savedAt
        }
      ]
    }
  }
}

/** emp_1's reply, as the verification loop records it. */
function reply(verifiedAt: number): SessionOutcomeEvidence {
  return {
    id: `ev_${verifiedAt}`,
    outcomeId: 'o1',
    conditionId: 'o1_feedback',
    outcomeRevision: 1,
    conditionKey: 'k',
    kind: 'review',
    target: 'emp_1',
    receipt: 'user-review:emp_1',
    verifiedAt,
    verifier: 'execution-host'
  }
}

function chainOf(evidence: SessionOutcomeEvidence[]): SessionChain {
  return {
    id: 'source_1',
    workspacePath: '/w',
    worktreeId: 'wt',
    hostId: 'local',
    sourcePaneKey: 'tab-1:leaf-1',
    sourceRowKey: JSON.stringify(['local', 'wt', 'tab-1:leaf-1']),
    auto: true,
    steps: [ask('h1', 10), ask('h2', 100)],
    currentIndex: 0,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1,
    outcomeSet: {
      schemaVersion: 1,
      revision: 2,
      outcomes: [
        {
          id: 'o1',
          title: 'Ship it',
          finish: 'human-handoff',
          dependsOn: [],
          stepIds: ['h1', 'h2'],
          actions: [],
          conditions: [
            { id: 'o1_handoff', kind: 'handoff', target: 'emp_1', recipientId: 'emp_1' },
            { id: 'o1_feedback', kind: 'review', target: 'emp_1', recipientId: 'emp_1' }
          ],
          revision: 1,
          status: 'pending',
          evidence
        }
      ],
      removals: [],
      attempts: [],
      completedSteps: [],
      continuation: {
        owner: 'execution-host',
        hostId: 'local',
        epoch: 'epoch-1',
        state: 'owned',
        sourceReady: true
      },
      updatedAt: 20
    }
  } as unknown as SessionChain
}

describe('a reply belongs to the ask it came back to', () => {
  it('answers the first ask and leaves a second one still out', () => {
    const chain = chainOf([reply(50)])

    expect(upNextReviewReplies(chain, 'h1', 200)).toMatchObject({ replied: 1, total: 1 })
    expect(upNextReviewSettled(chain, 'h1')).toBe(true)
    // The same person, asked again: their earlier answer is not an answer to THIS request, so
    // the work held behind it keeps waiting.
    expect(upNextReviewReplies(chain, 'h2', 200)).toMatchObject({ replied: 0, total: 1 })
    expect(upNextReviewSettled(chain, 'h2')).toBe(false)
  })

  it('opens the second gate once they answer it', () => {
    const chain = chainOf([reply(50), reply(150)])

    expect(upNextReviewSettled(chain, 'h2')).toBe(true)
    expect(upNextReviewReplies(chain, 'h2', 200)).toMatchObject({ replied: 1, total: 1 })
  })
})

describe('a first ask the second one replaced', () => {
  /** The Up next panel's person blocks, as `[step, state]`. */
  const panel = (chain: SessionChain) =>
    projectUpNext({
      conversationId: { kind: 'pty', worktreeId: 'wt', paneKey: 'tab-1:leaf-1' },
      rowKey: chain.sourceRowKey!,
      chain,
      queue: null,
      busy: false,
      drafts: [],
      now: 200
    }).blocks.flatMap((block) => (block.kind === 'person' ? [[block.stepId, block.state]] : []))

  it('reads as done once their answer to it is history, never "0 of 1 replied" again', () => {
    // Their answer to h1 moved to history when h2 asked them again: nothing answers h1 now.
    const chain = chainOf([])
    expect(upNextReviewReplaced(chain, 'h1')).toBe(true)
    expect(upNextReviewSettled(chain, 'h1')).toBe(true)
    expect(upNextReviewOpen(chain, 'h1')).toBe(false)
    expect(upNextReviewReplaced(chain, 'h2')).toBe(false)
    expect(upNextReviewOpen(chain, 'h2')).toBe(true)
    expect(panel(chain)).toEqual([
      ['h1', 'done'],
      ['h2', 'waiting']
    ])
  })

  it('never takes the second ask’s answer as its own', () => {
    const changes = { ...reply(150), receipt: 'handoff-review:hth_2:hrv_2:request_changes' }
    const chain = chainOf([changes])
    expect(upNextReviewAnswers(chain, 'h1')).toEqual([])
    expect(upNextReviewReplies(chain, 'h1', 200)).toMatchObject({ replied: 0, answers: [] })
    expect(upNextReviewAnswers(chain, 'h2')).toMatchObject([
      { employeeId: 'emp_1', decision: 'request_changes' }
    ])
    expect(upNextReviewSettled(chain, 'h1')).toBe(true)
    expect(upNextReviewSettled(chain, 'h2')).toBe(false)
    expect(panel(chain)).toEqual([
      ['h1', 'done'],
      ['h2', 'waiting']
    ])
  })
})
