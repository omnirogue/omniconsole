import { describe, expect, it } from 'vitest'
import { artifactReviewPill } from './artifact-review-pill'

describe('artifactReviewPill', () => {
  it('shows a closure ahead of the review state', () => {
    expect(artifactReviewPill('approved', { lifecycle: 'done', supersededBy: 'next' })?.label).toBe(
      'Superseded'
    )
    expect(artifactReviewPill('approved', { lifecycle: 'done', supersededBy: null })?.label).toBe(
      'Done'
    )
    expect(
      artifactReviewPill('pending', { lifecycle: 'no_action', supersededBy: null })?.label
    ).toBe('No action')
    expect(artifactReviewPill(null, { lifecycle: null, supersededBy: 'next' })?.label).toBe(
      'Superseded'
    )
  })

  it('keeps the review pill when the page is open or the server predates lifecycle', () => {
    expect(artifactReviewPill('pending', { lifecycle: null, supersededBy: null })?.label).toBe(
      'Waiting'
    )
    expect(artifactReviewPill('changes_requested')?.label).toBe('Changes requested')
    expect(artifactReviewPill(null, null)).toBeNull()
  })

  it('R7: Done uses the semantic success tokens, not literal palette colours', () => {
    const done = artifactReviewPill('approved', { lifecycle: 'done', supersededBy: null })
    expect(done?.className).toBe(
      'border-status-success-border bg-status-success-background text-status-success'
    )
  })
})
