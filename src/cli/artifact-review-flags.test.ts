import { describe, expect, it } from 'vitest'
import { parseArgs, REPEATED_FLAG_SEPARATOR } from './args'
import { parseArtifactReviewFlags } from './artifact-review-flags'

function flags(entries: [string, string | boolean][]): Map<string, string | boolean> {
  return new Map(entries)
}

describe('parseArtifactReviewFlags', () => {
  it('returns no keys when no review flag is passed', () => {
    expect(parseArtifactReviewFlags(flags([['file', 'report.html']]))).toEqual({})
  })

  it('maps a bare --review to an empty review request', () => {
    expect(parseArtifactReviewFlags(flags([['review', true]]))).toEqual({ review: {} })
  })

  it('lets --question and --reviewers imply --review', () => {
    expect(parseArtifactReviewFlags(flags([['question', '  Ship it?  ']]))).toEqual({
      review: { question: 'Ship it?' }
    })
    expect(
      parseArtifactReviewFlags(flags([['reviewers', 'a@example.com, emp_123,,a@example.com']]))
    ).toEqual({ review: { reviewers: ['a@example.com', 'emp_123'] } })
  })

  it('sends --category as review.about and lets it imply --review', () => {
    expect(parseArtifactReviewFlags(flags([['category', '  finance  ']]))).toEqual({
      review: { about: { category: 'finance' } }
    })
    expect(
      parseArtifactReviewFlags(
        flags([
          ['reviewers', 'a@example.com'],
          ['category', 'refunds']
        ])
      )
    ).toEqual({ review: { reviewers: ['a@example.com'], about: { category: 'refunds' } } })
    expect(parseArtifactReviewFlags(flags([['category', 'x'.repeat(40)]])).review).toEqual({
      about: { category: 'x'.repeat(40) }
    })
    expect(() => parseArtifactReviewFlags(flags([['category', 'x'.repeat(41)]]))).toThrow(
      /--category must be at most 40/
    )
    expect(() => parseArtifactReviewFlags(flags([['category', true]]))).toThrow(
      /--category requires a value/
    )
    expect(parseArtifactReviewFlags(flags([['review', true]])).review).not.toHaveProperty('about')
  })

  it('passes a valid audience with or without a review', () => {
    expect(parseArtifactReviewFlags(flags([['audience', 'public']]))).toEqual({
      audience: 'public'
    })
    expect(
      parseArtifactReviewFlags(
        flags([
          ['review', true],
          ['audience', 'reviewers']
        ])
      )
    ).toEqual({ review: {}, audience: 'reviewers' })
  })

  it('rejects an unknown audience', () => {
    expect(() => parseArtifactReviewFlags(flags([['audience', 'everyone']]))).toThrow(
      /--audience must be one of: public, team, reviewers/
    )
  })

  it('rejects more than 20 reviewers', () => {
    const reviewers = Array.from({ length: 21 }, (_, index) => `r${index}@example.com`).join(',')
    expect(() => parseArtifactReviewFlags(flags([['reviewers', reviewers]]))).toThrow(/at most 20/)
  })

  it('rejects reviewers that are neither emails nor emp_ ids', () => {
    expect(() => parseArtifactReviewFlags(flags([['reviewers', 'sal,emp_1']]))).toThrow(
      /not recognized: sal/
    )
    expect(() => parseArtifactReviewFlags(flags([['reviewers', ' , ']]))).toThrow(/at least one/)
  })

  it('rejects an over-long or empty question', () => {
    expect(() => parseArtifactReviewFlags(flags([['question', 'x'.repeat(501)]]))).toThrow(
      /at most 500/
    )
    expect(() => parseArtifactReviewFlags(flags([['question', true]]))).toThrow(
      /--question requires a value/
    )
  })

  it('rejects a value on --review', () => {
    expect(() => parseArtifactReviewFlags(flags([['review', 'please']]))).toThrow(
      /does not take a value/
    )
    expect(parseArtifactReviewFlags(flags([['review', 'false']]))).toEqual({})
  })

  it('keeps the review body byte-identical when no summary or option flag is passed', () => {
    const parsed = parseArtifactReviewFlags(
      flags([
        ['question', 'Ship it?'],
        ['reviewers', 'a@example.com'],
        ['audience', 'team']
      ])
    )
    expect(JSON.stringify(parsed)).toBe(
      '{"review":{"question":"Ship it?","reviewers":["a@example.com"]},"audience":"team"}'
    )
  })

  it('maps --summary and repeated --option from argv, splitting each at the first ::', () => {
    const { flags: argv } = parseArgs([
      'artifacts',
      'share',
      'fix.html',
      '--summary',
      '  Two lines to decide from.  ',
      '--option',
      'Start ::  Open a PR today :: then ping Sal ',
      '--option',
      '  Investigate   further ',
      '--option=Not now'
    ])
    expect(parseArtifactReviewFlags(argv)).toEqual({
      review: {
        summary: 'Two lines to decide from.',
        options: [
          { label: 'Start', detail: 'Open a PR today :: then ping Sal' },
          { label: 'Investigate further' },
          { label: 'Not now' }
        ]
      }
    })
  })

  it('marks the --recommend answer, matching the label case-insensitively', () => {
    const { flags: argv } = parseArgs([
      'artifacts',
      'share',
      'fix.html',
      '--option',
      'Start',
      '--option',
      'Not now',
      '--recommend',
      'start'
    ])
    expect(parseArtifactReviewFlags(argv).review?.options).toEqual([
      { label: 'Start', recommended: true },
      { label: 'Not now' }
    ])
  })

  it('allows several recommended answers only with --multi', () => {
    const argv = [
      'artifacts',
      'share',
      'fix.html',
      '--option',
      'A',
      '--option',
      'B',
      '--option',
      'C',
      '--recommend',
      'A',
      '--recommend',
      'B'
    ]
    expect(() => parseArtifactReviewFlags(parseArgs(argv).flags)).toThrow(
      /at most one answer unless --multi/
    )
    const { flags: multi } = parseArgs([...argv, '--multi'])
    expect(parseArtifactReviewFlags(multi)).toEqual({
      review: {
        options: [
          { label: 'A', recommended: true },
          { label: 'B', recommended: true },
          { label: 'C' }
        ],
        multi: true
      }
    })
  })

  it('does not let --multi take the next token as its value', () => {
    const parsed = parseArgs(['artifacts', 'share', '--multi', 'fix.html', '--option', 'A'])
    expect(parsed.flags.get('multi')).toBe(true)
    expect(parsed.commandPath).toEqual(['artifacts', 'share', 'fix.html'])
  })

  it('refuses --option with --proposal-json, as the server does', () => {
    expect(() =>
      parseArtifactReviewFlags(
        flags([
          ['proposal-json', '{"version":1,"kind":"plan"}'],
          ['option', `A${REPEATED_FLAG_SEPARATOR}B`]
        ])
      )
    ).toThrow(/--option cannot be combined with --proposal-json/)
    expect(
      parseArtifactReviewFlags(
        flags([
          ['proposal-json', '{"version":1,"kind":"plan"}'],
          ['summary', 'Approve the plan as written.']
        ])
      ).review
    ).toMatchObject({
      context: { version: 1, kind: 'plan' },
      summary: 'Approve the plan as written.'
    })
  })

  it('refuses --recommend or --multi without --option, and unknown recommendations', () => {
    expect(() => parseArtifactReviewFlags(flags([['recommend', 'A']]))).toThrow(
      /--recommend needs --option/
    )
    expect(() => parseArtifactReviewFlags(flags([['multi', true]]))).toThrow(
      /--multi needs --option/
    )
    expect(() =>
      parseArtifactReviewFlags(
        flags([
          ['option', `A${REPEATED_FLAG_SEPARATOR}B`],
          ['recommend', 'C']
        ])
      )
    ).toThrow(/not found: C$/)
    expect(() => parseArtifactReviewFlags(flags([['multi', 'yes']]))).toThrow(
      /--multi does not take a value\./
    )
  })

  it('enforces the server limits on summary and options', () => {
    expect(parseArtifactReviewFlags(flags([['summary', 'x'.repeat(1200)]])).review).toEqual({
      summary: 'x'.repeat(1200)
    })
    expect(() => parseArtifactReviewFlags(flags([['summary', 'x'.repeat(1201)]]))).toThrow(
      /--summary must be at most 1200/
    )
    expect(() => parseArtifactReviewFlags(flags([['summary', true]]))).toThrow(
      /--summary requires a value/
    )
    const options = (labels: string[]) => flags([['option', labels.join(REPEATED_FLAG_SEPARATOR)]])
    expect(() => parseArtifactReviewFlags(options(['Only']))).toThrow(/2 to 8 times/)
    expect(() =>
      parseArtifactReviewFlags(options(Array.from({ length: 9 }, (_, index) => `O${index}`)))
    ).toThrow(/2 to 8 times/)
    expect(() => parseArtifactReviewFlags(options(['x'.repeat(161), 'B']))).toThrow(
      /label of at most 160/
    )
    expect(() => parseArtifactReviewFlags(options(['::detail only', 'B']))).toThrow(/needs a label/)
    expect(() => parseArtifactReviewFlags(options([`A::${'d'.repeat(601)}`, 'B']))).toThrow(
      /detail is at most 600/
    )
    expect(() => parseArtifactReviewFlags(options(['Start', ' start ']))).toThrow(
      /'start' appears twice/
    )
    expect(() => parseArtifactReviewFlags(flags([['option', true]]))).toThrow(
      /--option requires a value/
    )
  })
})
