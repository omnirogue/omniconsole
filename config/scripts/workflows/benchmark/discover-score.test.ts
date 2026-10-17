import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { QUICK_DISCOVER_RUN, RECORDED_DISCOVER_RUN, fakeRun, fakeTarget } from './benchmark-fakes'
import { matchTarget, parseLocations, scoreDiscoverRun, type AnswerKey } from './discover-score'

const setDir = join(__dirname, 'discover-seeded')
const key = JSON.parse(readFileSync(join(setDir, 'answer-key.json'), 'utf8')) as AnswerKey

describe('the seeded Discover answer key', () => {
  it('has 12 seeded bugs and 3 decoys, each range still holding its anchor in the fixture', () => {
    expect(key.entries.filter((entry) => entry.kind === 'bug')).toHaveLength(12)
    expect(key.entries.filter((entry) => entry.kind === 'decoy')).toHaveLength(3)
    for (const entry of key.entries) {
      const lines = readFileSync(join(setDir, 'fixture', entry.file), 'utf8').split('\n')
      const range = lines.slice(entry.lines[0] - 1, entry.lines[1]).join('\n')
      expect(range, `${entry.id} moved in ${entry.file}`).toContain(entry.anchor)
    }
  })
})

describe('matching a finding to the key', () => {
  it('reads path:line, ranges, "line N" and bare paths', () => {
    expect(parseLocations('src/orders.ts:53-58, orders.ts line 7, see src\\db.ts')).toEqual([
      { file: 'src/orders.ts', lines: [53, 58] },
      { file: 'orders.ts', lines: [7, 7] },
      { file: 'src/db.ts' }
    ])
  })

  it('credits only the same file, overlapping lines and defect-specific evidence', () => {
    const verdict = (location: string, title: string) =>
      matchTarget({ location, title, detail: '' }, key)
    expect(verdict('/abs/work/src/inventory.ts:55', 'Negative quantity increases stock')).toEqual({
      match: { id: 'B02', kind: 'bug' }
    })
    expect(verdict('src/inventory.ts:55', 'Concurrent reserve races and oversells').match?.id).toBe(
      'B01'
    )
    // Right file and defect but no lines: weak, listed for a person, not credited.
    expect(verdict('src/price-cache.ts', 'TTL seconds added to a milliseconds clock')).toEqual({
      adjudicate: { candidates: ['B06'], reason: 'no-lines' }
    })
    // Two entries fit equally: ambiguous, never credited.
    expect(verdict('src/job-queue.ts:86-90', 'Slot leak lets active exceed concurrency')).toEqual({
      adjudicate: { candidates: ['B09', 'B10'], reason: 'ambiguous' }
    })
    expect(verdict('src/db.ts:10', 'Rows are cloned')).toEqual({})
  })

  it('gives no credit without identifying the defect (review regressions)', () => {
    const verdict = (location: string, title: string) =>
      matchTarget({ location, title, detail: '' }, key)
    // No location at all.
    expect(verdict('', 'Stock update')).toEqual({})
    // The right lines, but nothing about the defect.
    expect(verdict('src/payments.ts:45', 'Needs cleanup')).toEqual({
      adjudicate: { candidates: ['B07'], reason: 'no-evidence' }
    })
    // A false alarm on the cache-key line.
    expect(verdict('src/price-cache.ts:33', 'The hit counter is not reset by clear()')).toEqual({
      adjudicate: { candidates: ['B05'], reason: 'no-evidence' }
    })
    const score = scoreDiscoverRun(
      fakeRun([
        fakeTarget('x1', '', 'Stock update'),
        fakeTarget('x2', 'src/payments.ts:45', 'Needs cleanup'),
        fakeTarget('x3', 'src/price-cache.ts:33', 'The hit counter is not reset by clear()')
      ]),
      key
    )
    expect(score).toMatchObject({ found: [], recall: 0, precisionUnique: 0, precisionPerTarget: 0 })
    expect(score.needsAdjudication.map((row) => row.candidates)).toEqual([['B07'], ['B05']])
    expect(score.otherFindings).toEqual([{ title: 'Stock update', location: '' }])
  })
})

