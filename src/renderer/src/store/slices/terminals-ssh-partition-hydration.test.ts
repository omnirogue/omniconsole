import './terminal-hydration-store-test-bootstrap'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from '@/lib/workspace-session-host-persistence'
import {
  createTestStore,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore,
  TEST_REPO
} from './store-test-helpers'

const localWorktreeId = 'repo1::/local'
const remoteWorktreeId = 'remote-repo::/srv/project'
const remoteTabIds = ['ssh-first', 'ssh-second']
const leafIds = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333'
]
const remoteRepo = {
  ...TEST_REPO,
  id: 'remote-repo',
  path: '/srv/project',
  connectionId: 'host-a'
}

function localSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: TEST_REPO.id,
    activeWorktreeId: localWorktreeId,
    activeTabId: 'local-second',
    tabsByWorktree: {
      [localWorktreeId]: ['local-first', 'local-second'].map((id, sortOrder) =>
        makeTab({ id, worktreeId: localWorktreeId, sortOrder })
      ),
      [remoteWorktreeId]: []
    },
    unifiedTabs: {
      [localWorktreeId]: ['local-first', 'local-second'].map((id, sortOrder) =>
        makeUnifiedTab({ id, worktreeId: localWorktreeId, groupId: `group-${id}`, sortOrder })
      )
    },
    tabGroups: {
      [localWorktreeId]: ['local-first', 'local-second'].map((id) =>
        makeTabGroup({
          id: `group-${id}`,
          worktreeId: localWorktreeId,
          activeTabId: id,
          tabOrder: [id],
          recentTabIds: [id]
        })
      )
    },
    tabGroupLayouts: {
      [localWorktreeId]: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.6,
        first: { type: 'leaf', groupId: 'group-local-first' },
        second: { type: 'leaf', groupId: 'group-local-second' }
      }
    },
    activeGroupIdByWorktree: { [localWorktreeId]: 'group-local-second' }
  }
}

function hostSession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [remoteWorktreeId]: remoteTabIds.map((id, sortOrder) =>
        makeTab({
          id,
          worktreeId: remoteWorktreeId,
          sortOrder,
          title: `Remote ${sortOrder}`,
          startupCwd: '/srv/project',
          viewMode: sortOrder === 0 ? 'chat' : 'terminal',
          isPinned: sortOrder === 0
        })
      )
    },
    activeTabIdByWorktree: { [remoteWorktreeId]: remoteTabIds[1] },
    terminalLayoutsByTabId: {
      [remoteTabIds[0]]: {
        root: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.7,
          first: { type: 'leaf', leafId: leafIds[0] },
          second: { type: 'leaf', leafId: leafIds[1] }
        },
        activeLeafId: leafIds[1],
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      },
      [remoteTabIds[1]]: {
        root: { type: 'leaf', leafId: leafIds[2] },
        activeLeafId: leafIds[2],
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
    }
  }
}

async function readSession(local: WorkspaceSessionState, host: WorkspaceSessionState) {
  const get = vi.fn(async (hostId?: string) => {
    if (hostId === undefined) {
      return local
    }
    if (hostId === 'ssh:host-a') {
      return host
    }
    throw new Error(`Unexpected session owner ${hostId}`)
  })
  const result = await fetchWorkspaceSessionWithRuntimeHostOwners({ get }, [
    { ...TEST_REPO, connectionId: undefined },
    remoteRepo
  ])
  expect(get.mock.calls).toEqual([[], ['ssh:host-a']])
  expect(result.runtimeHostIdByWorkspaceSessionKey).toEqual({})
  return result.session
}

function hydrate(session: WorkspaceSessionState) {
  const store = createTestStore()
  seedStore(store, {
    repos: [TEST_REPO, remoteRepo],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: localWorktreeId, repoId: 'repo1', path: '/local' })],
      'remote-repo': [
        makeWorktree({ id: remoteWorktreeId, repoId: 'remote-repo', path: '/srv/project' })
      ]
    }
  })
  store.getState().hydrateWorkspaceSession(session)
  store.getState().hydrateTabsSession(session)
  store.getState().reconcileWorktreeTabModel(localWorktreeId)
  store.getState().reconcileWorktreeTabModel(remoteWorktreeId)
  return store
}

