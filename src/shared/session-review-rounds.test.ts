import { expect, it } from 'vitest'
import { summarizeSessionReviewRounds } from './session-review-rounds'
import type { SessionChain } from './session-chain-types'

const seat = (id: string, agent: string, model: string, round: number) =>
  ({
    id,
    agent,
    model,
    prompt: 'Review',
    status: 'queued',
    review: { groupId: 'g', reviewerId: agent, round, maxRounds: 2, candidateVersion: 'v' }
  }) as never

it('lists each host round with every reviewer, their verdict and blocking findings', () => {
  const chain = {
    steps: [
      seat('c1', 'claude', 'sonnet', 1),
      seat('g1', 'grok', 'grok-4.6', 1),
      seat('c2', 'claude', 'sonnet', 2),
      seat('g2', 'grok', 'grok-4.6', 2)
    ],
    reviewLoop: {
      groups: [
        {
          id: 'g',
          maxRounds: 2,
          currentRound: 2,
          status: 'reviewing',
          consumedRepairKeys: [],
          rounds: [
            {
              index: 1,
              candidateVersion: 'v',
              receipts: [
                {
                  stepId: 'c1',
                  reviewerId: 'claude',
                  candidateVersion: 'v',
                  recordedAt: 1,
                  status: 'findings',
                  blockingFindings: ['Keyboard input is broken'],
                  notes: 'Fix focus'
                },
                {
                  stepId: 'g1',
                  reviewerId: 'grok',
                  candidateVersion: 'v',
                  recordedAt: 1,
                  status: 'pass',
                  blockingFindings: []
                }
              ]
            }
          ]
        }
      ]
    }
  } as unknown as SessionChain
  expect(summarizeSessionReviewRounds(chain)).toEqual([
    {
      groupId: 'g',
      generationId: 'host',
      superseded: false,
      source: 'host',
      round: 1,
      reviewers: [
        {
          reviewerId: 'claude',
          agent: 'claude',
          model: 'sonnet',
          status: 'findings',
          blockingFindings: ['Keyboard input is broken'],
          notes: 'Fix focus'
        },
        {
          reviewerId: 'grok',
          agent: 'grok',
          model: 'grok-4.6',
          status: 'pass',
          blockingFindings: [],
          notes: null
        }
      ]
    },
    {
      groupId: 'g',
      generationId: 'host',
      superseded: false,
      source: 'host',
      round: 2,
      reviewers: [
        expect.objectContaining({ reviewerId: 'claude', status: 'pending' }),
        expect.objectContaining({ reviewerId: 'grok', status: 'pending' })
      ]
    }
  ])
})

it('shows round one as waiting before any host verdict is recorded', () => {
  const chain = { steps: [seat('c1', 'claude', 'sonnet', 1)] } as unknown as SessionChain
  expect(summarizeSessionReviewRounds(chain)).toEqual([
    expect.objectContaining({
      round: 1,
      reviewers: [expect.objectContaining({ status: 'pending' })]
    })
  ])
})

it('reads hub review verdicts from stage receipts keyed by participant node', () => {
  const node = (key: string, participant: string, provider: string, round: number) => ({
    key,
    action: 'review',
    actor_type: 'ai',
    provider,
    model: `${provider}-model`,
    loop_stage: { stage_key: 'stage', role: 'participant', participant_id: participant, round }
  })
  const chain = {
    steps: [],
    outcomeSet: {
      workflow: {
        operationId: 'op-1',
        preview: {
          graph: {
            nodes: [
              { key: 'stage', action: 'execute', loop_stage: { role: 'producer', round: 0 } },
              node('r1a', 'reviewer_a', 'claude', 1),
              node('r1b', 'reviewer_b', 'grok', 1)
            ]
          }
        },
        receipts: [
          {
            key: 'r1a',
            verdict: { verdict: 'disagree', blockers: ['Missing test'], gaps: [], notes: '' }
          },
          {
            key: 'r1b',
            verdict: { verdict: 'agree', blockers: [], gaps: [], notes: 'Looks right' }
          }
        ]
      }
    }
  } as unknown as SessionChain
  expect(summarizeSessionReviewRounds(chain)).toEqual([
    {
      groupId: 'stage',
      generationId: 'op-1',
      superseded: false,
      source: 'hub',
      round: 1,
      reviewers: [
        {
          reviewerId: 'reviewer_a',
          agent: 'claude',
          model: 'claude-model',
          status: 'findings',
          blockingFindings: ['Missing test'],
          notes: null
        },
        {
          reviewerId: 'reviewer_b',
          agent: 'grok',
          model: 'grok-model',
          status: 'pass',
          blockingFindings: [],
          notes: 'Looks right'
        }
      ]
    }
  ])
})

const reviewNode = {
  key: 'r1',
  action: 'review',
  provider: 'claude',
  model: 'sonnet',
  loop_stage: { stage_key: 'stage', role: 'participant', participant_id: 'one', round: 1 }
}

const generation = (operationId: string, receipts: unknown[], nodes: unknown[] = [reviewNode]) => ({
  operationId,
  preview: { graph: { nodes } },
  receipts
})

