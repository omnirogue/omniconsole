import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-persistence'

const worktreeId = 'remote-repo::/srv/project'
const tabId = 'ssh-tab'
const leafId = 'ssh-leaf'
const ptyId = 'ssh:host-a@@pty2:owner:1'

function savedSshSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [worktreeId]: [
        {
          id: tabId,
          ptyId: null,
          worktreeId,
          title: 'Remote work',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
    }
  }
}

describe('direct SSH startup session recovery', () => {
  it('restores host-committed tabs when the local mirror is empty, retaining its SSH lease reference', async () => {
    const local: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: 'local-repo::/local',
      tabsByWorktree: { [worktreeId]: [] },
      remoteSessionIdsByTabId: { [tabId]: ptyId }
    }
    const host = savedSshSession()
    const get = vi.fn(async (hostId?: string) => (hostId === 'ssh:host-a' ? host : local))

    const restored = await fetchWorkspaceSessionWithRuntimeHostOwners({ get }, [
      { connectionId: 'host-a' }
    ])

    expect(get.mock.calls).toEqual([[], ['ssh:host-a']])
    expect(restored.session.tabsByWorktree[worktreeId]).toEqual(host.tabsByWorktree[worktreeId])
    expect(restored.session.terminalLayoutsByTabId[tabId]).toEqual(
      host.terminalLayoutsByTabId[tabId]
    )
    expect(restored.session.remoteSessionIdsByTabId?.[tabId]).toBe(ptyId)
    expect(restored.session.activeWorktreeId).toBe(local.activeWorktreeId)
    expect(restored.runtimeHostIdByWorkspaceSessionKey).toEqual({})
  })

  it('uses the paired runtime partition for nested SSH work without querying its private SSH target', async () => {
    const host = savedSshSession()
    const get = vi.fn(async (hostId?: string) =>
      hostId === 'runtime:owner' ? host : getDefaultWorkspaceSession()
    )

    const restored = await fetchWorkspaceSessionWithRuntimeHostOwners({ get }, [
      { connectionId: 'private-ssh', executionHostId: 'runtime:owner' }
    ])

    expect(get.mock.calls).toEqual([[], ['runtime:owner']])
    expect(restored.session.tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(restored.runtimeHostIdByWorkspaceSessionKey).toEqual({
      [worktreeId]: 'runtime:owner'
    })
  })
})
