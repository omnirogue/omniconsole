/**
 * A decision's receipt read `queued` for ever after its prompt-queue entry settled. It now follows
 * the entry to its end: `delivered`, or `failed` keeping whether the entry proved it unsent. Only a
 * `queued` receipt moves, so a second pass writes nothing.
 */
import { describe, expect, it } from 'vitest'
import type { PromptQueueEntry, PromptQueues } from '../../shared/prompt-queue-types'
import { validArtifactSourceReview, type ArtifactSourceReview } from './artifact-source-review'
import {
  findPromptQueueEntry,
  reconcileSourceReviewReceipts,
  settledSourceReviewReceipt
} from './artifact-source-review-receipt'
import type { SourceReviewEntry } from './artifact-source-review-watch'

type Receipt = NonNullable<ArtifactSourceReview['receipt']>

const RECEIPT: Receipt = {
  decisionId: 'dec-1',
  entryId: 'artifact-review:dec-1',
  attempt: 1,
  status: 'queued'
}

function queued(state: PromptQueueEntry['state'], extra: Partial<PromptQueueEntry> = {}) {
  return { id: RECEIPT.entryId, text: 'Approved.', createdAt: 1, state, ...extra }
}

function review(receipt: Receipt): ArtifactSourceReview {
  return {
    ledgerId: `als_${'a'.repeat(24)}`,
    nativeSessionId: 'session-1',
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt',
    account: 'acct',
    revision: 1,
    receipt
  }
}

describe('settledSourceReviewReceipt', () => {
  it('moves queued to delivered when the entry was delivered', () => {
    expect(settledSourceReviewReceipt(RECEIPT, queued('delivered'))).toEqual({
      ...RECEIPT,
      status: 'delivered'
    })
  })

  it('moves queued to failed and keeps that it was unsent', () => {
    const next = settledSourceReviewReceipt(
      RECEIPT,
      queued('failed', { unsent: true, reason: 'Its session pane was closed.' })
    )
    expect(next).toEqual({
      ...RECEIPT,
      status: 'failed',
      unsent: true,
      reason: 'Its session pane was closed.'
    })
    expect(validArtifactSourceReview(review(next!))).toBe(true)
  })

  it('moves queued to failed without unsent when bytes may have moved', () => {
    const next = settledSourceReviewReceipt(RECEIPT, queued('failed', { reason: 'x'.repeat(900) }))
    expect(next?.status).toBe('failed')
    expect(next?.unsent).toBeUndefined()
    expect(next?.reason).toHaveLength(500)
    expect(validArtifactSourceReview(review(next!))).toBe(true)
  })

  it('leaves the receipt while the entry waits, sends or cannot be found', () => {
    expect(settledSourceReviewReceipt(RECEIPT, queued('queued'))).toBeNull()
    expect(settledSourceReviewReceipt(RECEIPT, queued('sending'))).toBeNull()
    expect(settledSourceReviewReceipt(RECEIPT, undefined)).toBeNull()
  })

  it('leaves receipts that are not queued, and Codex-queue receipts', () => {
    for (const status of ['prepared', 'sending', 'uncertain', 'delivered', 'failed'] as const) {
      expect(settledSourceReviewReceipt({ ...RECEIPT, status }, queued('delivered'))).toBeNull()
    }
    const codex: Receipt = { ...RECEIPT, transport: 'codex-queue' }
    expect(settledSourceReviewReceipt(codex, queued('delivered'))).toBeNull()
  })
})

describe('the review record validator', () => {
  it('accepts the settled statuses and refuses unsent on anything but failed', () => {
    expect(validArtifactSourceReview(review({ ...RECEIPT, status: 'delivered' }))).toBe(true)
    expect(validArtifactSourceReview(review({ ...RECEIPT, unsent: true }))).toBe(false)
  })
})

describe('reconcileSourceReviewReceipts', () => {
  it('saves each settled receipt once; a second pass writes nothing', () => {
    const entries: SourceReviewEntry[] = [
      { sourceKey: 'k1', slug: 's1', sourceReview: review(RECEIPT) },
      { sourceKey: 'k2', slug: 's2', sourceReview: review({ ...RECEIPT, entryId: 'other' }) }
    ]
    const saved: Receipt[] = []
    const deps = {
      entries: () => entries,
      find: (entryId: string) =>
        entryId === RECEIPT.entryId ? queued('failed', { unsent: true }) : undefined,
      save: (entry: SourceReviewEntry, receipt: Receipt) => {
        saved.push(receipt)
        entry.sourceReview = { ...entry.sourceReview, receipt }
        return true
      }
    }

    expect(reconcileSourceReviewReceipts(deps)).toBe(1)
    expect(saved).toEqual([{ ...RECEIPT, status: 'failed', unsent: true }])
    expect(entries[1]!.sourceReview.receipt?.status).toBe('queued')

    expect(reconcileSourceReviewReceipts(deps)).toBe(0)
    expect(saved).toHaveLength(1)
  })

  it('does not count a save that lost its race', () => {
    const entries = [{ sourceKey: 'k1', slug: 's1', sourceReview: review(RECEIPT) }]
    const moved = reconcileSourceReviewReceipts({
      entries: () => entries,
      find: () => queued('delivered'),
      save: () => false
    })
    expect(moved).toBe(0)
  })
})

describe('findPromptQueueEntry', () => {
  it('finds the entry in whichever queue holds it', () => {
    const source = { worktreeId: 'wt', paneKey: 'tab-1:leaf-1', kind: 'pty' as const }
    const queues: PromptQueues = {
      a: { source, entries: [{ ...queued('queued'), id: 'other' }] },
      b: { source, entries: [queued('delivered')] }
    }
    expect(findPromptQueueEntry(queues, RECEIPT.entryId)?.state).toBe('delivered')
    expect(findPromptQueueEntry(queues, 'missing')).toBeUndefined()
  })
})
