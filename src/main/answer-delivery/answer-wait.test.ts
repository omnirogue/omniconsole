import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { ReviewSleepEntry } from '../artifacts/artifact-review-sleep-targets'

const reads = vi.hoisted(() => ({
  reviews: [] as unknown[],
  questions: null as unknown[] | null,
  fail: false
}))

vi.mock('../artifacts/artifact-review-sleep-targets', () => ({
  listReviewSleepEntries: () => {
    if (reads.fail) {
      throw new Error('share records unreadable')
    }
    return reads.reviews
  }
}))
vi.mock('../session-questions/session-decision-wiring', () => ({
  getSessionDecisionStore: () => (reads.questions ? { list: () => reads.questions } : null)
}))
vi.mock('../omni-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/profile'
}))

import {
  answerWaitDeleteRefusal,
  answerWaitReason,
  isOpenReviewWait,
  openAnswerWaits,
  readAnswerWaits
} from './answer-wait'

function review(
  slug: string,
  state: ArtifactReviewSleep['state'],
  extra: Partial<ReviewSleepEntry> = {}
): ReviewSleepEntry {
  return {
    sourceKey: `/w/${slug}.md`,
    slug,
    title: `${slug}.md`,
    sourceReview: {
      ledgerId: 'als_0123456789abcdef01234567',
      nativeSessionId: 'conv-1',
      paneKey: 'tab-1:1',
      worktreeId: 'wt',
      account: 'a',
      revision: 2
    },
    sleep: { state, revision: 2, armedAt: 1, at: 1, provider: 'claude' },
    ...extra
  }
}

const question = (key: string, paneKey: string, id?: string) => ({
  key,
  paneKey,
  providerSession: id ? { key: 'claude' as never, id } : null
})

describe('isOpenReviewWait', () => {
  it('holds while the wait is waiting, asleep, waking or stalled', () => {
    for (const state of ['waiting', 'asleep', 'waking', 'stalled'] as const) {
      expect(isOpenReviewWait(review('a', state))).toBe(true)
    }
    for (const state of ['awake', 'moved', 'deleted'] as const) {
      expect(isOpenReviewWait(review('a', state))).toBe(false)
    }
  })

  it('lets go once a current reading says the page no longer needs the person', () => {
    const decided = { revision: 2, needsYou: false, status: 'approved', observedAt: 5 }
    expect(isOpenReviewWait(review('a', 'asleep', { reviewAttention: decided }))).toBe(false)
    // An older revision's reading says nothing about the wait for this one.
    const stale = { ...decided, revision: 1 }
    expect(isOpenReviewWait(review('a', 'asleep', { reviewAttention: stale }))).toBe(true)
    const pending = { ...decided, needsYou: true, status: 'pending' }
    expect(isOpenReviewWait(review('a', 'waiting', { reviewAttention: pending }))).toBe(true)
  })
})

describe('openAnswerWaits', () => {
  it('matches a review by its pane, or by the provider conversation after the pane changed', () => {
    const reviews = [review('plan', 'asleep')]
    expect(openAnswerWaits({ paneKey: 'tab-1:1', worktreeId: 'wt' }, reviews, [])).toEqual([
      { kind: 'review', slug: 'plan', title: 'plan.md' }
    ])
    expect(
      openAnswerWaits({ paneKey: 'tab-9:1', providerSessionId: 'conv-1' }, reviews, [])
    ).toHaveLength(1)
    expect(openAnswerWaits({ paneKey: 'tab-1:1', worktreeId: 'other' }, reviews, [])).toEqual([])
    expect(
      openAnswerWaits({ paneKey: 'tab-2:1', providerSessionId: 'conv-2' }, reviews, [])
    ).toEqual([])
  })

  it('matches an open Question by pane or conversation, ended or not', () => {
    const questions = [question('q1', 'tab-3:1'), question('q2', 'gone:1', 'conv-7')]
    expect(openAnswerWaits({ paneKey: 'tab-3:1' }, [], questions)).toEqual([
      { kind: 'question', key: 'q1' }
    ])
    expect(
      openAnswerWaits({ paneKey: 'tab-4:1', providerSessionId: 'conv-7' }, [], questions)
    ).toEqual([{ kind: 'question', key: 'q2' }])
    expect(openAnswerWaits({ paneKey: null, providerSessionId: null }, [], questions)).toEqual([])
  })
})

describe('answer wait words', () => {
  it('names the page first, else the Question', () => {
    const waits = [
      { kind: 'question' as const, key: 'q1' },
      { kind: 'review' as const, slug: 'plan', title: 'plan.md' }
    ]
    expect(answerWaitReason(waits)).toBe('Kept: waiting on your decision (plan.md).')
    expect(answerWaitReason([waits[0]!])).toBe('Kept: waiting on your answer to a Question.')
    expect(answerWaitReason([])).toBeNull()
    expect(answerWaitDeleteRefusal(waits)).toBe(
      'Kept: a decision is still waiting on this session (plan.md); only the person can delete it. Nothing changed.'
    )
    expect(answerWaitDeleteRefusal([waits[0]!])).toContain('your answer to a Question')
    expect(answerWaitDeleteRefusal([])).toBeNull()
  })
})

describe('readAnswerWaits', () => {
  beforeEach(() => {
    reads.reviews = []
    reads.questions = null
    reads.fail = false
  })

  it('reads once and drops waits already decided', () => {
    reads.reviews = [review('open', 'waiting'), review('done', 'awake')]
    reads.questions = [question('q1', 'tab-1:1')]
    expect(readAnswerWaits('https://omni.example')({ paneKey: 'tab-1:1' })).toEqual([
      { kind: 'review', slug: 'open', title: 'open.md' },
      { kind: 'question', key: 'q1' }
    ])
  })

  it('throws when the share records cannot be read, so callers keep the session', () => {
    reads.fail = true
    expect(() => readAnswerWaits(null)).toThrow('share records unreadable')
  })
})
