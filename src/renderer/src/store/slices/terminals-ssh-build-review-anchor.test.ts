import './terminal-hydration-store-test-bootstrap'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from '@/lib/workspace-session-host-persistence'
import { createTestStore, makeTab, makeWorktree, seedStore, TEST_REPO } from './store-test-helpers'

const localWorktreeId = 'repo1::/local'
const remoteWorktreeId = 'remote-repo::/srv/project'
const remoteRepo = { ...TEST_REPO, id: 'remote-repo', path: '/srv/project', connectionId: 'host-a' }
const anchor = {
  preset: 'build-review' as const,
  prompt: 'Add search',
  buildReviewPipelineId: 'brp_1'
}
const terminalId = 'ssh-terminal'
const leafId = '11111111-1111-4111-8111-111111111111'
const ptyId = 'ssh:host-a@@pty1'

function freshStore() {
  const store = createTestStore()
  seedStore(store, {
    repos: [TEST_REPO, remoteRepo],
    sshConnectionStates: new Map([
      ['host-a', { status: 'connected', targetId: 'host-a', error: null, reconnectAttempt: 0 }]
    ]),
    worktreesByRepo: {
      repo1: [makeWorktree({ id: localWorktreeId, repoId: 'repo1', path: '/local' })],
      'remote-repo': [
        makeWorktree({ id: remoteWorktreeId, repoId: 'remote-repo', path: '/srv/project' })
      ]
    }
  })
  return store
}

/** What an SSH spawn commit leaves in the `ssh:host-a` partition: its terminal, never the anchor. */
function sshPartition(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [remoteWorktreeId]: [makeTab({ id: terminalId, worktreeId: remoteWorktreeId, ptyId })]
    },
    terminalLayoutsByTabId: {
      [terminalId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    }
  }
}

async function restart(local: WorkspaceSessionState, host: WorkspaceSessionState) {
  const get = vi.fn(async (hostId?: string) => (hostId === 'ssh:host-a' ? host : local))
  const { session } = await fetchWorkspaceSessionWithRuntimeHostOwners({ get }, [
    { ...TEST_REPO, connectionId: undefined },
    remoteRepo
  ])
  expect(get.mock.calls).toEqual([[], ['ssh:host-a']])
  const store = freshStore()
  store.getState().hydrateWorkspaceSession(session)
  store.getState().hydrateTabsSession(session)
  store.getState().reconcileWorktreeTabModel(remoteWorktreeId)
  return store.getState()
}

describe('SSH Build + Review conversation across a restart', () => {
  it('keeps a PTY-less anchor beside the terminal the ssh: partition restores, without spawning for it', async () => {
    const before = freshStore()
    const terminal = before.getState().createTab(remoteWorktreeId)
    const created = before
      .getState()
      .createTab(remoteWorktreeId, undefined, undefined, { localWorkflow: anchor })
    const saved = buildWorkspaceSessionPayload(before.getState())
    expect(saved.tabsByWorktree[remoteWorktreeId]?.map((tab) => tab.id)).toEqual([
      terminal.id,
      created.id
    ])
    // Why rename: the partition's terminal is the one the host committed a PTY for.
    const host = sshPartition()
    host.tabsByWorktree[remoteWorktreeId][0].id = terminal.id
    host.terminalLayoutsByTabId = { [terminal.id]: host.terminalLayoutsByTabId[terminalId] }

    const after = await restart(saved, host)
    const restored = after.tabsByWorktree[remoteWorktreeId]
    expect(restored.map((tab) => tab.id)).toEqual([terminal.id, created.id])
    const anchorTab = restored.find((tab) => tab.id === created.id)
    expect(anchorTab).toMatchObject({ ptyId: null, localWorkflow: anchor })
    // A workflow anchor is not a terminal: no spawn on activation and no reconnect lease.
    expect(anchorTab?.pendingActivationSpawn).toBeUndefined()
    expect(after.pendingReconnectPtyIdByTabId[created.id]).toBeUndefined()
    expect(after.unifiedTabsByWorktree[remoteWorktreeId]?.map((tab) => tab.entityId)).toEqual([
      terminal.id,
      created.id
    ])
  })

  describe('an anchor the person closed', () => {
    async function closedAnchor() {
      const store = freshStore()
      const terminal = store.getState().createTab(remoteWorktreeId)
      const created = store
        .getState()
        .createTab(remoteWorktreeId, undefined, undefined, { localWorkflow: anchor })
      const beforeClose = buildWorkspaceSessionPayload(store.getState())
      store.getState().closeTab(created.id)
      const afterClose = buildWorkspaceSessionPayload(store.getState())
      const host = sshPartition()
      host.tabsByWorktree[remoteWorktreeId][0].id = terminal.id
      host.terminalLayoutsByTabId = { [terminal.id]: host.terminalLayoutsByTabId[terminalId] }
      return { terminal, created, beforeClose, afterClose, host }
    }

    it('stays closed after the next save rewrites the mirror without it', async () => {
      const { terminal, created, afterClose, host } = await closedAnchor()
      expect(afterClose.tabsByWorktree[remoteWorktreeId]?.map((tab) => tab.id)).toEqual([
        terminal.id
      ])
      const after = await restart(afterClose, host)
      expect(after.tabsByWorktree[remoteWorktreeId].map((tab) => tab.id)).toEqual([terminal.id])
      expect(after.unifiedTabsByWorktree[remoteWorktreeId]?.map((tab) => tab.entityId)).toEqual([
        terminal.id
      ])
      expect(JSON.stringify(after.tabsByWorktree)).not.toContain(created.id)
    })

    it('stays closed when the mirror still holds it but its close record was saved', async () => {
      const { terminal, created, beforeClose, afterClose, host } = await closedAnchor()
      // Why: the race where the close record landed before the rewritten tab list did.
      expect(afterClose.closedTerminalTabTombstonesByTabId?.[created.id]?.worktreeId).toBe(
        remoteWorktreeId
      )
      const stale = {
        ...beforeClose,
        closedTerminalTabTombstonesByTabId: afterClose.closedTerminalTabTombstonesByTabId
      }
      expect(stale.tabsByWorktree[remoteWorktreeId]?.map((tab) => tab.id)).toContain(created.id)
      const after = await restart(stale, host)
      expect(after.tabsByWorktree[remoteWorktreeId].map((tab) => tab.id)).toEqual([terminal.id])
      expect(
        (after.unifiedTabsByWorktree[remoteWorktreeId] ?? []).map((tab) => tab.entityId)
      ).not.toContain(created.id)
    })
  })

  it('restores the anchor from the ssh: partition when the local mirror lost the workspace', async () => {
    const host = sshPartition()
    host.tabsByWorktree[remoteWorktreeId].push(
      makeTab({ id: 'anchor-tab', worktreeId: remoteWorktreeId, localWorkflow: anchor })
    )
    const local = { ...getDefaultWorkspaceSession(), tabsByWorktree: { [remoteWorktreeId]: [] } }
    const after = await restart(local, host)
    const restored = after.tabsByWorktree[remoteWorktreeId]
    expect(restored.map((tab) => tab.id)).toEqual([terminalId, 'anchor-tab'])
    expect(restored[1]).toMatchObject({ ptyId: null, localWorkflow: anchor })
    expect(restored[1].pendingActivationSpawn).toBeUndefined()
  })
})
