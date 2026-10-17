import { describe, expect, it } from 'vitest'
import {
  attributeMergeHolds,
  findMergeWhenReadyBlockers,
  mergeWhenReadyStatus,
  type MergeWhenReadyPullRequestFacts
} from './merge-when-ready-facts'

const BOX = '- [ ] **Merge when ready** (Sal or Uma: tick to merge)'

function facts(
  overrides: Partial<MergeWhenReadyPullRequestFacts> = {}
): MergeWhenReadyPullRequestFacts {
  return {
    number: 1,
    title: 'Fix refunds',
    body: `${BOX}\n\nBody`,
    state: 'open',
    isDraft: false,
    url: 'https://github.com/acme/omni/pull/1',
    author: 'opener',
    createdAt: '2026-10-12T09:00:00Z',
    baseRefName: 'prod-omnirogue',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    labels: [],
    checks: [],
    labelEvents: [],
    titleEvents: [],
    olderEventsOmitted: false,
    ...overrides
  }
}

describe('mergeWhenReadyStatus', () => {
  it('arms only open PRs that carry the box', () => {
    expect(mergeWhenReadyStatus(facts())).toEqual({ kind: 'ready' })
    expect(mergeWhenReadyStatus(facts({ body: BOX.replace('[ ]', '[x]') }))).toEqual({
      kind: 'armed'
    })
    expect(mergeWhenReadyStatus(facts({ body: 'no box' }))).toEqual({ kind: 'no-box' })
    expect(mergeWhenReadyStatus(facts({ state: 'merged' }))).toEqual({ kind: 'not-open' })
  })

  it('reports holds with who set them', () => {
    expect(
      mergeWhenReadyStatus(
        facts({
          labels: ['do-not-merge'],
          labelEvents: [
            { label: 'do-not-merge', login: 'first', at: '2026-10-12T10:00:00Z' },
            { label: 'preview-off', login: 'other', at: '2026-10-12T10:30:00Z' },
            { label: 'do-not-merge', login: 'uma', at: '2026-10-12T11:00:00Z' }
          ]
        })
      )
    ).toEqual({
      kind: 'held',
      holds: [{ kind: 'label', label: 'do-not-merge', by: 'uma', at: '2026-10-12T11:00:00Z' }]
    })
  })
})

describe('attributeMergeHolds', () => {
  it('credits a title hold to the rename that added it', () => {
    expect(
      attributeMergeHolds(
        facts({
          title: 'Fix refunds - do not merge yet',
          titleEvents: [
            {
              previousTitle: 'Fix refund',
              currentTitle: 'Fix refunds',
              login: 'a',
              at: '2026-10-12T10:00:00Z'
            },
            {
              previousTitle: 'Fix refunds',
              currentTitle: 'Fix refunds - do not merge yet',
              login: 'sal',
              at: '2026-10-12T11:00:00Z'
            }
          ]
        })
      )
    ).toEqual([
      { kind: 'title', phrase: 'do not merge yet', by: 'sal', at: '2026-10-12T11:00:00Z' }
    ])
  })

  it('credits a title hold the PR was opened with to its author', () => {
    expect(attributeMergeHolds(facts({ title: '[DO NOT MERGE] Fix refunds' }))).toEqual([
      { kind: 'title', phrase: 'DO NOT MERGE', by: 'opener', at: '2026-10-12T09:00:00Z' }
    ])
  })

  it('does not credit the author when older title changes were cut off', () => {
    expect(
      attributeMergeHolds(
        facts({
          title: '[DO NOT MERGE] Fix refunds',
          olderEventsOmitted: true,
          titleEvents: [
            {
              previousTitle: '[DO NOT MERGE] Fix refund',
              currentTitle: '[DO NOT MERGE] Fix refunds',
              login: 'a',
              at: '2026-10-12T10:00:00Z'
            }
          ]
        })
      )
    ).toEqual([{ kind: 'title', phrase: 'DO NOT MERGE', by: null, at: null }])
  })

  it('says nothing about who when the history does not show it', () => {
    expect(attributeMergeHolds(facts({ labels: ['do-not-merge'] }))).toEqual([
      { kind: 'label', label: 'do-not-merge', by: null, at: null }
    ])
  })
})

describe('findMergeWhenReadyBlockers', () => {
  it('lists what stands between an armed PR and its merge', () => {
    expect(
      findMergeWhenReadyBlockers(
        facts({
          isDraft: true,
          mergeable: 'CONFLICTING',
          mergeStateStatus: 'DIRTY',
          checks: [
            { name: 'Tests', state: 'failure' },
            { name: 'Tests', state: 'pending' },
            { name: 'Lint', state: 'failure' },
            { name: 'Cleanup', state: 'neutral' }
          ]
        })
      )
    ).toEqual([
      { kind: 'draft' },
      { kind: 'conflicts', base: 'prod-omnirogue' },
      { kind: 'checks-failing', names: ['Lint'] },
      { kind: 'checks-running', names: ['Tests'] }
    ])
  })

  it('reports behind and otherwise-unexplained blocked states', () => {
    expect(findMergeWhenReadyBlockers(facts({ mergeStateStatus: 'BEHIND' }))).toEqual([
      { kind: 'behind', base: 'prod-omnirogue' }
    ])
    expect(findMergeWhenReadyBlockers(facts({ mergeStateStatus: 'BLOCKED' }))).toEqual([
      { kind: 'blocked' }
    ])
    expect(findMergeWhenReadyBlockers(facts())).toEqual([])
  })
})
