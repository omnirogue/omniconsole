import { describe, expect, it } from 'vitest'
import type { ArtifactReviewProgress } from './artifact-review'
import {
  artifactResponsesCount,
  artifactResponsesInMessage
} from './artifact-review-responses-message'

function progress(over: Partial<ArtifactReviewProgress> = {}): ArtifactReviewProgress {
  return {
    id: 'abc:2',
    revision: 2,
    submitted: 3,
    of: 3,
    setAside: 0,
    everyone: false,
    ready: true,
    readyAt: '2026-10-10T12:00:00Z',
    reason: 'all',
    overdue: false,
    people: [],
    ...over
  }
}

const PAGE = {
  slug: 'abc',
  title: 'Which hook works?',
  shareUrl: 'https://app.omnisi.ai/a/abc'
}

describe('responses in message', () => {
  it('says the answers are in, that it is not an approval, and where a review sums them up', () => {
    expect(
      artifactResponsesInMessage({ ...PAGE, progress: progress(), study: false }).split('\n')
    ).toEqual([
      '[OmniOS responses] Responses in: 3 of 3 answered on revision 2 of "Which hook works?"',
      'https://app.omnisi.ai/a/abc',
      'This is not an approval: nobody decided anything, and the ask stays open until it is closed.',
      'Do now: read the answers (omni artifacts status abc --json, the "responses" field) and sum up their common themes and disagreements in one comment on the page (OmniConsole artifact_comment; without that tool, in your reply to the owner).',
      'If you were told to act on the answers and the ask is still open, act, then close it with the conclusion: omni artifacts close abc --done --revision 2 --note "<conclusion, at most 500 characters>". Otherwise the decision and the close are the owner\'s.',
      'Anything that moves money, reaches a customer, changes ad budgets or grants access still needs its own approval.'
    ])
  })

  it('keeps a study summary off the page while it is open', () => {
    const text = artifactResponsesInMessage({ ...PAGE, progress: progress(), study: true })
    expect(text).toContain(
      "sum up their common themes and disagreements in your reply to the owner. Never comment on the page while the study is open: people who haven't answered would see it."
    )
    expect(text).not.toContain('artifact_comment')
  })

  it('asks for no summary or conclusion when the due time passed with no answer', () => {
    const lines = artifactResponsesInMessage({
      ...PAGE,
      progress: progress({ submitted: 0, reason: 'due' }),
      study: false
    }).split('\n')
    expect(lines[0]).toBe(
      '[OmniOS responses] No responses: the due time passed (0 of 3 answered) on revision 2 of "Which hook works?"'
    )
    expect(lines).toContain(
      'Nobody answered, so there is nothing to sum up or conclude. Do now: tell the owner; waiting longer, reminding people or closing the ask is theirs.'
    )
    expect(lines.join('\n')).not.toMatch(/sum up their|omni artifacts close/)
  })

  it('says when the message woke the session', () => {
    expect(
      artifactResponsesInMessage({ ...PAGE, progress: progress(), study: false, woke: true })
    ).toContain('this message woke the same conversation')
  })

  it('counts named answers, set-aside people, and an ask anyone may answer', () => {
    expect(artifactResponsesCount(progress({ submitted: 2, setAside: 1 }))).toBe(
      '2 of 3 answered, 1 set aside'
    )
    expect(
      artifactResponsesCount(progress({ of: null, everyone: true, submitted: 5, reason: 'due' }))
    ).toBe('the due time passed (5 answered)')
    expect(artifactResponsesCount(progress({ submitted: 1, reason: 'due' }))).toBe(
      'the due time passed (1 of 3 answered)'
    )
  })
})
