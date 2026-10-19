import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import { REVIEW_WAKE_SETTLE_MS } from '../artifacts/artifact-review-wake'
import type { SourceReviewEntry } from '../artifacts/artifact-source-review-watch'
import type { PromptQueueEntry, PromptQueues } from '../../shared/prompt-queue-types'
import type { QueueEntryState } from '../work-delivery/work-delivery-claimer-types'
import {
  answerWakeReason,
  reviewPassOutcome,
  reviewPassSent,
  reviewWakeGate,
  runtimeReviewPassQueue,
  type ReviewGateDeps
} from './review-delivery-gate'

const KEY = 'review:plan:d7'
const NOW = 10_000_000

const ENTRY: SourceReviewEntry = {
  sourceKey: '/work/plan.md',
  slug: 'plan',
  sourceReview: {
    ledgerId: 'als_0123456789abcdef01234567',
    nativeSessionId: 'conv-1',
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'repo::/w',
    account: 'account',
    revision: 2
  }
}

function sleep(
  state: ArtifactReviewSleep['state'],
  extra: Partial<ArtifactReviewSleep> = {}
): ArtifactReviewSleep {
  return { state, revision: 2, armedAt: 1, at: 1, provider: 'claude', ...extra }
}

function deps(overrides: Partial<ReviewGateDeps> = {}) {
  return {
    wakeClaimElsewhere: vi.fn(async () => null),
    withdrawWakeCopy: vi.fn(async () => 'ok' as const),
    saveSleep: vi.fn(() => true),
    now: () => NOW,
    ...overrides
  } as ReviewGateDeps & {
    saveSleep: ReturnType<typeof vi.fn>
    withdrawWakeCopy: ReturnType<typeof vi.fn>
  }
}

describe('reviewPassSent', () => {
  const sent = (status: 'prepared' | 'queued' | 'uncertain'): SourceReviewEntry => ({
    ...ENTRY,
    sourceReview: {
      ...ENTRY.sourceReview,
      receipt: { decisionId: '7', entryId: 'e', attempt: 1, status }
    }
  })

  it('is true only for this decision, once the pass got past preparing it', () => {
    expect(reviewPassSent(sent('queued'), 7)).toBe(true)
    expect(reviewPassSent(sent('uncertain'), '7')).toBe(true)
    expect(reviewPassSent(sent('prepared'), 7)).toBe(false)
    expect(reviewPassSent(sent('queued'), 8)).toBe(false)
    expect(reviewPassSent(sent('queued'), undefined)).toBe(false)
    expect(reviewPassSent(ENTRY, 7)).toBe(false)
  })
})

describe('reviewPassOutcome', () => {
  const PASSED: SourceReviewEntry = {
    ...ENTRY,
    sourceReview: {
      ...ENTRY.sourceReview,
      receipt: { decisionId: '7', entryId: 'artifact-review:e', attempt: 0, status: 'queued' }
    }
  }
  const queue = (state: QueueEntryState, withdrawn = true) => ({
    state: vi.fn(() => state),
    withdraw: vi.fn(() => withdrawn)
  })
  const live = (value: boolean) => vi.fn(async () => value)

  it('lets the claimer send one the queue proved never left, live or not', async () => {
    for (const here of [true, false]) {
      const q = queue('failed-unsent')
      expect(await reviewPassOutcome(PASSED, 7, q, live(here))).toBe('unsent')
      expect(q.state).toHaveBeenCalledWith('artifact-review:e')
      expect(q.withdraw).not.toHaveBeenCalled()
    }
  })

  it('follows a send still queued in a live pane, never sending it again', async () => {
    const q = queue('queued')
    expect(await reviewPassOutcome(PASSED, 7, q, live(true))).toBe('follow')
    expect(q.withdraw).not.toHaveBeenCalled()
  })

  it('withdraws a send queued where no pane runs it, or waits when it is moving', async () => {
    const q = queue('queued')
    expect(await reviewPassOutcome(PASSED, 7, q, live(false))).toBe('unsent')
    expect(q.withdraw).toHaveBeenCalledWith('artifact-review:e')
    expect(await reviewPassOutcome(PASSED, 7, queue('queued', false), live(false))).toMatchObject({
      reason: 'busy'
    })
  })

  it('never sends again one that may have reached the agent', async () => {
    for (const state of ['delivered', 'sending', 'failed', 'missing'] as const) {
      expect(await reviewPassOutcome(PASSED, 7, queue(state), live(true))).toBe('follow')
      expect(await reviewPassOutcome(PASSED, 7, queue(state), live(false))).toMatchObject({
        go: false,
        reason: 'unverifiable'
      })
    }
  })

  it('holds an uncertain or native Codex send as today, without reading the prompt queue', async () => {
    const uncertain: SourceReviewEntry = {
      ...PASSED,
      sourceReview: {
        ...PASSED.sourceReview,
        receipt: { ...PASSED.sourceReview.receipt!, status: 'uncertain' }
      }
    }
    expect(await reviewPassOutcome(uncertain, 7, queue('missing'), live(false))).toMatchObject({
      reason: 'unverifiable'
    })
    const native: SourceReviewEntry = {
      ...PASSED,
      sourceReview: {
        ...PASSED.sourceReview,
        receipt: { ...PASSED.sourceReview.receipt!, transport: 'codex-queue' }
      }
    }
    const q = queue('failed-unsent')
    expect(await reviewPassOutcome(native, 7, q, live(false))).toMatchObject({
      reason: 'unverifiable'
    })
    expect(q.state).not.toHaveBeenCalled()
  })

  it('goes the normal way for another decision or one the pass only prepared', async () => {
    const q = queue('delivered')
    expect(await reviewPassOutcome(PASSED, 8, q, live(false))).toBe('unsent')
    expect(await reviewPassOutcome(ENTRY, 7, q, live(false))).toBe('unsent')
  })
})

