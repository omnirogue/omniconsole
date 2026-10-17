import { describe, expect, it } from 'vitest'
import { reportSeverityCounts } from './build-review-report-findings'

describe('reportSeverityCounts', () => {
  it('counts inline findings however the reviewer decorated them', () => {
    const body = [
      'Findings:',
      '- **BLOCKER** src/a.ts:12 — crashes on empty input',
      '- MAJOR: src/b.ts:40 keyboard focus is lost',
      '1. [MAJOR] src/c.ts:3 wrong default',
      '* `MINOR` src/d.ts:9 naming',
      '> NIT: trailing space',
      '',
      'VERDICT: REQUEST_CHANGES'
    ].join('\n')
    expect(reportSeverityCounts(body)).toEqual({ blocker: 1, major: 2, minor: 1, nit: 1 })
  })

  it('counts the list items under a severity heading, not the heading itself', () => {
    const body = [
      '### BLOCKERS (2)',
      '- src/a.ts:1 broken',
      '  more detail about the first finding',
      '  - a nested note is not another finding',
      '- src/b.ts:2 broken',
      '',
      '**MINOR**',
      '1. src/c.ts:3 naming',
      '',
      'Overall the change is close.',
      '- this bullet belongs to no severity'
    ].join('\n')
    expect(reportSeverityCounts(body)).toEqual({ blocker: 2, major: 0, minor: 1, nit: 0 })
  })

  it('treats an explicit empty severity as no finding', () => {
    const body = ['BLOCKER: none', 'MAJOR: None.', 'MINOR: 0', '### NIT', '- n/a'].join('\n')
    expect(reportSeverityCounts(body)).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0 })
  })

  it('does not read prose or longer words as findings', () => {
    const body = [
      'Minor tweak suggested, nothing blocking.',
      'MAJORITY of the tests pass.',
      'NITPICKING aside, this is fine.',
      'VERDICT: APPROVE'
    ].join('\n')
    expect(reportSeverityCounts(body)).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0 })
  })

  it('counts findings a reviewer states in a sentence, once however often it repeats them', () => {
    const subject = 'Review: off-by-one fix correct; 1 MAJOR (unawaited save) -> REQUEST_CHANGES'
    const body = [
      'The off-by-one fix is correct and complete, but I found one unresolved MAJOR in the same',
      "function: src/reserve.ts:16 'store.save()' is not awaited. Also two NITs: no regression test",
      'guards the boundary and the change is uncommitted; full findings are in the report path.',
      '',
      'VERDICT: REQUEST_CHANGES'
    ].join('\n')
    expect(reportSeverityCounts(body, subject)).toEqual({ blocker: 0, major: 1, minor: 0, nit: 2 })
    expect(reportSeverityCounts('No BLOCKERs, 3 MINOR issues and one NIT.')).toEqual({
      blocker: 0,
      major: 0,
      minor: 3,
      nit: 1
    })
  })

  it('counts no finding a sentence denies, names again or says is fixed', () => {
    const none = { blocker: 0, major: 0, minor: 0, nit: 0 }
    expect(reportSeverityCounts('This is not a BLOCKER.\nVERDICT: APPROVE')).toEqual(none)
    expect(reportSeverityCounts('I lowered it from a MAJOR to a MINOR.')).toEqual(none)
    expect(
      reportSeverityCounts('The 2 MAJORs from round 1 are fixed.\n\nVERDICT: APPROVE')
    ).toEqual(none)
    expect(reportSeverityCounts('2 MAJORs fixed, not one BLOCKER left.')).toEqual(none)
    expect(reportSeverityCounts('Both round-1 findings (2 MAJORs) are now resolved.')).toEqual(none)
    // A finding that still has to be fixed, beside a fix that landed, is still counted.
    expect(
      reportSeverityCounts('The off-by-one is fixed, but I found 1 MAJOR that must be fixed.')
    ).toEqual({ ...none, major: 1 })
  })

  it('takes the higher of a listed and a stated count, and reads no location as a count', () => {
    const body = [
      'Two MAJORs:',
      '- **MAJOR** src/a.ts:12 — crashes on empty input',
      '- **MAJOR** src/b.ts:40 — focus is lost',
      '- src/c.ts:3 MAJOR wording of the same kind',
      'I also saw 2 major regressions in prose, and 12 minor typos.'
    ].join('\n')
    // Two listed items and "Two MAJORs" agree; `src/c.ts:3 MAJOR` is a location, and lower-case
    // severities are prose, not findings.
    expect(reportSeverityCounts(body)).toEqual({ blocker: 0, major: 2, minor: 0, nit: 0 })
  })

  it('returns zero counts for a missing report', () => {
    expect(reportSeverityCounts(null)).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0 })
    expect(reportSeverityCounts('')).toEqual({ blocker: 0, major: 0, minor: 0, nit: 0 })
  })
})
