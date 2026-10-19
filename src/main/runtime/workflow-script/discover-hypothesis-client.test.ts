import { describe, expect, it } from 'vitest'
import {
  DISCOVER_CITATIONS_MAX_COUNT,
  DISCOVER_HYPOTHESES_MAX_COUNT,
  buildDiscoverHypothesisMatrix,
  discoverHypothesisCoverage,
  parseDiscoverCitationRef,
  parseDiscoverHypotheses,
  readDiscoverHypothesisMatrix,
  type DiscoverCitation,
  type DiscoverHypothesis
} from './discover-hypothesis-client'

function citation(source: string, overrides: Partial<DiscoverCitation> = {}): DiscoverCitation {
  return { source, startLine: 1, endLine: 1, stance: 'supports', check: 'verified', ...overrides }
}

function lines(startLine: number, endLine = startLine) {
  return { startLine, endLine }
}

function hypothesis(
  id: string,
  citations: DiscoverCitation[],
  confidence: number | null = null
): DiscoverHypothesis {
  return { id, claim: `claim ${id}`, confidence, citations }
}

const NEEDS_CLAIM = 'hypothesis needs a claim'
const BAD_CONFIDENCE = 'confidence must be 0-1 or a 0-100 percentage'
const BAD_LOCATION = 'citation needs a readable location'

describe('parseDiscoverCitationRef', () => {
  it.each([
    ['src/a.ts:12', { source: 'src/a.ts', ...lines(12) }],
    ['./src/a.ts:3-7.', { source: 'src/a.ts', ...lines(3, 7) }],
    ['C:\\repo\\a.ts:9', { source: 'C:/repo/a.ts', ...lines(9) }],
    ['README.md', { source: 'README.md' }],
    ['https://x.dev/o/r/a.ts#L10-L12', { source: 'https://x.dev/o/r/a.ts', ...lines(10, 12) }],
    ['http://localhost:3000/docs', { source: 'http://localhost:3000/docs' }]
  ])('reads %s', (text, expected) => {
    expect(parseDiscoverCitationRef(text)).toEqual(expected)
  })

  it.each(['', '   ', ':', 'src/a.ts:9-3', 'src/a.ts:0'])('refuses %j', (text) => {
    expect(parseDiscoverCitationRef(text)).toBeNull()
  })
})