const verdict = (result: 'agree' | 'disagree', notes: string) => ({
  key: 'r1',
  verdict: {
    verdict: result,
    blockers: result === 'agree' ? [] : ['regression'],
    gaps: [],
    notes
  }
})

it('keeps both verdicts when an amendment reuses the same stage and round', () => {
  const chain = {
    steps: [],
    outcomeSet: {
      workflowHistory: [generation('old-generation', [verdict('agree', 'first pass')])],
      workflow: generation('amended-generation', [verdict('disagree', 'amended')])
    }
  } as unknown as SessionChain
  const rounds = summarizeSessionReviewRounds(chain)
  expect(rounds.map((round) => [round.generationId, round.superseded])).toEqual([
    ['old-generation', true],
    ['amended-generation', false]
  ])
  expect(rounds.flatMap((round) => round.reviewers.map((entry) => entry.status))).toEqual([
    'pass',
    'findings'
  ])
  expect(rounds.flatMap((round) => round.reviewers.map((entry) => entry.notes))).toEqual([
    'first pass',
    'amended'
  ])
})

it('keeps an earlier generation verdict when the amended plan has none yet', () => {
  const chain = {
    steps: [],
    outcomeSet: {
      workflowHistory: [generation('old-generation', [verdict('agree', 'ok')])],
      workflow: generation('amended-generation', [], [{ key: 'plain', action: 'execute' }])
    }
  } as unknown as SessionChain
  expect(summarizeSessionReviewRounds(chain)).toEqual([
    expect.objectContaining({
      source: 'hub',
      generationId: 'old-generation',
      reviewers: [expect.objectContaining({ reviewerId: 'one', status: 'pass' })]
    })
  ])
  // A later generation re-listing the reviewer without a verdict does not erase the earlier one.
  chain.outcomeSet!.workflow = generation('amended-generation', []) as never
  const rounds = summarizeSessionReviewRounds(chain)
  expect(rounds.map((round) => round.reviewers[0]!.status)).toEqual(['pass', 'pending'])
})

const lifecycleSeat = (id: string) =>
  ({
    id,
    agent: 'codex',
    model: id,
    prompt: 'Review',
    status: 'queued',
    review: { groupId: 'g', reviewerId: id, round: 1, maxRounds: 1, candidateVersion: 'v' }
  }) as never

it('separates a running attempt, a pre-launch refusal and a worker failure', () => {
  const attempt = (actionKey: string, state: string, extra: Record<string, unknown> = {}) => ({
    id: actionKey,
    outcomeId: 'o',
    actionId: `step_${actionKey}`,
    actionKey,
    outcomeRevision: 1,
    state,
    startedAt: 1,
    updatedAt: 1,
    ...extra
  })
  const chain = {
    steps: [lifecycleSeat('running'), lifecycleSeat('blocked'), lifecycleSeat('failed')],
    outcomeSet: {
      attempts: [
        attempt('running', 'running'),
        attempt('blocked', 'blocked', { launchDisposition: 'not-started', error: 'No seat' }),
        attempt('failed', 'blocked', { error: 'Worker crashed' })
      ]
    }
  } as unknown as SessionChain
  const reviewers = summarizeSessionReviewRounds(chain)[0]!.reviewers
  expect(reviewers.map((entry) => entry.status)).toEqual(['running', 'blocked', 'failed'])
  expect(reviewers.map((entry) => entry.notes)).toEqual([null, 'No seat', 'Worker crashed'])
})

it('distinguishes an unverifiable attempt from a seat that never attempted', () => {
  const chain = {
    steps: [lifecycleSeat('a'), lifecycleSeat('b')],
    outcomeSet: {
      attempts: [
        {
          id: 'a',
          actionId: 'step_a',
          state: 'unverifiable',
          error: 'Lost contact with the review host'
        }
      ]
    }
  } as unknown as SessionChain
  expect(summarizeSessionReviewRounds(chain)[0]!.reviewers).toEqual([
    expect.objectContaining({ status: 'unverifiable', notes: 'Lost contact with the review host' }),
    expect.objectContaining({ status: 'pending', notes: null })
  ])
})

it('reports a reviewer whose receipt says it crashed as unable to review', () => {
  const chain = {
    steps: [lifecycleSeat('c1')],
    reviewLoop: {
      groups: [
        {
          id: 'g',
          maxRounds: 1,
          currentRound: 1,
          status: 'reviewing',
          consumedRepairKeys: [],
          rounds: [
            {
              index: 1,
              candidateVersion: 'v',
              receipts: [
                {
                  stepId: 'c1',
                  reviewerId: 'c1',
                  candidateVersion: 'v',
                  recordedAt: 1,
                  status: 'crashed',
                  blockingFindings: [],
                  notes: 'Agent exited'
                }
              ]
            }
          ]
        }
      ]
    }
  } as unknown as SessionChain
  expect(summarizeSessionReviewRounds(chain)[0]!.reviewers[0]).toMatchObject({
    status: 'failed',
    notes: 'Agent exited'
  })
})

it('has nothing to show without a chain or review seats', () => {
  expect(summarizeSessionReviewRounds(null)).toEqual([])
  expect(summarizeSessionReviewRounds({ steps: [] } as unknown as SessionChain)).toEqual([])
})
