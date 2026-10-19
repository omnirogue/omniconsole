import { describe, expect, it } from 'vitest'
import type { HostedReviewInfo } from '../../shared/hosted-review'
import type { SpecPrBatchSlot } from '../../shared/spec-pr-batch'
import { isVerifiedSpecDraft } from './spec-pr-batch-verification'

describe('draft PR readback', () => {
  it('requires the exact repository, base, head, and draft state', () => {
    const slot = {
      repoRemote: 'github.com/omnirogue/omni-ide',
      baseRef: 'main-next'
    } as SpecPrBatchSlot
    const review = {
      provider: 'github',
      state: 'draft',
      baseRefName: 'main-next',
      headSha: 'abc',
      githubRepository: { owner: 'omnirogue', repo: 'omni-ide' }
    } as HostedReviewInfo
    expect(isVerifiedSpecDraft(review, slot, 'abc')).toBe(true)
    expect(isVerifiedSpecDraft({ ...review, state: 'open' }, slot, 'abc')).toBe(false)
    expect(isVerifiedSpecDraft({ ...review, baseRefName: 'main' }, slot, 'abc')).toBe(false)
    expect(isVerifiedSpecDraft({ ...review, headSha: 'other' }, slot, 'abc')).toBe(false)
    expect(
      isVerifiedSpecDraft(
        { ...review, githubRepository: { owner: 'omnirogue', repo: 'other' } },
        slot,
        'abc'
      )
    ).toBe(false)
  })
})
