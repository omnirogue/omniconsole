import { describe, expect, it } from 'vitest'
import type { ArtifactReviewStatus } from './artifact-review'
import type { DiscoverOmniosRun } from './discover-omnios-page'
import { discoverOmniosPicks } from './discover-omnios-picks'

const run = {
  findings: Array.from({ length: 11 }, (_, i) => ({
    n: i + 1,
    key: `k${i + 1}`,
    title: `Title ${i + 1}`,
    recommended: i < 3 ? 'Start' : 'Not now'
  }))
} as DiscoverOmniosRun
function status(edits: unknown = null): ArtifactReviewStatus {
  return {
    status: 'approved',
    artifact: { revision: 2 },
    latest: {
      id: 'd1',
      revision: 2,
      decision: 'approved',
      edits
    }
  } as ArtifactReviewStatus
}

describe('saved Discover picks', () => {
  it('carries all eight selected options and never adds unticked defaults', () => {
    expect(
      discoverOmniosPicks(run, status({ selected: [1, 2, 3, 4, 5, 6, 7, 8] }), 1).picks
    ).toEqual(run.findings.slice(0, 8).map(({ n, key }) => ({ n, key, pick: 'Start' })))
    expect(
      discoverOmniosPicks(run, status({ selected: [4, 8] }), 1)
        .picks.filter((p) => p.pick === 'Start')
        .map((p) => p.n)
    ).toEqual([4, 8])
    expect(
      discoverOmniosPicks(run, status({ selected: [] }), 1).picks.every((p) => p.pick === 'Not now')
    ).toBe(true)
  })

  it('maps second-page indices to global finding numbers without acting on the first page', () => {
    expect(discoverOmniosPicks(run, status({ selected: [1, 3] }), 2).picks).toEqual([
      { n: 9, key: 'k9', pick: 'Start' },
      { n: 10, key: 'k10', pick: 'Not now' },
      { n: 11, key: 'k11', pick: 'Start' }
    ])
  })

  it('keeps every structured choice and supports older named field edits', () => {
    const picks = run.findings
      .slice(0, 8)
      .map(({ n, key }) => ({ n, key, pick: n === 2 ? 'Dig deeper' : 'Not now' }))
    expect(discoverOmniosPicks(run, status({ picks }), 1).picks).toEqual(picks)
    expect(
      discoverOmniosPicks(run, status({ '1. Title 1': 'Not now', '8. Title 8': 'Start' }), 1)
        .picks[7].pick
    ).toBe('Start')
  })

  it('refuses a stale, rejected, closed or incomplete answer and invalid/duplicate picks', () => {
    for (const answer of [
      { ...status(), status: 'pending' },
      { ...status(), artifact: { revision: 3 } },
      { ...status(), lifecycle: 'done' },
      { ...status(), artifact: { revision: 2, lifecycle: 'done' } },
      { ...status(), artifact: { revision: 2, supersededBy: 'new' } },
      { ...status(), supersededBy: 'new' }
    ]) {
      expect(() => discoverOmniosPicks(run, answer as ArtifactReviewStatus, 1)).toThrow()
    }
    for (const edits of [
      'Start all',
      { selected: 'all' },
      { picks: [{ n: 1, pick: 'Start' }] },
      { picks: [] },
      { selected: [1, 1] },
      { selected: [9] },
      { selected: ['1'] },
      { selected: [1.5] },
      { '1. Title 1': 'Delete' },
      { '9. Wrong': 'Start' }
    ]) {
      expect(() => discoverOmniosPicks(run, status(edits), 1)).toThrow()
    }
  })
})
