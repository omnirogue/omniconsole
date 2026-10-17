import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionChain } from '../../../shared/session-chain-types'
import { evaluateSessionReviewBoundary } from './session-chain-review-runtime'

const output = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('@/lib/session-work-output', () => ({ readSessionWorkOutput: output.read }))

function chain(): SessionChain {
  return {
    id: 'chn_1',
    workspacePath: '/work',
    worktreeId: 'folder:f1',
    hostId: null,
    sourcePaneKey: 'tab:source',
    sourceRowKey: 'row_1',
    auto: true,
    steps: [
      {
        id: 'review_a',
        agent: 'codex',
        prompt: 'Review',
        presetId: 'review',
        group: 'review_group_round_1',
        review: {
          groupId: 'review_group',
          reviewerId: 'a',
          round: 1,
          maxRounds: 2,
          candidateVersion: 'candidate:v1'
        },
        status: 'launched',
        launchedPaneKey: 'tab:a'
      },
      {
        id: 'review_b',
        agent: 'claude',
        prompt: 'Review',
        presetId: 'review',
        group: 'review_group_round_1',
        review: {
          groupId: 'review_group',
          reviewerId: 'b',
          round: 1,
          maxRounds: 2,
          candidateVersion: 'candidate:v1'
        },
        status: 'launched',
        launchedPaneKey: 'tab:b'
      },
      {
        id: 'repair_1',
        agent: 'claude',
        prompt: 'Repair findings',
        reviewRepair: {
          groupId: 'review_group',
          afterRound: 1,
          candidateVersion: 'candidate:v1',
          consumptionKey: 'repair_1_candidate_v1'
        },
        status: 'queued'
      },
      {
        id: 'review_a_2',
        agent: 'codex',
        prompt: 'Review',
        group: 'review_group_round_2',
        review: {
          groupId: 'review_group',
          reviewerId: 'a',
          round: 2,
          maxRounds: 2,
          candidateVersion: 'candidate:v2'
        },
        status: 'queued'
      },
      { id: 'after', agent: 'claude', prompt: 'Package', status: 'queued' }
    ],
    currentIndex: 2,
    state: 'waiting',
    createdAt: 1,
    updatedAt: 1
  }
}

describe('review runtime boundary', () => {
  beforeEach(() => output.read.mockReset())

  it('stops early and skips repair plus later rounds after every reviewer passes', async () => {
    output.read.mockResolvedValue('OMNI_REVIEW_RESULT:{"status":"pass","blockingFindings":[]}')
    await expect(
      evaluateSessionReviewBoundary({
        chain: chain(),
        paneKeys: ['tab:a', 'tab:b'],
        stops: [
          { handle: 'pty_a', exited: false },
          { handle: 'pty_b', exited: false }
        ],
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({ kind: 'skip', currentIndex: 4 })
  })

  it('runs the selected repair exactly at the findings boundary', async () => {
    output.read
      .mockResolvedValueOnce('OMNI_REVIEW_RESULT:{"status":"pass","blockingFindings":[]}')
      .mockResolvedValueOnce(
        'OMNI_REVIEW_RESULT:{"status":"findings","blockingFindings":["broken"]}'
      )
    await expect(
      evaluateSessionReviewBoundary({
        chain: chain(),
        paneKeys: ['tab:a', 'tab:b'],
        stops: [
          { handle: 'pty_a', exited: false },
          { handle: 'pty_b', exited: false }
        ],
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({
      kind: 'continue',
      reviewLoop: { groups: [{ status: 'repairing' }] }
    })
  })

  it('never treats a crashed or malformed reviewer result as pass', async () => {
    output.read
      .mockResolvedValueOnce('OMNI_REVIEW_RESULT:{"status":"pass","blockingFindings":[]}')
      .mockResolvedValueOnce('reviewer exited without a verdict')
    await expect(
      evaluateSessionReviewBoundary({
        chain: chain(),
        paneKeys: ['tab:a', 'tab:b'],
        stops: [
          { handle: 'pty_a', exited: false },
          { handle: 'pty_b', exited: true }
        ],
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'A selected reviewer did not return a valid verdict.',
      reviewLoop: { groups: [{ status: 'blocked' }] }
    })
  })

  it('reads a verifier that could not judge through the shared transition, never as findings', async () => {
    output.read
      .mockResolvedValueOnce('OMNI_REVIEW_RESULT:{"status":"pass","blockingFindings":[]}')
      .mockResolvedValueOnce(
        'OMNI_REVIEW_RESULT:{"status":"insufficient_evidence","blockingFindings":[],"notes":"no run log"}'
      )
    const boundary = await evaluateSessionReviewBoundary({
      chain: chain(),
      paneKeys: ['tab:a', 'tab:b'],
      stops: [
        { handle: 'pty_a', exited: false },
        { handle: 'pty_b', exited: false }
      ],
      signal: new AbortController().signal,
      now: 42
    })
    expect(boundary).toMatchObject({
      kind: 'blocked',
      reason: 'A selected verifier could not judge; supply the evidence it named and verify again.'
    })
    // The injected clock stamps the receipts, so the judged round is reproducible.
    expect(
      boundary.kind === 'blocked' &&
        boundary.reviewLoop.groups[0]!.rounds[0]!.receipts.map((entry) => entry.recordedAt)
    ).toEqual([42, 42])
  })

  it('keeps the legacy sentence for findings the last authorized round did not resolve', async () => {
    output.read.mockResolvedValue(
      'OMNI_REVIEW_RESULT:{"status":"findings","blockingFindings":["broken"]}'
    )
    const capped = chain()
    await expect(
      evaluateSessionReviewBoundary({
        chain: {
          ...capped,
          steps: capped.steps.map((step) =>
            'review' in step && step.review
              ? { ...step, review: { ...step.review, maxRounds: 1 } }
              : step
          )
        },
        paneKeys: ['tab:a', 'tab:b'],
        stops: [
          { handle: 'pty_a', exited: false },
          { handle: 'pty_b', exited: false }
        ],
        signal: new AbortController().signal
      })
    ).resolves.toMatchObject({
      kind: 'blocked',
      reason: 'Review findings remain unresolved at the configured round limit.'
    })
  })
})