describe('runtimeReviewPassQueue', () => {
  const source = { kind: 'pty' as const, worktreeId: 'repo::/w', paneKey: 'tab-2:leaf-1' }
  const row = JSON.stringify(['local', source.worktreeId, source.paneKey])
  const entry = (state: PromptQueueEntry['state'], unsent?: true): PromptQueueEntry => ({
    id: 'artifact-review:e',
    text: 'Approved',
    createdAt: 1,
    state,
    ...(unsent ? { unsent } : {})
  })
  const runtime = (e: PromptQueueEntry) => {
    const queues: PromptQueues = { [row]: { source, entries: [e] } }
    return { listPromptQueues: () => queues, settlePromptQueueEntry: vi.fn(() => null) }
  }

  it('reads the entry in whichever pane holds it', () => {
    expect(runtimeReviewPassQueue(runtime(entry('failed', true))).state('artifact-review:e')).toBe(
      'failed-unsent'
    )
    expect(runtimeReviewPassQueue(runtime(entry('failed'))).state('artifact-review:e')).toBe(
      'failed'
    )
    expect(runtimeReviewPassQueue(runtime(entry('queued'))).state('other')).toBe('missing')
  })

  it('withdraws only a still-queued entry, settled unsent', () => {
    const queued = runtime(entry('queued'))
    expect(runtimeReviewPassQueue(queued).withdraw('artifact-review:e')).toBe(true)
    expect(queued.settlePromptQueueEntry).toHaveBeenCalledWith(
      row,
      'artifact-review:e',
      expect.objectContaining({ state: 'failed', unsent: true })
    )
    const sending = runtime(entry('sending'))
    expect(runtimeReviewPassQueue(sending).withdraw('artifact-review:e')).toBe(false)
    expect(sending.settlePromptQueueEntry).not.toHaveBeenCalled()
  })
})

