import { describe, expect, it } from 'vitest'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'
import {
  getWorkspaceCleanupUnfinishedWork,
  orderUnfinishedWorkFirst
} from './workspace-cleanup-unfinished-work'
import { queryWorkspaceCleanupCandidates } from './workspace-cleanup-query'
import { createDefaultWorkspaceCleanupBrowseState } from '../../../../shared/workspace-cleanup-browse-state'

const clean = makeCandidate({ worktreeId: 'repo-1::/repo/clean', path: '/repo/clean' })
const dirty = makeCandidate({
  worktreeId: 'repo-1::/repo/dirty',
  path: '/repo/dirty',
  git: { clean: false, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 },
  blockers: ['dirty-files']
})
const unpushed = makeCandidate({
  worktreeId: 'repo-1::/repo/unpushed',
  path: '/repo/unpushed',
  git: { clean: true, upstreamAhead: 2, upstreamBehind: 0, checkedAt: 1 },
  blockers: ['unpushed-commits']
})
const running = makeCandidate({
  worktreeId: 'repo-1::/repo/running',
  path: '/repo/running',
  blockers: ['running-terminal']
})

describe('getWorkspaceCleanupUnfinishedWork', () => {
  it('names uncommitted changes, unpushed commits, open reviews and running terminals', () => {
    expect(getWorkspaceCleanupUnfinishedWork(clean)).toEqual([])
    expect(getWorkspaceCleanupUnfinishedWork(dirty)).toEqual(['uncommitted-changes'])
    expect(getWorkspaceCleanupUnfinishedWork(unpushed)).toEqual(['unpushed-commits'])
    expect(getWorkspaceCleanupUnfinishedWork(running)).toEqual(['running'])
    expect(getWorkspaceCleanupUnfinishedWork(clean, { hasReview: true, state: 'open' })).toEqual([
      'open-review'
    ])
    expect(getWorkspaceCleanupUnfinishedWork(clean, { hasReview: true, state: 'merged' })).toEqual(
      []
    )
  })

  it('moves rows with unfinished work to the front without reordering either part', () => {
    expect(
      orderUnfinishedWorkFirst([clean, dirty, running, unpushed], (row) => row !== clean)
    ).toEqual([dirty, running, unpushed, clean])
  })
})

describe('guided cleanup list', () => {
  it('lists workspaces with unfinished work first and never includes them in Select all', () => {
    const result = queryWorkspaceCleanupCandidates(
      [clean, dirty, unpushed, running],
      {
        filters: createDefaultWorkspaceCleanupBrowseState().filters,
        sort: createDefaultWorkspaceCleanupBrowseState().sort
      },
      {},
      1
    )
    const ids = result.rows.map((row) => row.worktreeId)
    expect(ids.indexOf(clean.worktreeId)).toBe(ids.length - 1)
    expect(result.selectableIdentities.some((identity) => identity.endsWith('/repo/dirty'))).toBe(
      false
    )
    expect(
      result.selectableIdentities.some((identity) => identity.endsWith('/repo/unpushed'))
    ).toBe(false)
    expect(result.selectableIdentities.some((identity) => identity.endsWith('/repo/clean'))).toBe(
      true
    )
  })

  it('keeps an unverified push and an unchecked review out of Select all (R5, R6)', () => {
    const unverified = makeCandidate({
      worktreeId: 'repo-1::/repo/unverified',
      path: '/repo/unverified',
      blockers: ['unknown-base']
    })
    expect(getWorkspaceCleanupUnfinishedWork(unverified)).toEqual(['unverified-push'])
    expect(getWorkspaceCleanupUnfinishedWork(clean, { hasReview: true, state: 'unknown' })).toEqual(
      ['open-review']
    )
    const result = queryWorkspaceCleanupCandidates(
      [clean, unverified],
      {
        filters: createDefaultWorkspaceCleanupBrowseState().filters,
        sort: createDefaultWorkspaceCleanupBrowseState().sort
      },
      {},
      1
    )
    expect(
      result.selectableIdentities.some((identity) => identity.endsWith('/repo/unverified'))
    ).toBe(false)
  })
})
