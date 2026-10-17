import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { SessionProjectThread } from './session-project-threads'
import {
  sessionProjectThreadOutputsLookup,
  type SessionProjectOutputsState
} from './session-project-thread-outputs'

vi.mock('@/components/dashboard/dashboard-card-context', () => ({
  resolveWorktreeHostedReview: (_state: unknown, repo: { executionHostId?: string }) =>
    repo.executionHostId === 'runtime:studio'
      ? {
          provider: 'gitlab',
          number: 92,
          state: 'draft',
          url: 'https://gitlab.example/team/repo/-/merge_requests/92',
          status: 'pending'
        }
      : {
          provider: 'github',
          number: 31,
          state: 'open',
          url: 'https://github.example/team/repo/pull/31',
          status: 'failure'
        }
}))

const thread = (hostId: ExecutionHostId): SessionProjectThread =>
  ({
    row: { session: { worktreeId: 'shared', hostId } },
    isCoordinator: false,
    status: 'done',
    agent: 'codex',
    lastActivityAt: null
  }) as SessionProjectThread

function state(
  worktrees = [
    { id: 'shared', repoId: 'repo', hostId: 'local' },
    { id: 'shared', repoId: 'repo', hostId: 'runtime:studio' }
  ]
): SessionProjectOutputsState {
  return {
    repos: [{ id: 'repo' }, { id: 'repo', executionHostId: 'runtime:studio' }],
    worktreesByRepo: { repo: worktrees },
    hostedReviewCache: {},
    prCache: {},
    settings: null
  } as unknown as SessionProjectOutputsState
}

describe('project thread output ownership', () => {
  it('uses the selected row owner when repo and worktree ids collide', () => {
    const outputs = sessionProjectThreadOutputsLookup(state())
    expect(outputs(thread('local'))).toEqual([
      {
        kind: 'review',
        label: '#31',
        state: 'open',
        url: 'https://github.example/team/repo/pull/31',
        checks: 'failure'
      }
    ])
    expect(outputs(thread('runtime:studio'))).toEqual([
      {
        kind: 'review',
        label: '!92',
        state: 'draft',
        url: 'https://gitlab.example/team/repo/-/merge_requests/92',
        checks: 'pending'
      }
    ])
    expect(outputs(thread('runtime:other'))).toEqual([])
  })

  it('does not infer an owner for a legacy worktree with duplicate repo ids', () => {
    const inputs = state()
    inputs.worktreesByRepo.repo = [{ id: 'shared', repoId: 'repo' }] as never
    const outputs = sessionProjectThreadOutputsLookup(inputs)
    expect(outputs(thread('local'))).toEqual([])
    expect(outputs(thread('runtime:studio'))).toEqual([])
  })

  it('refuses duplicate matches on the same host', () => {
    const worktree = { id: 'shared', repoId: 'repo', hostId: 'local' }
    expect(sessionProjectThreadOutputsLookup(state([worktree, worktree]))(thread('local'))).toEqual(
      []
    )
  })
})
