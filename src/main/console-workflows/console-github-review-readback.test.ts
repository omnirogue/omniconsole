import { describe, expect, it, vi } from 'vitest'
import {
  GitHubReviewReadbackError,
  normalizeGitHubReviewSnapshot,
  readMergedGitHubReview,
  verifyGitHubReviewAdmission,
  type CanonicalAcceptedReviewBinding,
  type GitHubReviewSnapshot
} from './console-github-review-readback'

const SHA = 'a'.repeat(40)
const binding = (
  overrides: Partial<CanonicalAcceptedReviewBinding> = {}
): CanonicalAcceptedReviewBinding => ({
  artifactId: 'result-review-1',
  artifactVersion: 'version-1',
  reviewerId: 'reviewer-1',
  verdict: 'accepted',
  producerGitSha: SHA,
  repo: 'omnirogue/fixture',
  prNumber: 17,
  headRef: 'omni/job-1',
  baseRef: 'main',
  headSha: SHA,
  ...overrides
})
const snapshot = (overrides: Partial<GitHubReviewSnapshot> = {}): GitHubReviewSnapshot => ({
  repo: 'omnirogue/fixture',
  prNumber: 17,
  url: 'https://github.com/omnirogue/fixture/pull/17',
  state: 'open',
  headRef: 'omni/job-1',
  baseRef: 'main',
  headSha: SHA,
  mergeCommitSha: null,
  ...overrides
})
const input = (reviews = [binding()]) => ({
  repo: 'omnirogue/fixture',
  prNumber: 17,
  headRef: 'omni/job-1',
  expectedBaseRef: 'main',
  producerGitSha: SHA,
  acceptedReviews: reviews,
  expectedReviewerIds: [...new Set(reviews.map((review) => review.reviewerId))]
})

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return (error as GitHubReviewReadbackError).code
  }
  return undefined
}

describe('GitHub canonical review readback', () => {
  it('accepts the exact provider repository and pull request identity', () => {
    expect(
      normalizeGitHubReviewSnapshot('omnirogue/fixture', 17, {
        number: 17,
        state: 'OPEN',
        url: 'https://github.com/omnirogue/fixture/pull/17',
        headRefName: 'omni/job-1',
        baseRefName: 'main',
        headRefOid: SHA,
        mergeCommit: null
      })
    ).toMatchObject({ repo: 'omnirogue/fixture', prNumber: 17, headSha: SHA })
  })

  it('derives repository identity from the provider URL', () => {
    expect(() =>
      normalizeGitHubReviewSnapshot('omnirogue/fixture', 17, {
        number: 17,
        state: 'OPEN',
        url: 'https://github.com/omnirogue/other/pull/17',
        headRefName: 'omni/job-1',
        baseRefName: 'main',
        headRefOid: SHA,
        mergeCommit: null
      })
    ).toThrow(expect.objectContaining({ code: 'review-identity-mismatch' }))
  })

  it('returns provider-bound head and immutable accepted review bindings', async () => {
    const read = vi.fn().mockResolvedValue(snapshot())
    const result = await verifyGitHubReviewAdmission(
      input([binding(), binding({ artifactId: 'result-review-2', reviewerId: 'reviewer-2' })]),
      read
    )
    expect(result).toMatchObject({
      provider: 'github',
      producerGitSha: SHA,
      review: { state: 'open', headSha: SHA },
      acceptedReviews: [{ artifactVersion: 'version-1' }, { artifactId: 'result-review-2' }]
    })
  })

  it.each([
    ['producer SHA', binding({ producerGitSha: 'b'.repeat(40) })],
    ['head SHA', binding({ headSha: 'b'.repeat(40) })],
    ['repository', binding({ repo: 'omnirogue/other' })],
    ['pull request', binding({ prNumber: 18 })],
    ['head ref', binding({ headRef: 'other' })],
    ['base ref', binding({ baseRef: 'release' })]
  ])('rejects an accepted artifact with mismatched %s', async (_label, review) => {
    expect(await code(verifyGitHubReviewAdmission(input([review]), async () => snapshot()))).toBe(
      'review-binding-invalid'
    )
  })

  it('rejects replay of the same accepted artifact version', async () => {
    expect(
      await code(verifyGitHubReviewAdmission(input([binding(), binding()]), async () => snapshot()))
    ).toBe('review-binding-replayed')
  })

  it('rejects the same reviewer under a different artifact version', async () => {
    const reviews = [
      binding(),
      binding({ artifactId: 'result-review-2', artifactVersion: 'version-2' })
    ]
    expect(
      await code(
        verifyGitHubReviewAdmission(
          { ...input(reviews), expectedReviewerIds: ['reviewer-1', 'reviewer-2'] },
          async () => snapshot()
        )
      )
    ).toBe('review-binding-replayed')
  })

  it('rejects a missing required reviewer', async () => {
    expect(
      await code(
        verifyGitHubReviewAdmission(
          { ...input(), expectedReviewerIds: ['reviewer-1', 'reviewer-2'] },
          async () => snapshot()
        )
      )
    ).toBe('review-roster-mismatch')
  })

  it('invalidates acceptance when the provider head changed', async () => {
    expect(
      await code(
        verifyGitHubReviewAdmission(input(), async () => snapshot({ headSha: 'b'.repeat(40) }))
      )
    ).toBe('head-changed')
  })

  it('rejects a provider-retargeted pull request before merge', async () => {
    expect(
      await code(verifyGitHubReviewAdmission(input(), async () => snapshot({ baseRef: 'release' })))
    ).toBe('review-identity-mismatch')
  })

  it('preserves provider failures as typed failures', async () => {
    const failure = new GitHubReviewReadbackError('provider-failed', 'unavailable')
    await expect(
      verifyGitHubReviewAdmission(input(), async () => {
        throw failure
      })
    ).rejects.toBe(failure)
  })

  it('requires provider merged state and returns head plus merge commit separately', async () => {
    const admitted = await verifyGitHubReviewAdmission(input(), async () => snapshot())
    expect(
      await code(readMergedGitHubReview(admitted, async () => snapshot({ state: 'open' })))
    ).toBe('not-merged')
    const merged = await readMergedGitHubReview(admitted, async () =>
      snapshot({ state: 'merged', mergeCommitSha: 'c'.repeat(40) })
    )
    expect(merged.review).toMatchObject({
      state: 'merged',
      baseRef: 'main',
      headSha: SHA,
      mergeCommitSha: 'c'.repeat(40)
    })
  })

  it('rejects merged readback for a changed head or missing merge commit', async () => {
    const admitted = await verifyGitHubReviewAdmission(input(), async () => snapshot())
    expect(
      await code(
        readMergedGitHubReview(admitted, async () =>
          snapshot({ state: 'merged', headSha: 'b'.repeat(40), mergeCommitSha: 'c'.repeat(40) })
        )
      )
    ).toBe('head-changed')
    expect(
      await code(
        readMergedGitHubReview(admitted, async () =>
          snapshot({ state: 'merged', baseRef: 'release', mergeCommitSha: 'c'.repeat(40) })
        )
      )
    ).toBe('review-identity-mismatch')
    expect(
      await code(readMergedGitHubReview(admitted, async () => snapshot({ state: 'merged' })))
    ).toBe('merge-commit-missing')
    expect(
      await code(
        readMergedGitHubReview(admitted, async () =>
          snapshot({ state: 'merged', mergeCommitSha: 'not-a-git-object-id' })
        )
      )
    ).toBe('merge-commit-missing')
  })
})
