import { describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { MergeAllRun } from '../../github/merge-when-ready/merge-when-ready-actions'
import {
  countMergeAllPreview,
  countMergeAllResults,
  groupMergeAllCandidates,
  type MergeAllGroup
} from './merge-all-when-ready-groups'

function item(overrides: Partial<GitHubWorkItem>): GitHubWorkItem {
  return {
    id: `id-${overrides.number}`,
    type: 'pr',
    number: 1,
    title: 'PR',
    state: 'open',
    url: 'https://github.com/omnirogue/omnirogue/pull/1',
    labels: [],
    updatedAt: '2026-10-13T09:00:00Z',
    author: 'sal',
    repoId: 'repo-a',
    ...overrides
  }
}

const group: MergeAllGroup = {
  key: 'github.com/acme/omni|repo-a',
  slug: { owner: 'acme', repo: 'omni', host: 'github.com' },
  repoId: 'repo-a',
  numbers: [1, 2, 3]
}

describe('groupMergeAllCandidates', () => {
  it('groups open and draft PRs by GitHub repo and local repo, in list order', () => {
    const groups = groupMergeAllCandidates([
      item({ number: 5, url: 'https://github.com/omnirogue/omnirogue/pull/5' }),
      item({ number: 9, state: 'draft', url: 'https://github.com/omnirogue/omnirogue/pull/9' }),
      item({ number: 2, url: 'https://github.com/omnirogue/betacorp/pull/2' }),
      item({ number: 5, url: 'https://github.com/omnirogue/omnirogue/pull/5' }),
      item({ number: 7, repoId: 'repo-b', url: 'https://github.com/omnirogue/omnirogue/pull/7' })
    ])

    expect(groups.map((g) => [g.slug.repo, g.repoId, g.numbers])).toEqual([
      ['omnirogue', 'repo-a', [5, 9]],
      ['betacorp', 'repo-a', [2]],
      ['omnirogue', 'repo-b', [7]]
    ])
    expect(groups[0].slug).toEqual({ owner: 'omnirogue', repo: 'omnirogue', host: 'github.com' })
  })

  it('leaves out issues, closed and merged PRs, and PRs with no GitHub repo', () => {
    expect(
      groupMergeAllCandidates([
        item({ number: 1, type: 'issue' }),
        item({ number: 2, state: 'closed' }),
        item({ number: 3, state: 'merged' }),
        item({ number: 4, url: 'not a url' })
      ])
    ).toEqual([])
  })
})

describe('counting', () => {
  it('counts unreadable groups by their listed PRs', () => {
    expect(
      countMergeAllPreview([
        { group, plan: null, error: 'offline' },
        {
          group,
          plan: { arm: [], skip: [{ number: 4, title: '', reason: { kind: 'armed' } }] },
          error: null
        }
      ])
    ).toEqual({ arm: 0, skip: 1, unreadable: 3 })
  })

  it('counts a group that failed before any write as failed for every requested PR', () => {
    const run: MergeAllRun = {
      plan: { arm: [], skip: [{ number: 3, title: '', reason: { kind: 'not-open' } }] },
      armed: [1],
      failed: [{ number: 2, title: '', message: 'no' }],
      unverified: []
    }
    expect(
      countMergeAllResults([
        { group, requested: [1, 2, 3], run, error: null },
        { group, requested: [8, 9], run: null, error: 'offline' }
      ])
    ).toEqual({ armed: 1, failed: 3, unverified: 0, skipped: 1 })
  })
})
