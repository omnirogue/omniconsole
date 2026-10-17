import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import {
  buildSessionTabsInventoryCoverage,
  isCensusUnverifiedWorkspaceHost,
  listUnqueriedCensusHostIds
} from './session-tabs-census-scope'

describe('session-tabs census scope (step 6, C4)', () => {
  it('lists only known non-runtime hosts the census did not ask', () => {
    const known: ExecutionHostId[] = ['local', 'ssh:box-1', 'ssh:box-2', 'runtime:studio']
    expect([...listUnqueriedCensusHostIds(known, new Set(['local', 'ssh:box-2']))]).toEqual([
      'ssh:box-1'
    ])
  })

  it('scopes coverage to the unasked host: its repos by id and its other workspaces by key', () => {
    const hostOf = new Map<string, ExecutionHostId | null>([
      ['folder:ssh-folder', 'ssh:box-1'],
      ['folder:local-folder', 'local'],
      ['repo-ssh::/remote/a', 'ssh:box-1'],
      ['repo-local::/local/a', 'local'],
      ['folder:forgotten', null]
    ])
    const coverage = buildSessionTabsInventoryCoverage({
      unverifiedHostIds: new Set<ExecutionHostId>(['ssh:box-1']),
      repos: [
        { id: 'repo-local', hostId: 'local' },
        { id: 'repo-ssh', hostId: 'ssh:box-1' }
      ],
      workspaceKeys: hostOf.keys(),
      resolveWorkspaceHostId: (key) => hostOf.get(key) ?? null
    })
    expect(coverage).toEqual({
      unverifiedRepoIds: ['repo-ssh'],
      // Why: an unknown host may be the unasked one; the SSH repo's worktree is covered by id.
      unverifiedWorkspaces: ['folder:forgotten', 'folder:ssh-folder']
    })
  })

  it('treats an unknown workspace host as unverifiable only while some host went unasked', () => {
    expect(isCensusUnverifiedWorkspaceHost(new Set(), null)).toBe(false)
    expect(isCensusUnverifiedWorkspaceHost(new Set(['ssh:box-1']), null)).toBe(true)
    expect(isCensusUnverifiedWorkspaceHost(new Set(['ssh:box-1']), 'local')).toBe(false)
  })
})
