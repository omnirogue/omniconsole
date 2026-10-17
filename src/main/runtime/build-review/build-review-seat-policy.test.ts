import { describe, expect, it } from 'vitest'
import { buildReviewSeatProblem, validatedObjective } from './build-review-pipeline-state'

describe('buildReviewSeatProblem', () => {
  const opus = { agent: 'claude', model: 'opus' }

  it('refuses a reviewer that may not issue a verdict', () => {
    expect(buildReviewSeatProblem({ agent: 'codex' }, [opus, { agent: 'gemini' }])).toContain(
      'Reviewer 2 (gemini) may not issue a review verdict'
    )
    expect(buildReviewSeatProblem({ agent: 'codex' }, [{ agent: 'aider' }])).toContain(
      'may not issue a review verdict'
    )
  })

  it("refuses the builder's own model as its reviewer", () => {
    expect(buildReviewSeatProblem(opus, [{ agent: 'claude', model: 'Opus' }])).toContain(
      "Reviewer 1 is the builder's own model"
    )
    expect(buildReviewSeatProblem({ agent: 'codex' }, [{ agent: 'codex' }])).toContain(
      "builder's own model"
    )
  })

  it('treats an Agent-default builder as possibly any model of its agent (BRG-007)', () => {
    // The start cannot see which model "default" runs, so gpt-5.6-sol may be the builder itself.
    expect(
      buildReviewSeatProblem({ agent: 'codex' }, [{ agent: 'codex', model: 'gpt-5.6-sol' }])
    ).toContain("Reviewer 1 is the builder's own model")
  })

  it('accepts independent reviewers', () => {
    expect(
      buildReviewSeatProblem({ agent: 'codex', model: 'gpt-5.6-terra' }, [
        opus,
        { agent: 'codex', model: 'gpt-5.6-sol' },
        { agent: 'grok' }
      ])
    ).toBeNull()
    expect(buildReviewSeatProblem({ agent: 'codex' }, [opus, { agent: 'grok' }])).toBeNull()
  })

  it('is enforced before a pipeline starts', () => {
    expect(() =>
      validatedObjective({ worktree: 'id:x', objective: 'Build', reviewers: [{ agent: 'gemini' }] })
    ).toThrow('may not issue a review verdict')
  })
})
