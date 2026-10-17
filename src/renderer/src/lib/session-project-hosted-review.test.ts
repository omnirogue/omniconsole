import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { SessionSidebarTreeRow } from './session-sidebar-group-model'
import type { ExecutionHostId } from '../../../shared/execution-host'

const reviews = vi.hoisted(() => new Map<string, string>())
vi.mock('@/components/dashboard/dashboard-card-context', () => ({
  resolveWorktreeHostedReview: (
    _state: unknown,
    repo: { id: string; executionHostId?: string } | null,
    worktree: { id: string }
  ) => {
    const key = repo?.executionHostId ? `${repo.executionHostId}:${worktree.id}` : worktree.id
    return repo && reviews.has(key) ? { state: reviews.get(key) } : undefined
  }
}))

const { sessionHostedReviewLookup } = await import('./session-project-hosted-review')

const row = (worktreeId: string, hostId: ExecutionHostId = 'local') =>
  ({ session: { worktreeId, hostId } }) as unknown as SessionSidebarTreeRow

describe('sessionHostedReviewLookup', () => {
  it('keeps reviews scoped to the row owner when repo and worktree IDs collide across hosts', () => {
    reviews.set('shared', 'merged').set('runtime:remote:shared', 'open')
    const state = {
      repos: [{ id: 'repo-a' }, { id: 'repo-a', executionHostId: 'runtime:remote' }],
      worktreesByRepo: {
        'repo-a': [
          { id: 'shared', repoId: 'repo-a', hostId: 'local' },
          { id: 'shared', repoId: 'repo-a', hostId: 'runtime:remote' }
        ]
      },
      hostedReviewCache: {},
      prCache: {},
      settings: null
    } as unknown as AppState
    const lookup = sessionHostedReviewLookup(state)
    expect(lookup(row('shared'))).toBe(false)
    expect(lookup(row('shared', 'runtime:remote'))).toBe(true)
    state.worktreesByRepo['repo-a'] = [{ id: 'shared', repoId: 'repo-a' }] as never
    expect(sessionHostedReviewLookup(state)(row('shared', 'runtime:remote'))).toBe(false)
  })

  it('is true only for an open or draft review on the row’s own worktree', () => {
    reviews.set('open', 'open').set('draft', 'draft').set('merged', 'merged')
    const lookup = sessionHostedReviewLookup({
      repos: [{ id: 'repo-a' }],
      worktreesByRepo: {
        'repo-a': ['open', 'draft', 'merged', 'none'].map((id) => ({
          id,
          repoId: 'repo-a'
        }))
      },
      hostedReviewCache: {},
      prCache: {},
      settings: null
    } as unknown as AppState)
    expect(['open', 'draft', 'merged', 'none', 'unknown'].map((id) => lookup(row(id)))).toEqual([
      true,
      true,
      false,
      false,
      false
    ])
  })
})
