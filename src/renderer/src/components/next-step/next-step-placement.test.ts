import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { findNextStepWorkspace } from './next-step-placement'

const source = { id: 'source', repoId: 'r', path: '/local', hostId: 'local', branch: 'main' }
function state(patch: Record<string, unknown> = {}): AppState {
  const base = {
    source,
    repos: [
      { id: 'r', gitRemoteIdentity: { canonicalKey: 'gitlab.com/team/app' } },
      {
        id: 'remote-r',
        gitRemoteIdentity: { canonicalKey: 'gitlab.com/team/app' },
        executionHostId: 'ssh:server'
      }
    ],
    worktreesByRepo: { r: [source] },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    ...patch
  } as unknown as Record<string, never>
  // Why: mirrors the store's cached getter — one stable object per folder workspace.
  const cache = new Map<string, unknown>()
  const known = (id: string): unknown => {
    if (id === 'source') {
      return base.source
    }
    const listed = [
      ...Object.values(base.worktreesByRepo as Record<string, { id: string }[]>).flat(),
      ...Object.values(
        base.detectedWorktreesByRepo as Record<string, { worktrees: { id: string }[] }>
      ).flatMap((result) => result.worktrees)
    ].find((entry) => entry.id === id)
    if (listed) {
      return listed
    }
    const folder = (base.folderWorkspaces as { id: string }[]).find(
      (workspace) => `folder:${workspace.id}` === id
    )
    if (!folder) {
      return undefined
    }
    if (!cache.has(id)) {
      cache.set(id, folderWorkspaceToWorktree(folder as never))
    }
    return cache.get(id)
  }
  return { ...base, getKnownWorktreeById: known } as unknown as AppState
}
describe('next step placement workspace', () => {
  it('never substitutes a local workspace for an unknown host', () => {
    expect(findNextStepWorkspace(state(), 'source', 'ssh:server')).toBeNull()
  })
  it('matches the same provider-neutral repo on the chosen host', () => {
    const remote = { id: 'remote', repoId: 'remote-r', path: '/remote', hostId: 'ssh:server' }
    expect(
      findNextStepWorkspace(
        state({ worktreesByRepo: { r: [source], remote: [remote] } }),
        'source',
        'ssh:server'
      )
    ).toBe(remote)
  })
  it('finds detected worktrees and respects their host stamp', () => {
    const remote = { id: 'remote', repoId: 'r', path: '/remote', hostId: 'runtime:server' }
    const input = state({ detectedWorktreesByRepo: { r: { worktrees: [remote] } } })
    expect(findNextStepWorkspace(input, 'source', 'runtime:server')).toBe(remote)
    expect(findNextStepWorkspace(input, 'source', 'ssh:server')).toBeNull()
  })
  it('keeps the source workspace when it already runs on the chosen computer', () => {
    const other = { id: 'other', repoId: 'r', path: '/other', hostId: 'local', branch: 'feature' }
    const input = state({ worktreesByRepo: { r: [other, source] } })
    expect(findNextStepWorkspace(input, 'source', 'local')).toBe(source)
  })
  it('prefers the source branch over another checkout on the chosen computer', () => {
    const wrong = {
      id: 'wrong',
      repoId: 'remote-r',
      path: '/wrong',
      hostId: 'ssh:server',
      branch: 'other'
    }
    const right = {
      id: 'right',
      repoId: 'remote-r',
      path: '/right',
      hostId: 'ssh:server',
      branch: 'main'
    }
    const input = state({ worktreesByRepo: { r: [source], remote: [wrong, right] } })
    expect(findNextStepWorkspace(input, 'source', 'ssh:server')).toBe(right)
  })
  it('finds a folder workspace in the same project group', () => {
    const input = folderState()
    expect(findNextStepWorkspace(input, 'source', 'ssh:server')).toMatchObject({
      id: 'folder:folder',
      path: '/remote',
      hostId: 'ssh:server'
    })
  })
  // Why: a fresh object per call makes a zustand selector re-render forever (React #185).
  it('returns the same workspace object for a folder workspace on every call', () => {
    const input = folderState()
    expect(findNextStepWorkspace(input, 'source', 'ssh:server')).toBe(
      findNextStepWorkspace(input, 'source', 'ssh:server')
    )
  })
})

function folderState(): AppState {
  return state({
    source: { ...source, repoId: 'folder-workspace:project' },
    folderWorkspaces: [
      {
        id: 'folder',
        projectGroupId: 'project',
        name: 'App',
        folderPath: '/remote',
        executionHostId: 'ssh:server'
      }
    ]
  })
}