describe('mixed-format SSH startup hydration', () => {
  it('keeps both PTY-less host tabs, split pane identities and surface preferences through reconciliation and restart', async () => {
    const local = localSession()
    const host = hostSession()
    const store = hydrate(await readSession(local, host))
    const state = store.getState()
    const persisted = buildWorkspaceSessionPayload(state)

    expect(state.tabsByWorktree[remoteWorktreeId].map((tab) => tab.id)).toEqual(remoteTabIds)
    expect(state.unifiedTabsByWorktree[remoteWorktreeId].map((tab) => tab.entityId)).toEqual(
      remoteTabIds
    )
    expect(state.unifiedTabsByWorktree[remoteWorktreeId][0]).toMatchObject({
      id: remoteTabIds[0],
      viewMode: 'chat',
      isPinned: true
    })
    expect(state.groupsByWorktree[remoteWorktreeId][0]).toMatchObject({
      tabOrder: remoteTabIds,
      activeTabId: remoteTabIds[1]
    })
    expect(state.terminalLayoutsByTabId).toMatchObject(host.terminalLayoutsByTabId)
    expect(state.tabsByWorktree[remoteWorktreeId].every((tab) => tab.ptyId === null)).toBe(true)
    expect(state.pendingReconnectPtyIdByTabId).toEqual({})
    expect(state.activeWorktreeId).toBe(localWorktreeId)
    expect(state.layoutByWorktree[localWorktreeId]).toEqual(local.tabGroupLayouts![localWorktreeId])
    expect(state.activeGroupIdByWorktree[localWorktreeId]).toBe('group-local-second')
    expect(persisted.tabsByWorktree[remoteWorktreeId].map((tab) => tab.id)).toEqual(remoteTabIds)

    const reloaded = hydrate(await readSession(persisted, host)).getState()
    expect(reloaded.unifiedTabsByWorktree[remoteWorktreeId]).toEqual(
      state.unifiedTabsByWorktree[remoteWorktreeId]
    )
    expect(reloaded.groupsByWorktree[remoteWorktreeId]).toEqual(
      state.groupsByWorktree[remoteWorktreeId]
    )
    expect(reloaded.terminalLayoutsByTabId).toMatchObject(host.terminalLayoutsByTabId)
    expect(reloaded.tabsByWorktree[remoteWorktreeId].map((tab) => tab.id)).toEqual(remoteTabIds)
  })

  it('does not recover a closed tab or its saved reconnect lease, but keeps another workspace’s close record', async () => {
    const local = localSession()
    const host = hostSession()
    local.closedTerminalTabTombstonesByTabId = {
      [remoteTabIds[0]]: { closedAt: Date.now(), worktreeId: remoteWorktreeId, ackRevision: 4 },
      [remoteTabIds[1]]: { closedAt: Date.now(), worktreeId: 'other-repo::/other' }
    }
    host.remoteSessionIdsByTabId = { [remoteTabIds[0]]: 'ssh:host-a@@old-lease' }
    const state = hydrate(await readSession(local, host)).getState()
    const persisted = buildWorkspaceSessionPayload(state)

    expect(state.tabsByWorktree[remoteWorktreeId].map((tab) => tab.id)).toEqual([remoteTabIds[1]])
    expect(state.unifiedTabsByWorktree[remoteWorktreeId].map((tab) => tab.entityId)).toEqual([
      remoteTabIds[1]
    ])
    expect(state.terminalLayoutsByTabId[remoteTabIds[0]]).toBeUndefined()
    expect(state.pendingReconnectPtyIdByTabId[remoteTabIds[0]]).toBeUndefined()
    expect(persisted.remoteSessionIdsByTabId?.[remoteTabIds[0]]).toBeUndefined()
    expect(state.closedTerminalTabTombstonesByTabId).toEqual(
      local.closedTerminalTabTombstonesByTabId
    )
  })

  it.each(['unifiedTabs', 'tabGroups'] as const)(
    'respects an explicit empty %s entry instead of migrating stale rows',
    async (field) => {
      const local = localSession()
      local[field]![remoteWorktreeId] = []
      const restored = await readSession(local, hostSession())
      expect(restored[field]![remoteWorktreeId]).toEqual([])
      const state = hydrate(restored).getState()
      expect(state.tabsByWorktree[remoteWorktreeId]).toEqual([])
      expect(state.unifiedTabsByWorktree[remoteWorktreeId] ?? []).toEqual([])
    }
  )

  it('keeps existing SSH groups and their selected surface without adding legacy duplicates', async () => {
    const local = localSession()
    const remoteGroup = 'remote-existing-group'
    local.unifiedTabs![remoteWorktreeId] = [
      makeUnifiedTab({
        id: 'remote-chrome-id',
        entityId: remoteTabIds[0],
        worktreeId: remoteWorktreeId,
        groupId: remoteGroup,
        viewMode: 'terminal',
        customLabel: 'My terminal'
      })
    ]
    local.tabGroups![remoteWorktreeId] = [
      makeTabGroup({
        id: remoteGroup,
        worktreeId: remoteWorktreeId,
        activeTabId: 'remote-chrome-id',
        tabOrder: ['remote-chrome-id']
      })
    ]

    const state = hydrate(await readSession(local, hostSession())).getState()
    expect(state.unifiedTabsByWorktree[remoteWorktreeId]).toEqual(
      local.unifiedTabs![remoteWorktreeId]
    )
    expect(state.groupsByWorktree[remoteWorktreeId][0].id).toBe(remoteGroup)
    expect(state.tabsByWorktree[remoteWorktreeId].map((tab) => tab.id)).toEqual([remoteTabIds[0]])
  })

  it('retains the ordinary legacy migration when no partition has unified groups', async () => {
    const local = localSession()
    delete local.unifiedTabs
    delete local.tabGroups
    const state = hydrate(await readSession(local, hostSession())).getState()
    expect(state.unifiedTabsByWorktree[localWorktreeId]).toHaveLength(2)
    expect(state.unifiedTabsByWorktree[remoteWorktreeId].map((tab) => tab.entityId)).toEqual(
      remoteTabIds
    )
  })
})