describe('scoreDiscoverRun', () => {
  it('scores a recorded run: verdict groups, misses, decoys, precision, recall and ranking', () => {
    const score = scoreDiscoverRun(RECORDED_DISCOVER_RUN, key)
    expect(score.byVerdict).toEqual({
      confirmed: {
        targets: 9,
        seeded: ['B07', 'B01', 'B03', 'B05', 'B04', 'B08'],
        decoys: ['D01'],
        other: 1
      },
      refuted: { targets: 1, seeded: ['B10'], decoys: [], other: 0 },
      unverified: { targets: 1, seeded: ['B11'], decoys: [], other: 0 }
    })
    expect(score.found).toHaveLength(6)
    expect(score.recall).toBe(0.5)
    // Refuted B10 and unverified B11 count only here.
    expect(score.recallAnyVerdict).toBeCloseTo(8 / 12)
    // Per target the duplicate counts; per defect it counts in neither: 6 / (6 + 2).
    expect(score.precisionPerTarget).toBeCloseTo(7 / 9)
    expect(score.precisionUnique).toBeCloseTo(0.75)
    expect(score.duplicates).toBe(1)
    expect(score.needsAdjudication).toEqual([])
    expect(score.missed).toEqual(['B02', 'B06', 'B09', 'B10', 'B11', 'B12'])
    expect(score.missedEntirely).toEqual(['B02', 'B06', 'B09', 'B12'])
    expect(score.decoysFlagged).toEqual(['D01'])
    expect(score.otherFindings).toEqual([
      { title: 'newId counter is not unique across processes', location: 'src/db.ts:100-105' }
    ])
    expect(score.severityAgreement).toBe(1)
    expect(score.ranking.ranked).toEqual([
      'B07',
      'B01',
      'B03',
      'B05',
      'B04',
      'B03',
      null,
      null,
      'B08'
    ])
    expect(score.ranking.k).toBe(7)
    expect(score.ranking.highInTopK).toBe(4)
    expect(score.ranking.highSeverity).toContainEqual({
      id: 'B02',
      position: null
    })
  })

  it('scores a single-pass run (Quick Discover, all unverified) only by its any-verdict recall', () => {
    const score = scoreDiscoverRun(QUICK_DISCOVER_RUN, key)
    expect(score.byVerdict.unverified.seeded).toHaveLength(8)
    expect(score).toMatchObject({ found: [], recall: 0, precisionUnique: null, duplicates: 0 })
    expect(score.missed).toHaveLength(12)
    expect(score.missedEntirely).toEqual(['B02', 'B06', 'B09', 'B12'])
    expect(score.recallAnyVerdict).toBeCloseTo(8 / 12)
    expect(score.ranking.ranked).toHaveLength(10)
    expect(score.precisionAnyVerdict).toBeCloseTo(9 / 11)
    expect(score.decoysAnyVerdict).toEqual(['D01'])
    expect(score.byJudge.unreviewed.unverified).toBe(11)
  })

  it('takes the last round’s word on a target, and scores an empty run as finding nothing', () => {
    const later = fakeRun([
      fakeTarget('a', 'src/orders.ts:55', 'Missing await', { tally: 'unverified' }),
      fakeTarget('a', 'src/orders.ts:55', 'Missing await', { round: 2, tally: 'confirmed' })
    ])
    expect(scoreDiscoverRun(later, key).found).toEqual(['B03'])
    const empty = scoreDiscoverRun(fakeRun([]), key)
    expect(empty).toMatchObject({ targets: 0, precisionUnique: null, recall: 0, found: [] })
    expect(empty.missed).toHaveLength(12)
  })
})

it('scores the delivered report order and separates live JEV verdicts from reviewers', () => {
  const targets = [
    fakeTarget('bug', 'src/orders.ts:55', 'Missing await', {
      tally: 'refuted',
      jevVerify: 0.05,
      refutedBy: 'jev'
    }),
    fakeTarget('decoy', 'src/money.ts:58', 'allocate loop is off by one', {
      jevVerify: 0.95,
      confirmedBy: 'jev'
    }),
    fakeTarget('real', 'src/new.ts:1', 'New real finding')
  ]
  const run = fakeRun(targets)
  run.results.ranking = [
    { key: 'real', rank: 1, why: '', next: '' },
    { key: 'decoy', rank: 2, why: '', next: '' }
  ]
  const score = scoreDiscoverRun(run, key, { real: 'real' })
  expect(score.byJudge.jev).toEqual({
    confirmed: 1,
    refuted: 1,
    unverified: 0
  })
  expect(score.byJudge.reviewers.confirmed).toBe(1)
  expect(score.jevVerify).toMatchObject({ n: 2, decided: 2, correct: 0 })
  expect(score.jevVerify.brier).toBeCloseTo(0.9025)
  expect(score.precisionPerTarget).toBe(0)
  expect(score.precisionAdjudicated).toBe(0.5)
  expect(score.ranking.ranked).toEqual([null, null])
})

it('scores Report order even when it puts a lower-severity finding first', () => {
  const run = fakeRun([
    fakeTarget('critical', 'src/payments.ts:44-70', 'Capture failures swallowed and marked paid', { severity: 'critical' }),
    fakeTarget('await', 'src/orders.ts:55', 'Missing await', { severity: 'high' })
  ])
  run.results.ranking = [{ key: 'await', rank: 1, why: '', next: '' }, { key: 'critical', rank: 2, why: '', next: '' }]
  expect(scoreDiscoverRun(run, key).ranking.ranked).toEqual(['B03', 'B07'])
})