describe('reviewWakeGate', () => {
  it('goes without touching anything when no wait sleeps for this revision', async () => {
    const d = deps()
    expect(await reviewWakeGate(d, ENTRY, undefined, KEY)).toEqual({ go: true })
    expect(await reviewWakeGate(d, ENTRY, sleep('asleep', { revision: 1 }), KEY)).toEqual({
      go: true
    })
    expect(await reviewWakeGate(d, ENTRY, sleep('waiting'), KEY)).toEqual({ go: true })
    expect(d.saveSleep).not.toHaveBeenCalled()
  })

  it('holds a deleted session as protection and a moved one as unverifiable', async () => {
    expect(await reviewWakeGate(deps(), ENTRY, sleep('deleted'), KEY)).toMatchObject({
      go: false,
      reason: 'protection'
    })
    expect(
      await reviewWakeGate(deps(), ENTRY, sleep('moved', { reason: 'Woken on studio.' }), KEY)
    ).toEqual({ go: false, reason: 'unverifiable', message: 'Woken on studio.' })
  })

  it('holds when another computer woke it from its copy', async () => {
    const d = deps({ wakeClaimElsewhere: vi.fn(async () => 'studio took it') })
    expect(await reviewWakeGate(d, ENTRY, sleep('asleep'), KEY)).toEqual({
      go: false,
      reason: 'unverifiable',
      message: 'studio took it'
    })
    expect(d.saveSleep).not.toHaveBeenCalled()
  })

  it('waits for a wake still starting that is not its own', async () => {
    const starting = sleep('waking', { at: NOW - REVIEW_WAKE_SETTLE_MS + 1, reason: 'pass' })
    expect(await reviewWakeGate(deps(), ENTRY, starting, KEY)).toMatchObject({
      go: false,
      reason: 'busy'
    })
    const settled = sleep('waking', { at: NOW - REVIEW_WAKE_SETTLE_MS, reason: 'pass' })
    expect(await reviewWakeGate(deps(), ENTRY, settled, KEY)).toEqual({ go: true })
  })

  it('never retries a stall that started a terminal, and waits out a capacity stall', async () => {
    expect(await reviewWakeGate(deps(), ENTRY, sleep('stalled'), KEY)).toMatchObject({
      go: false,
      reason: 'unverifiable'
    })
    expect(
      await reviewWakeGate(deps(), ENTRY, sleep('stalled', { retryAfter: NOW + 1 }), KEY)
    ).toMatchObject({ go: false, reason: 'busy' })
    expect(await reviewWakeGate(deps(), ENTRY, sleep('stalled', { retryAfter: NOW }), KEY)).toEqual(
      { go: true }
    )
  })

  it('withdraws a wake copy first, and holds when that fails', async () => {
    const copied = sleep('asleep', { wakeCopy: { revision: 2, at: 1, sha256: 'x' } })
    const claimed = deps({ withdrawWakeCopy: vi.fn(async () => 'claimed' as const) })
    expect(await reviewWakeGate(claimed, ENTRY, copied, KEY)).toMatchObject({
      go: false,
      reason: 'unverifiable'
    })
    const failed = deps({ withdrawWakeCopy: vi.fn(async () => 'failed' as const) })
    expect(await reviewWakeGate(failed, ENTRY, copied, KEY)).toMatchObject({
      go: false,
      reason: 'error'
    })
    expect(claimed.saveSleep).not.toHaveBeenCalled()
    expect(failed.saveSleep).not.toHaveBeenCalled()
  })

  it('marks the wait waking as its own, without the copy, so no other computer takes it', async () => {
    const d = deps()
    const copied = sleep('asleep', {
      wakeCopy: { revision: 2, at: 1, sha256: 'x' },
      retryAfter: 5
    })
    expect(await reviewWakeGate(d, ENTRY, copied, KEY)).toEqual({ go: true })
    expect(d.withdrawWakeCopy).toHaveBeenCalledWith(ENTRY)
    expect(d.saveSleep).toHaveBeenCalledWith(ENTRY, {
      state: 'waking',
      revision: 2,
      armedAt: 1,
      at: NOW,
      provider: 'claude',
      reason: answerWakeReason(KEY)
    })
  })

  it('lets a retry of its own wake go on without saving again', async () => {
    const d = deps()
    const ours = sleep('waking', { at: NOW - 1, reason: answerWakeReason(KEY) })
    expect(await reviewWakeGate(d, ENTRY, ours, KEY)).toEqual({ go: true })
    expect(d.saveSleep).not.toHaveBeenCalled()
  })

  it('holds when the share record changed under it', async () => {
    const d = deps({ saveSleep: vi.fn(() => false) })
    expect(await reviewWakeGate(d, ENTRY, sleep('asleep'), KEY)).toMatchObject({
      go: false,
      reason: 'error'
    })
  })
})

describe('reviewRespawnBrief', () => {
  it('includes the continuation capsule when present on the delivery context', async () => {
    const { reviewRespawnBrief } = await import('./review-delivery-adapter')
    const brief = reviewRespawnBrief({
      key: KEY,
      workItem: 'review:plan',
      kind: 'review',
      state: 'claimed',
      step: '',
      heldReason: null,
      attempts: 1,
      text: 'Approved by Sal',
      context: {
        slug: 'plan',
        title: 'Launch Plan',
        shareUrl: 'https://app.omnisi.ai/a/plan',
        continuationCapsule: {
          goal: 'Ship reliable decision routing',
          repo: 'omnirogue/omni-console',
          branch: 'feat/decision-routing',
          commit: 'abc1234',
          touchedFiles: ['bff/omni_bff/work_delivery.py'],
          verificationCommands: ['pytest']
        }
      },
      eventAt: null,
      owner: null
    } as never)
    expect(brief).toContain('Continuation Capsule:')
    expect(brief).toContain('- Goal: Ship reliable decision routing')
    expect(brief).toContain('- Git: omnirogue/omni-console @ feat/decision-routing @ abc1234')
    expect(brief).toContain('- Files: bff/omni_bff/work_delivery.py')
    expect(brief).toContain('- Verify: pytest')

    const omnisiBrief = reviewRespawnBrief({
      key: KEY,
      workItem: 'review:plan',
      kind: 'review',
      state: 'claimed',
      step: '',
      heldReason: null,
      attempts: 1,
      text: 'Approved by Uma',
      context: {
        slug: 'plan',
        title: 'OmniSI Bridged Plan',
        continuationCapsule: {
          objective: 'Deliver OmniSI decision routing',
          repo: 'omnirogue/omnisi',
          branch: 'feat/omnisi-decision-routing',
          head_sha: 'def5678',
          touched_files: ['src/omnidots/decisions/core.py'],
          verification_cmd: 'uv run pytest',
          next_step_on_approve: 'Merge PR'
        }
      },
      eventAt: null,
      owner: null
    } as never)
    expect(omnisiBrief).toContain('- Goal: Deliver OmniSI decision routing')
    expect(omnisiBrief).toContain(
      '- Git: omnirogue/omnisi @ feat/omnisi-decision-routing @ def5678'
    )
    expect(omnisiBrief).toContain('- Files: src/omnidots/decisions/core.py')
    expect(omnisiBrief).toContain('- Verify: uv run pytest')
    expect(omnisiBrief).toContain('- Next steps: Merge PR')
  })
})