describe('parseDiscoverHypotheses', () => {
  it('reads citations, Discover evidence words and percentage confidence', () => {
    const { hypotheses, issues } = parseDiscoverHypotheses({
      hypotheses: [
        {
          id: 'cache',
          claim: ' Cache misses double cost ',
          confidence: 80,
          citations: [
            'src/cache.ts:10',
            { location: 'src/cache.ts:20-24', quote: ' miss ', stance: 'Refutes', check: 'found' },
            { location: 'https://x.dev/report#L3', stance: 'context', check: 'unquoted' }
          ]
        },
        { id: 7, title: 'From title', confidence: 0.25, citations: [{ location: 'b.ts:1' }] }
      ]
    })

    expect(issues).toEqual([])
    expect(hypotheses).toEqual([
      {
        id: 'cache',
        claim: 'Cache misses double cost',
        confidence: 0.8,
        citations: [
          citation('src/cache.ts', { ...lines(10), check: 'unchecked' }),
          citation('src/cache.ts', { ...lines(20, 24), quote: 'miss', stance: 'refutes' }),
          citation('https://x.dev/report', { ...lines(3), stance: 'context', check: 'unchecked' })
        ]
      },
      {
        id: '7',
        claim: 'From title',
        confidence: 0.25,
        citations: [citation('b.ts', { check: 'unchecked' })]
      }
    ])
  })

  it('skips unreadable or duplicate hypotheses and reports bad fields', () => {
    const { hypotheses, issues } = parseDiscoverHypotheses([
      { claim: 'first' },
      'not an object',
      { claim: '   ' },
      { id: 'h1', claim: 'collides with the default id' },
      { claim: 'odd fields', confidence: '0.9', citations: 'src/a.ts:1' },
      { claim: 'too sure', confidence: 140 }
    ])

    expect(hypotheses.map((h) => [h.id, h.confidence, h.citations])).toEqual([
      ['h1', null, []],
      ['h5', null, []],
      ['h6', null, []]
    ])
    expect(issues).toEqual([
      { path: 'hypotheses[1]', message: NEEDS_CLAIM },
      { path: 'hypotheses[2]', message: NEEDS_CLAIM },
      { path: 'hypotheses[3]', message: 'duplicate id "h1"' },
      { path: 'hypotheses[4].confidence', message: BAD_CONFIDENCE },
      { path: 'hypotheses[4].citations', message: 'citations must be an array' },
      { path: 'hypotheses[5].confidence', message: BAD_CONFIDENCE }
    ])
  })

  it('keeps the best-checked duplicate citation and reports unreadable ones', () => {
    const { hypotheses, issues } = parseDiscoverHypotheses([
      {
        claim: 'x',
        citations: [
          { location: 'src/a.ts:4', check: 'missing' },
          { location: 'src/a.ts:4', check: 'found' },
          { location: 'src/a.ts:4', check: 'unquoted' },
          { location: 'src/a.ts:4', stance: 'refutes', check: 'unreadable' },
          { location: 'src/a.ts:5', stance: 'maybe', check: 'perhaps' },
          { quote: 'no location' },
          42,
          'src/a.ts:9-2'
        ]
      }
    ])

    expect(hypotheses[0].citations).toEqual([
      citation('src/a.ts', lines(4)),
      citation('src/a.ts', { ...lines(4), stance: 'refutes', check: 'unreadable' }),
      citation('src/a.ts', { ...lines(5), stance: 'context', check: 'unchecked' })
    ])
    const unknownWords = 'unknown stance "maybe" or check "perhaps"'
    expect(issues).toEqual([
      { path: 'hypotheses[0].citations[4]', message: unknownWords },
      { path: 'hypotheses[0].citations[5]', message: BAD_LOCATION },
      { path: 'hypotheses[0].citations[6]', message: BAD_LOCATION },
      { path: 'hypotheses[0].citations[7]', message: BAD_LOCATION }
    ])
  })

  it('drops hypotheses and citations beyond the limits with one issue each', () => {
    const cited = {
      claim: 'cited',
      citations: Array.from({ length: DISCOVER_CITATIONS_MAX_COUNT + 5 }, (_, i) => `a.ts:${i + 1}`)
    }
    const others = Array.from({ length: DISCOVER_HYPOTHESES_MAX_COUNT }, (_, i) => ({
      claim: `c${i}`
    }))

    const { hypotheses, issues } = parseDiscoverHypotheses([cited, ...others])

    expect(hypotheses).toHaveLength(DISCOVER_HYPOTHESES_MAX_COUNT)
    expect(hypotheses[0].citations).toHaveLength(DISCOVER_CITATIONS_MAX_COUNT)
    expect(issues.map((issue) => issue.path)).toEqual(['hypotheses', 'hypotheses[0].citations'])
  })

  it.each([{ items: [] }, null, 'hypotheses'])('refuses a %j payload', (payload) => {
    expect(() => parseDiscoverHypotheses(payload)).toThrow(/array or \{ hypotheses/)
  })
})

describe('discoverHypothesisCoverage', () => {
  it.each([
    ['uncited', []],
    ['unverified', [citation('a', { check: 'unchecked' }), citation('b', { check: 'missing' })]],
    ['unverified', [citation('a', { stance: 'context' })]],
    ['supported', [citation('a'), citation('b', { check: 'unchecked', stance: 'refutes' })]],
    ['refuted', [citation('a', { stance: 'refutes' })]],
    ['contested', [citation('a'), citation('b', { stance: 'refutes' })]]
  ] as const)('reads %s evidence', (verdict, citations) => {
    expect(discoverHypothesisCoverage(hypothesis('h', [...citations])).verdict).toBe(verdict)
  })

  it('measures verification, support and the confidence gap', () => {
    const citations = [
      citation('a'),
      citation('a', lines(5)),
      citation('b', { stance: 'refutes' }),
      citation('c', { check: 'missing' }),
      citation('d', { check: 'unreadable' })
    ]

    expect(discoverHypothesisCoverage(hypothesis('h', citations, 0.9))).toEqual({
      citations: 5,
      verified: 3,
      failed: 2,
      verifiedSupporting: 2,
      verifiedRefuting: 1,
      sources: 4,
      verificationRate: 3 / 5,
      support: 2 / 3,
      verdict: 'contested',
      confidenceGap: 0.9 - 2 / 3
    })
  })

  it('leaves rates and the gap null when nothing backs them', () => {
    const coverage = discoverHypothesisCoverage(hypothesis('h', [], 0.7))
    expect(coverage).toMatchObject({ verificationRate: null, support: null, confidenceGap: null })
  })
})

describe('buildDiscoverHypothesisMatrix', () => {
  it('lines shared sources up first and fills one cell per cited source', () => {
    const shared = 'src/shared.ts'
    const matrix = buildDiscoverHypothesisMatrix([
      hypothesis(
        'h1',
        [citation('src/z.ts'), citation(shared, { stance: 'refutes', check: 'missing' })],
        0.75
      ),
      hypothesis(
        'h2',
        [
          citation(shared),
          citation(shared, { ...lines(9), stance: 'context', check: 'unchecked' }),
          citation('src/a.ts', { stance: 'refutes' })
        ],
        0.5
      ),
      hypothesis('h3', [])
    ])

    const cell = (supports: number, refutes: number, context: number, verified: number) => ({
      supports,
      refutes,
      context,
      verified,
      failed: 0
    })
    expect(matrix.sources).toEqual([shared, 'src/a.ts', 'src/z.ts'])
    expect(matrix.rows.map((row) => row.cells)).toEqual([
      [{ ...cell(0, 1, 0, 0), failed: 1 }, null, cell(1, 0, 0, 1)],
      [cell(1, 0, 1, 1), cell(0, 1, 0, 1), null],
      [null, null, null]
    ])
    expect(matrix.rows.map((row) => row.coverage.verdict)).toEqual([
      'supported',
      'contested',
      'uncited'
    ])
    expect(matrix.summary).toEqual({
      hypotheses: 3,
      citations: 5,
      verifiedCitations: 3,
      failedCitations: 1,
      uniqueSources: 3,
      sharedSources: 1,
      verdicts: { supported: 1, contested: 1, refuted: 0, unverified: 0, uncited: 1 },
      coverageRate: 2 / 3,
      verificationRate: 3 / 5,
      meanConfidence: 0.625,
      meanCalibrationGap: 0.125
    })
    expect(matrix.issues).toEqual([])
  })

  it('reports null rates for an empty matrix', () => {
    const { sources, summary } = buildDiscoverHypothesisMatrix([])
    expect(sources).toEqual([])
    expect(summary).toMatchObject({ coverageRate: null, verificationRate: null })
    expect(summary.meanConfidence).toBeNull()
  })
})

describe('readDiscoverHypothesisMatrix', () => {
  it('parses JSON into a matrix and carries parse issues through', () => {
    const cited = { id: 'a', claim: 'A', confidence: 60, citations: ['a.ts:1'] }
    const text = JSON.stringify({ hypotheses: [cited, { claim: '' }] })

    const matrix = readDiscoverHypothesisMatrix(text)

    expect(matrix.sources).toEqual(['a.ts'])
    expect(matrix.rows[0].coverage.verdict).toBe('unverified')
    expect(matrix.summary.meanConfidence).toBe(0.6)
    expect(matrix.issues).toEqual([{ path: 'hypotheses[1]', message: NEEDS_CLAIM }])
  })

  it('refuses oversized, malformed, too deep or misshapen documents', () => {
    const deep = `${'['.repeat(40)}${']'.repeat(40)}`
    expect(() => readDiscoverHypothesisMatrix('[]', 1)).toThrow(RangeError)
    expect(() => readDiscoverHypothesisMatrix('{"hypotheses":')).toThrow('not valid JSON')
    expect(() => readDiscoverHypothesisMatrix(deep)).toThrow(/nesting exceeds 32/)
    expect(() => readDiscoverHypothesisMatrix('{"items":[]}')).toThrow(/array or/)
  })
})
