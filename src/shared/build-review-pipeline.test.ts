import { describe, expect, it } from 'vitest'
import {
  buildReviewEndedWithChangesRequested,
  reviewVerdict,
  type BuildReviewPipelineSnapshot,
  type BuildReviewWorkerSnapshot
} from './build-review-pipeline'

describe('reviewVerdict', () => {
  it('reads the plain verdict line the reviewer brief asks for', () => {
    expect(reviewVerdict('Checked everything.\nVERDICT: APPROVE')).toBe('APPROVE')
    expect(reviewVerdict('MAJOR: keyboard input broken\nVERDICT: REQUEST_CHANGES')).toBe(
      'REQUEST_CHANGES'
    )
    expect(reviewVerdict('  VERDICT: APPROVE  \r\n')).toBe('APPROVE')
  })

  it.each([
    ['**VERDICT: APPROVE**', 'APPROVE'],
    ['**VERDICT:** APPROVE', 'APPROVE'],
    ['VERDICT: **REQUEST_CHANGES**', 'REQUEST_CHANGES'],
    ['`VERDICT: APPROVE`', 'APPROVE'],
    ['__VERDICT: REQUEST_CHANGES__', 'REQUEST_CHANGES'],
    ['_VERDICT: APPROVE_', 'APPROVE'],
    ['> VERDICT: APPROVE', 'APPROVE'],
    ['> > **VERDICT: REQUEST_CHANGES**', 'REQUEST_CHANGES'],
    ['## VERDICT: APPROVE', 'APPROVE'],
    ['- VERDICT: APPROVE', 'APPROVE'],
    ['* VERDICT: REQUEST_CHANGES', 'REQUEST_CHANGES'],
    ['1. VERDICT: APPROVE', 'APPROVE'],
    ['VERDICT: REQUEST_CHANGES.', 'REQUEST_CHANGES'],
    ['VERDICT: APPROVE!', 'APPROVE'],
    ['**VERDICT: APPROVE.**', 'APPROVE'],
    ['VERDICT:APPROVE', 'APPROVE'],
    ['VERDICT : APPROVE', 'APPROVE'],
    ['VERDICT: _APPROVE_', 'APPROVE'],
    ['VERDICT: _REQUEST_CHANGES_', 'REQUEST_CHANGES'],
    ['**Verdict:** APPROVE', 'APPROVE'],
    ['- **Verdict**: REQUEST_CHANGES.', 'REQUEST_CHANGES']
  ])('tolerates decoration in %j', (line, verdict) => {
    expect(reviewVerdict(`Findings first.\n\n${line}`)).toBe(verdict)
  })

  it('still requires exactly one verdict line', () => {
    expect(reviewVerdict('Reviewed everything')).toBeNull()
    expect(reviewVerdict('')).toBeNull()
    expect(reviewVerdict(null)).toBeNull()
    expect(reviewVerdict(undefined)).toBeNull()
    expect(reviewVerdict('VERDICT: APPROVE\nVERDICT: REQUEST_CHANGES')).toBeNull()
    expect(reviewVerdict('**VERDICT: APPROVE**\n> VERDICT: APPROVE')).toBeNull()
    // An echo of the instruction is a second verdict line, so nothing is read as approval.
    expect(
      reviewVerdict('`VERDICT: APPROVE` or `VERDICT: REQUEST_CHANGES`\nVERDICT: APPROVE')
    ).toBeNull()
  })

  it('refuses a verdict line naming anything but the two verdicts', () => {
    expect(reviewVerdict('VERDICT: LGTM')).toBeNull()
    expect(reviewVerdict('VERDICT: APPROVE (with nits)')).toBeNull()
    expect(reviewVerdict('VERDICT: approve')).toBeNull()
    expect(reviewVerdict('VERDICT:')).toBeNull()
    expect(reviewVerdict('**VERDICT:**\nAPPROVE')).toBeNull()
    // A lower-case label counts only with an exact verdict, so this is no verdict at all.
    expect(reviewVerdict('Verdict: approve')).toBeNull()
  })

  it('does not let prose with a lower-case label void the real verdict line', () => {
    expect(reviewVerdict('Verdict: looks fine overall.\nVERDICT: APPROVE')).toBe('APPROVE')
    expect(reviewVerdict('Status: APPROVE')).toBeNull()
    // Two lines that both state a verdict are still two verdicts.
    expect(reviewVerdict('Verdict: APPROVE\nVERDICT: REQUEST_CHANGES')).toBeNull()
  })

  it('ignores prose that merely mentions a verdict', () => {
    expect(reviewVerdict('The final VERDICT: APPROVE is below.\nVERDICT: REQUEST_CHANGES')).toBe(
      'REQUEST_CHANGES'
    )
    expect(reviewVerdict('No verdict yet.')).toBeNull()
  })
})

describe('buildReviewEndedWithChangesRequested', () => {
  const reviewer = (body: string, status = 'succeeded') =>
    ({ status, report: { body } }) as unknown as BuildReviewWorkerSnapshot
  const ended = (
    reviewers: BuildReviewWorkerSnapshot[],
    error = 'Review limit reached after 2 round(s); unresolved findings remain in the reviewer reports.'
  ) =>
    ({
      stage: 'failed',
      round: 2,
      maxReviewRounds: 2,
      error,
      reviewers
    }) as unknown as BuildReviewPipelineSnapshot

  it('is the pipeline stopping at its round limit with changes still requested', () => {
    expect(
      buildReviewEndedWithChangesRequested(
        ended([reviewer('VERDICT: APPROVE'), reviewer('MAJOR: x\nVERDICT: REQUEST_CHANGES')])
      )
    ).toBe(true)
  })

  it('is not a last round that ended on a real failure', () => {
    // Reviewer 2 answered without one valid verdict: the run failed on that, whatever the rest said.
    const noVerdict = [reviewer('VERDICT: REQUEST_CHANGES'), reviewer('Looks fine to me.')]
    expect(
      buildReviewEndedWithChangesRequested(
        ended(
          noVerdict,
          'Reviewer 2 did not provide one valid verdict; approval is not established.'
        )
      )
    ).toBe(false)
    // Even beside the round-limit text, a reviewer with no valid verdict is not that outcome.
    expect(buildReviewEndedWithChangesRequested(ended(noVerdict))).toBe(false)
    expect(
      buildReviewEndedWithChangesRequested(
        ended([reviewer('VERDICT: REQUEST_CHANGES')], 'Review note could not be posted.')
      )
    ).toBe(false)
    expect(
      buildReviewEndedWithChangesRequested(ended([reviewer('VERDICT: REQUEST_CHANGES', 'failed')]))
    ).toBe(false)
    expect(buildReviewEndedWithChangesRequested(ended([reviewer('VERDICT: APPROVE')]))).toBe(false)
  })
})
