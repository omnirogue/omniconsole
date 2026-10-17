import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewStatus } from '../../shared/artifact-review'
import type { ArtifactListItem } from '../../shared/artifacts'
import {
  grantArtifactReviewer,
  type ArtifactReviewGrantIo,
  type ArtifactReviewGrantService
} from './artifact-review-grant'

const REVIEW = { slug: 'launch-plan', title: 'Launch plan' }
const SOURCE = '/Users/me/work/launch-plan.md'

function status(
  patch: {
    reviewers?: string[]
    isOwner?: boolean
    question?: string
    audience?: string
    title?: string | null
  } = {}
): ArtifactReviewStatus {
  return {
    artifact: {
      version: 1,
      slug: REVIEW.slug,
      title: patch.title === undefined ? 'Launch plan' : patch.title,
      originalFileName: 'launch-plan.md',
      sourceContentType: 'text/markdown',
      renderedContentType: 'text/html',
      createdAt: '2026-09-23T00:00:00Z',
      updatedAt: '2026-09-23T00:00:00Z',
      expiresAt: '2026-10-23T00:00:00Z',
      byteSize: 10,
      deletedAt: null,
      audience: patch.audience ?? 'reviewers',
      review: {
        question: patch.question ?? 'Ship it?',
        reviewers: patch.reviewers ?? ['emp_other'],
        status: 'pending',
        statusAt: null
      }
    },
    shareUrl: 'https://console.example.com/a/launch-plan',
    status: 'pending',
    latest: null,
    decisions: [],
    viewer: { signedIn: true, isOwner: patch.isOwner ?? true, canDecide: false }
  }
}

function service(read: ArtifactReviewStatus, sourceKey: string | null = SOURCE) {
  const update = vi.fn<ArtifactReviewGrantService['update']>(async () => ({
    status: 'ok',
    value: {} as ArtifactListItem
  }))
  const reviewStatus = vi.fn<ArtifactReviewGrantService['reviewStatus']>(async () => ({
    status: 'ok',
    value: read
  }))
  const svc: ArtifactReviewGrantService = {
    reviewStatus,
    sessionRecords: () =>
      sourceKey
        ? [
            {
              slug: REVIEW.slug,
              shareUrl: read.shareUrl,
              sourceKey,
              savedAt: 1,
              contentUrl: `${read.shareUrl}/content`,
              origin: null
            }
          ]
        : [],
    update
  }
  return { svc, update, reviewStatus }
}

const io: ArtifactReviewGrantIo = {
  readSource: async () => ({ status: 'ok', content: '# Plan' })
}

describe('making the recipient a reviewer of the page', () => {
  it('publishes the page again with them added, keeping its question, audience and title', async () => {
    const { svc, update } = service(status())
    await expect(
      grantArtifactReviewer(svc, { review: REVIEW, reviewer: 'emp_reader' }, io)
    ).resolves.toEqual({ ok: true })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      sourceKey: SOURCE,
      content: '# Plan',
      contentType: 'text/markdown',
      fileName: 'launch-plan.md',
      title: 'Launch plan',
      audience: 'reviewers',
      review: { question: 'Ship it?', reviewers: ['emp_other', 'emp_reader'] }
    })
  })

  it('grants nothing else: only the review field changes, and no decision is made', async () => {
    const { svc, update } = service(status())
    await grantArtifactReviewer(svc, { review: REVIEW, reviewer: 'emp_reader' }, io)
    const request = update.mock.calls[0]![0]
    expect(Object.keys(request).sort()).toEqual(
      ['audience', 'content', 'contentType', 'fileName', 'review', 'sourceKey', 'title'].sort()
    )
    expect(Object.keys(request.review ?? {}).sort()).toEqual(['question', 'reviewers'])
  })

  it('leaves a page that already names them untouched, so a replayed send is harmless', async () => {
    const { svc, update } = service(status({ reviewers: ['EMP_READER'], isOwner: false }))
    await expect(
      grantArtifactReviewer(svc, { review: REVIEW, reviewer: 'emp_reader' }, io)
    ).resolves.toEqual({ ok: true })
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses for good when this person did not publish the page', async () => {
    const { svc, update } = service(status({ isOwner: false }))
    await expect(
      grantArtifactReviewer(svc, { review: REVIEW, reviewer: 'emp_reader' }, io)
    ).resolves.toMatchObject({ ok: false, permanent: true })
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses for good when the page was published from another computer', async () => {
    const { svc, update } = service(status(), null)
    const result = await grantArtifactReviewer(svc, { review: REVIEW, reviewer: 'emp_r' }, io)
    expect(result).toMatchObject({ ok: false, permanent: true })
    expect(result.ok ? '' : result.message).toContain('--reviewers emp_r')
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses a page already at the reviewer limit', async () => {
    const full = Array.from({ length: 20 }, (_, index) => `emp_${index}`)
    const { svc } = service(status({ reviewers: full }))
    await expect(
      grantArtifactReviewer(svc, { review: REVIEW, reviewer: 'emp_reader' }, io)
    ).resolves.toMatchObject({ ok: false, permanent: true })
  })

  it('asks again later when signed out or the network fails', async () => {
    const { svc, reviewStatus } = service(status())
    reviewStatus.mockResolvedValueOnce({ status: 'reconnect-required' })
    await expect(
      grantArtifactReviewer(svc, { review: REVIEW, reviewer: 'emp_reader' }, io)
    ).resolves.toMatchObject({ ok: false, permanent: false })
    reviewStatus.mockRejectedValueOnce(new Error('socket hang up'))
    await expect(
      grantArtifactReviewer(svc, { review: REVIEW, reviewer: 'emp_reader' }, io)
    ).resolves.toMatchObject({ ok: false, permanent: false })
    reviewStatus.mockRejectedValueOnce(new Error('Artifact x was not found'))
    await expect(
      grantArtifactReviewer(svc, { review: REVIEW, reviewer: 'emp_reader' }, io)
    ).resolves.toMatchObject({ ok: false, permanent: true })
  })
})
