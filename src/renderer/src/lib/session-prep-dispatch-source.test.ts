import { describe, expect, it } from 'vitest'
import { sessionPrepDispatchSourceIn } from './session-prep-dispatch-source'
import type { WorktreeOperationRouteState } from './worktree-operation-route'

const worktreeId = 'repo::/work/checkout'
const local: WorktreeOperationRouteState = {
  repos: [{ id: 'repo', executionHostId: 'local' }],
  worktreesByRepo: { repo: [{ id: worktreeId, repoId: 'repo', hostId: 'local' }] }
}

describe('project prep source ownership', () => {
  it('keeps a local checkout and normalizes an attached folder selector for the main catalog', () => {
    expect(sessionPrepDispatchSourceIn(local, worktreeId)).toBe(worktreeId)
    expect(
      sessionPrepDispatchSourceIn(
        {
          folderWorkspaces: [{ id: 'plain', projectGroupId: 'work', executionHostId: 'local' }]
        },
        'folder:plain'
      )
    ).toBe('plain')
  })

  it('keeps a controller-owned SSH checkout on its explicit host', () => {
    expect(
      sessionPrepDispatchSourceIn(
        {
          repos: [{ id: 'repo', executionHostId: 'ssh:studio', connectionId: 'studio' }],
          worktreesByRepo: { repo: [{ id: worktreeId, repoId: 'repo', hostId: 'ssh:studio' }] }
        },
        worktreeId
      )
    ).toBe(worktreeId)
  })

  it('refuses paired checkouts, paired folders, and SSH reached through a paired controller', () => {
    for (const hostId of ['runtime:studio', 'ssh:studio'] as const) {
      expect(
        sessionPrepDispatchSourceIn(
          {
            repos: [{ id: 'repo', executionHostId: hostId, connectionId: 'studio' }],
            worktreesByRepo: {
              repo: [
                { id: worktreeId, repoId: 'repo', hostId, runtimeOwnerEnvironmentId: 'paired' }
              ]
            }
          },
          worktreeId
        )
      ).toBeNull()
    }
    expect(
      sessionPrepDispatchSourceIn(
        {
          folderWorkspaces: [
            { id: 'plain', projectGroupId: 'work', executionHostId: 'runtime:studio' }
          ]
        },
        'folder:plain'
      )
    ).toBeNull()
  })

  it('refuses missing or ambiguous catalogs and a selected host that disagrees with the controller', () => {
    expect(sessionPrepDispatchSourceIn({}, worktreeId)).toBeNull()
    expect(
      sessionPrepDispatchSourceIn(
        { ...local, repos: [...local.repos!, ...local.repos!] },
        worktreeId
      )
    ).toBeNull()
    expect(
      sessionPrepDispatchSourceIn(
        {
          ...local,
          activeWorktreeId: worktreeId,
          activeWorkspaceExecutionHostId: 'runtime:studio'
        },
        worktreeId
      )
    ).toBeNull()
  })
})
