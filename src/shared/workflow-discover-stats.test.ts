import { describe, expect, it } from 'vitest'
import {
  discoverBlindReview,
  discoverStats,
  discoverStatsExportSchema,
  mergeDiscoverExports,
  type DiscoverStatsRun
} from './workflow-discover-stats'

const run = (extra: Partial<DiscoverStatsRun> = {}): DiscoverStatsRun => ({
  host: 'studio',
  runId: '00000000-0000-4000-8000-000000000001',
  template: 'discover',
  at: 1,
  state: 'completed',
  degraded: true,
  substitutions: 1,
  delivery: 'pending',
  rounds: [
    { round: 1, newFindings: 2, confirmed: 1 },
    { round: 2, newFindings: 1, confirmed: 0 }
  ],
  calls: [
    { id: 'find/r1/a0', step: 'find', round: 1, model: 'planned', lens: 'Safety', costUsd: 0.2 },
    {
      id: 'find/r1/a0~codex',
      step: 'find',
      round: 1,
      model: 'actual',
      lens: 'Safety',
      costUsd: 0.3
    },
    {
      id: 'verify/r1/a0',
      step: 'verify',
      round: 1,
      model: 'verifier',
      lens: '',
      costUsd: 'unknown'
    }
  ],
  findings: [
    {
      key: 'f1',
      round: 1,
      tally: 'confirmed',
      title: 'Claim one',
      detail: 'Evidence one',
      location: 'one.ts:1',
      sourceCallId: 'find/r1/a0',
      alsoFrom: ['find/r1/a0'],
      label: { pick: 'Start', outcome: 'launched' }
    },
    {
      key: 'f2',
      round: 1,
      tally: 'refuted',
      title: 'Claim two',
      detail: 'Evidence two',
      location: 'two.ts:2',
      label: { pick: 'Dig deeper', outcome: 'failed' }
    }
  ],
  ...extra
})

describe('Discover cross-run measurements', () => {
  it('22, 43, 46, 47: separates round yield, partial costs, reliability, actual finder identity and behavioral labels', () => {
    const stats = discoverStats({ version: 1, runs: [run()], unreadable: 2 })
    expect(stats.rounds).toEqual([
      { round: 1, runs: 1, newFindings: 2, confirmed: 1 },
      { round: 2, runs: 1, newFindings: 1, confirmed: 0 }
    ])
    expect(stats.cost).toEqual({ costUsd: 0.5, knownCalls: 2, unknownCalls: 1, partial: true })
    expect(stats.outcomes).toEqual({
      states: { completed: 1 },
      delivery: { pending: 1 },
      degraded: 1,
      substitutions: 1
    })
    expect(stats.contributors).toContainEqual({
      lens: 'Safety',
      model: 'actual',
      reported: 1,
      confirmed: 1
    })
    expect(stats.labels.Start.launched).toBe(1)
    expect(stats.labels['Dig deeper'].failed).toBe(1)
    expect(stats.precision).toBe('unknown')
  })
  it('73: merges distinct hosts, deduplicates identical identities and rejects conflicts or malformed exports', () => {
    const data = { version: 1 as const, runs: [run()], unreadable: 0 }
    const merged = mergeDiscoverExports([data, data, { ...data, runs: [run({ host: 'fleet' })] }])
    expect(discoverStats(merged).runs).toBe(2)
    expect(
      mergeDiscoverExports([
        { ...data, unreadable: 2 },
        { ...data, unreadable: 2 }
      ]).unreadable
    ).toBe(2)
    expect(() =>
      mergeDiscoverExports([data, { ...data, runs: [run({ delivery: 'published' })] }])
    ).toThrow('Conflicting exports')
    expect(discoverStatsExportSchema.safeParse({ ...data, version: 2 }).success).toBe(false)
  })
  it('47: samples both verdicts deterministically while hiding verdicts, votes, models and picks', () => {
    const data = { version: 1 as const, runs: [run()], unreadable: 0 }
    const sample = discoverBlindReview(data, 1)
    expect(sample).toEqual(discoverBlindReview(data, 1))
    expect(sample.samples.map((row) => row.title).sort()).toEqual(['Claim one', 'Claim two'])
    for (const row of sample.samples) {
      expect(Object.keys(row).sort()).toEqual(['detail', 'location', 'sampleId', 'title'])
    }
    expect(
      discoverBlindReview({ ...data, runs: [run({ goal: 'Check safety', workspace: 'repo' })] }, 1)
        .samples[0]
    ).toMatchObject({ goal: 'Check safety', workspace: 'repo' })
    expect(JSON.stringify(sample.samples)).not.toMatch(
      /confirmed|refuted|Safety|actual|Start|Dig deeper/
    )
  })
  it('keeps entirely missing bills unknown and explicitly partial attempt totals partial', () => {
    expect(
      discoverStats({ version: 1, unreadable: 0, runs: [run({ calls: [] })] }).cost.costUsd
    ).toBe('unknown')
    const stats = discoverStats({
      version: 1,
      unreadable: 0,
      runs: [
        run({
          calls: [
            {
              id: 'find/a0',
              step: 'find',
              round: 0,
              model: 'x',
              lens: '',
              costUsd: 1,
              costPartial: true
            }
          ]
        })
      ]
    })
    expect(stats.cost).toMatchObject({ costUsd: 1, partial: true })
  })
})
