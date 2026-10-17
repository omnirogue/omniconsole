import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: () => null }))
vi.mock('@/store/selectors', () => ({ useRepoById: () => null }))

import {
  findRepoOnHost,
  getPinnedHostGitRouting,
  withPinnedHostRouting
} from './source-control-host-routing'

const local = { id: 'repo-1', path: '/work/app', displayName: 'app' }
const box = { ...local, connectionId: 'box' }
const hub = { ...local, executionHostId: 'runtime:env-1' }
const repos = [local, box, hub] as never

describe('source control host routing (PR3 round 2 F1)', () => {
  it('picks the repo row on the worktree host when hosts repeat a repo id', () => {
    expect(findRepoOnHost(repos, 'repo-1', 'ssh:box')).toBe(box)
    expect(findRepoOnHost(repos, 'repo-1', 'runtime:env-1')).toBe(hub)
  })

  it('refreshes an SSH pick over its connection, not locally', () => {
    expect(getPinnedHostGitRouting(repos, 'repo-1', 'ssh:box')).toEqual({
      connectionId: 'box',
      activeRuntimeEnvironmentId: null
    })
  })

  it('refreshes a runtime pick through that runtime', () => {
    expect(getPinnedHostGitRouting(repos, 'repo-1', 'runtime:env-1')).toEqual({
      connectionId: undefined,
      activeRuntimeEnvironmentId: 'env-1'
    })
  })

  it('leaves the ordinary owner lookup in charge when no host is pinned', () => {
    expect(getPinnedHostGitRouting(repos, 'repo-1', undefined)).toBeNull()
  })

  it('overrides the owner routing only for a pinned host', () => {
    const owner = { activeRuntimeEnvironmentId: 'focused', theme: 'dark' }
    expect(withPinnedHostRouting(repos, 'repo-1', 'ssh:box', undefined, owner)).toEqual({
      connectionId: 'box',
      settings: { activeRuntimeEnvironmentId: null, theme: 'dark' }
    })
    expect(withPinnedHostRouting(repos, 'repo-1', undefined, 'owner-conn', owner)).toEqual({
      connectionId: 'owner-conn',
      settings: owner
    })
  })
})
