import { describe, expect, it } from 'vitest'
import { buildSessionReviewInstructions } from './session-chain-review-prompt'

describe('buildSessionReviewInstructions', () => {
  const review = {
    groupId: 'review_outcome_1',
    reviewerId: 'reviewer_a',
    round: 2,
    maxRounds: 3,
    candidateVersion: 'outcome_1:v4',
    adversarial: true
  }

  it('binds a reviewer to one immutable version and forbids edits', () => {
    const prompt = buildSessionReviewInstructions(review, { stepId: 'step_review_a' })
    expect(prompt).toContain('round 2 of at most 3')
    expect(prompt).toContain('immutable candidate version: outcome_1:v4')
    expect(prompt).toContain('Do not edit')
    expect(prompt).toContain('adversarial scrutiny')
    expect(prompt).not.toContain('OMNI_REVIEW_RESULT:')
    const line = prompt.split('\n').find((entry) => entry.startsWith('OMNI_VERDICT: '))!
    expect(JSON.parse(line.slice('OMNI_VERDICT: '.length))).toMatchObject({
      kind: 'review',
      stepId: 'step_review_a',
      candidateVersion: 'outcome_1:v4'
    })
  })

  it('asks for no second verdict line when the brief already carries the verdict suffix', () => {
    const prompt = buildSessionReviewInstructions(review, {
      stepId: 'step_review_a',
      verdictSuffix: true
    })
    expect(prompt).not.toContain('OMNI_VERDICT:')
    expect(prompt).not.toContain('OMNI_REVIEW_RESULT:')
    expect(prompt).toContain('immutable candidate version: outcome_1:v4')
  })
})
