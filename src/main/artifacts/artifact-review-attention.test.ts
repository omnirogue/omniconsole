import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewStatus } from '../../shared/artifact-review'
import type { ReviewSleepEntry } from './artifact-review-sleep-targets'
import {
  readArtifactReviewAttention,
  reconcileReviewAttention,
  validArtifactReviewAttention
} from './artifact-review-attention'

function status(patch: Partial<ArtifactReviewStatus> = {}): ArtifactReviewStatus {
  return {
    artifact: {
      version: 1,
      slug: 'plan',
      title: 'Plan',
      originalFileName: null,
      sourceContentType: 'text/html',
      renderedContentType: 'text/html',
      createdAt: '',
      updatedAt: '',
      expiresAt: '',
      byteSize: 1,
      deletedAt: null,
      revision: 2
    },
    shareUrl: 'https://omnios.example/a/plan',
    status: 'pending',
    latest: null,
    decisions: [],
    viewer: { signedIn: true, isOwner: true, canDecide: true },
    ...patch
  }
}

function entry(): ReviewSleepEntry {
  return {
    sourceKey: '/work/plan.md',
    slug: 'plan',
    sourceReview: {
      ledgerId: 'als_0123456789abcdef01234567',
      nativeSessionId: 'session',
      paneKey: 'tab:leaf',
      worktreeId: 'work',
      account: 'account',
      revision: 2
    },
    sleep: { state: 'stalled', provider: 'claude', revision: 2, armedAt: 1, at: 2 }
  }
}

describe('canonical review attention', () => {
  it.each(['approved', 'changes_requested', 'rejected', 'withdrawn'])(
    'stops attention for %s even before the session receives the result',
    (resolved) => {
      expect(readArtifactReviewAttention('plan', status({ status: resolved }), 5)).toEqual({
        revision: 2,
        status: resolved,
        needsYou: false,
        observedAt: 5
      })
    }
  )

  it.each([
    { lifecycle: 'done' as const },
    { lifecycle: 'no_action' as const },
    { supersededBy: 'successor' },
    { needsYou: false }
  ])('honors lifecycle, supersession and viewer attention: %j', (patch) => {
    expect(readArtifactReviewAttention('plan', status(patch), 5)?.needsYou).toBe(false)
  })

  it('preserves mixed-version pending reviews and distinguishes unknown from resolved', () => {
    expect(readArtifactReviewAttention('plan', status(), 5)?.needsYou).toBe(true)
    expect(readArtifactReviewAttention('plan', status({ status: null }), 5)).toBeNull()
    expect(readArtifactReviewAttention('different-plan', status(), 5)).toBeNull()
    expect(
      readArtifactReviewAttention(
        'plan',
        status({
          artifact: { ...status().artifact, revision: undefined }
        }),
        5
      )
    ).toBeNull()
    expect(
      validArtifactReviewAttention({
        revision: 2,
        needsYou: false,
        status: 'approved',
        observedAt: 5
      })
    ).toBe(true)
    expect(
      validArtifactReviewAttention({
        revision: '2',
        needsYou: false,
        status: 'approved',
        observedAt: 5
      })
    ).toBe(false)
  })

  it('reads one canonical decision for multiple local references without changing delivery', async () => {
    const original = entry()
    const copy = { ...entry(), sourceKey: '/work/copy.md' }
    const read = vi.fn(async () => ({ status: 'ok' as const, value: status({ needsYou: false }) }))
    const save = vi.fn(() => true)
    const result = await reconcileReviewAttention([original, copy], {
      read,
      save,
      current: () => true,
      now: () => 5
    })
    expect(read).toHaveBeenCalledExactlyOnceWith('plan')
    expect(save).toHaveBeenCalledTimes(2)
    expect(result.map((row) => row.reviewAttention?.needsYou)).toEqual([false, false])
    expect(result[0]?.sleep).toBe(original.sleep)
    expect(result[0]?.sourceReview).toBe(original.sourceReview)
  })

  it.each([
    'unavailable',
    'signed-out',
    'stale-revision',
    'wrong-page',
    'scope-changed',
    'save-failed'
  ])('retains a confirmed result when the new read is %s', async (reason) => {
    const original = {
      ...entry(),
      reviewAttention: {
        revision: 2,
        needsYou: false,
        status: 'approved',
        observedAt: 4
      }
    }
    let current = true
    const save = vi.fn(() => reason !== 'save-failed')
    const result = await reconcileReviewAttention([original], {
      read: async () => {
        if (reason === 'unavailable') {
          throw new Error('offline')
        }
        if (reason === 'signed-out') {
          return { status: 'reconnect-required' as const }
        }
        if (reason === 'scope-changed') {
          current = false
        }
        return {
          status: 'ok' as const,
          value: status({
            artifact: {
              ...status().artifact,
              revision: reason === 'stale-revision' ? 1 : 2,
              slug: reason === 'wrong-page' ? 'other' : 'plan'
            }
          })
        }
      },
      save,
      current: () => current,
      now: () => 5
    })
    expect(result[0]).toBe(original)
    expect(save).toHaveBeenCalledTimes(reason === 'save-failed' ? 1 : 0)
  })

  it('accepts an explicitly reopened review while ignoring older overlapping reads', async () => {
    const original = {
      ...entry(),
      reviewAttention: {
        revision: 2,
        needsYou: false,
        status: 'approved',
        observedAt: 4
      }
    }
    const read = async () => ({ status: 'ok' as const, value: status({ needsYou: true }) })
    const save = vi.fn(() => true)
    const old = await reconcileReviewAttention([original], {
      read,
      save,
      current: () => true,
      now: () => 3
    })
    expect(old[0]).toBe(original)
    expect(save).not.toHaveBeenCalled()
    const reopened = await reconcileReviewAttention([original], {
      read,
      save,
      current: () => true,
      now: () => 5
    })
    expect(reopened[0]?.reviewAttention?.needsYou).toBe(true)
  })
})
