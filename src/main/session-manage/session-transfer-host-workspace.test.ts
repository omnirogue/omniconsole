import { describe, expect, it } from 'vitest'
import {
  resolveHostMoveWorkspace,
  type HostMoveRepo,
  type HostMoveWorkspaceInput
} from './session-transfer-host-workspace'

const HOST = 'ssh:mw0002'
const localRepo: HostMoveRepo = {
  id: 'local-repo',
  label: 'omni-ide',
  hostId: 'local',
  identity: 'github:omnirogue/omni-ide'
}
const hostRepo: HostMoveRepo = { ...localRepo, id: 'host-repo', hostId: HOST }

function input(overrides: Partial<HostMoveWorkspaceInput> = {}): HostMoveWorkspaceInput {
  return {
    hostId: HOST,
    label: 'mw0002',
    sourceRepos: [localRepo],
    sourceTitles: ['Parser fix'],
    branch: 'feat/parser',
    upstream: 'origin/feat/parser',
    repos: [localRepo, hostRepo],
    worktrees: [
      {
        id: 'host-repo::/work/main',
        repoId: 'host-repo',
        path: '/work/main',
        branch: 'refs/heads/main',
        hostId: HOST,
        name: 'main'
      },
      {
        id: 'host-repo::/work/parser',
        repoId: 'host-repo',
        path: '/work/parser',
        branch: 'refs/heads/feat/parser',
        hostId: HOST,
        name: 'parser'
      }
    ],
    sessions: [],
    ...overrides
  }
}

describe('the workspace a moved session continues in', () => {
  it('picks the one workspace of the same repository with the source branch checked out', () => {
    expect(resolveHostMoveWorkspace(input())).toEqual({
      id: 'host-repo::/work/parser',
      path: '/work/parser',
      branch: 'feat/parser',
      name: 'parser'
    })
  })

  it('refuses when no workspace has the branch, naming the exact create command', () => {
    const refusal = () =>
      resolveHostMoveWorkspace(input({ branch: 'fix/login', upstream: 'origin/fix/login' }))
    expect(refusal).toThrow(
      'omni worktree create --repo id:host-repo --name login --base-branch origin/fix/login --no-parent --json'
    )
    expect(refusal).toThrow('Nothing was changed.')
  })

  it('refuses when the host has no copy of the repository, naming the app setup step', () => {
    expect(() => resolveHostMoveWorkspace(input({ repos: [localRepo], worktrees: [] }))).toThrow(
      /mw0002 \(ssh:mw0002\) has no copy of omni-ide set up.*OmniConsole app/
    )
  })

  it('never shares a workspace that already has an open session', () => {
    const sessions = [{ worktreeId: 'host-repo::/work/parser', title: 'Build', archived: false }]
    expect(() => resolveHostMoveWorkspace(input({ sessions }))).toThrow(
      '/work/parser on mw0002 (ssh:mw0002) already has an open session (“Build”)'
    )
    const archived = [{ ...sessions[0], archived: true }]
    expect(resolveHostMoveWorkspace(input({ sessions: archived })).id).toBe(
      'host-repo::/work/parser'
    )
  })

  it('accepts a named workspace of the same repository on that host, on any branch', () => {
    const named = { selector: 'id:host-repo::/work/main', worktree: input().worktrees[0] }
    expect(resolveHostMoveWorkspace(input({ named })).path).toBe('/work/main')
  })

  it('refuses a named workspace on another host or of another repository', () => {
    const elsewhere = { ...input().worktrees[0], hostId: 'ssh:other' }
    expect(() =>
      resolveHostMoveWorkspace(input({ named: { selector: 'x', worktree: elsewhere } }))
    ).toThrow('--workspace x is on ssh:other, not on mw0002 (ssh:mw0002).')
    const otherRepo = {
      ...hostRepo,
      id: 'other',
      label: 'other',
      identity: 'github:omnirogue/other'
    }
    const foreign = { ...input().worktrees[0], repoId: 'other' }
    expect(() =>
      resolveHostMoveWorkspace(
        input({
          repos: [localRepo, hostRepo, otherRepo],
          named: { selector: 'y', worktree: foreign }
        })
      )
    ).toThrow('--workspace y holds other, not omni-ide.')
    expect(() =>
      resolveHostMoveWorkspace(input({ named: { selector: 'z', worktree: null } }))
    ).toThrow('No workspace matches --workspace z.')
  })

  it('refuses a folder workspace unless the workspace on the other computer is named', () => {
    const folder = input({ sourceRepos: [null], branch: null, upstream: null })
    expect(() => resolveHostMoveWorkspace(folder)).toThrow(/folder workspace.*--workspace/)
    const target = {
      id: 'folder:shared',
      repoId: 'folder-workspace:g',
      path: '/shared',
      branch: null,
      hostId: HOST,
      name: 'shared'
    }
    expect(
      resolveHostMoveWorkspace({
        ...folder,
        named: { selector: 'id:folder:shared', worktree: target }
      })
    ).toMatchObject({ id: 'folder:shared', branch: null })
  })

  it('refuses a consolidation across different repositories', () => {
    const other = { ...localRepo, id: 'other', identity: 'github:omnirogue/other' }
    expect(() =>
      resolveHostMoveWorkspace(input({ sourceRepos: [localRepo, other], sourceTitles: ['A', 'B'] }))
    ).toThrow('“B” is not in the same repository as “A”; move them separately.')
  })
})
