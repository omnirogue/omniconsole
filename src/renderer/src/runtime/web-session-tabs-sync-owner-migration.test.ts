import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  toOwnerQualifiedWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { SESSION_TEST_WORKTREE, sessionTestSource } from '@/lib/sidebar-session-test-fixtures'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import {
  applyFreshWebSessionTabsSnapshot,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  LEAF_ID,
  NOW,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const ENV_A = 'env-a'
const ENV_B = 'env-b'
const WT = SESSION_TEST_WORKTREE
const T = toWebTerminalSurfaceTabId('t')
const U = toWebTerminalSurfaceTabId('u')

function frame(
  hostTabIds: readonly string[],
  publicationEpoch: string
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch,
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: hostTabIds.map((hostTabId) => ({
      type: 'terminal' as const,
      id: `${hostTabId}::${LEAF_ID}`,
      parentTabId: hostTabId,
      leafId: LEAF_ID,
      title: `Session ${hostTabId}`,
      launchAgent: 'codex' as const,
      isActive: false,
      status: 'ready' as const,
      terminal: `${hostTabId}-handle`
    }))
  }
}

/** The mirror state a pre-upgrade build persisted: A's row stamped by its old frames, plus a
 *  row from before mirrors were stamped at all. Neither carries provider metadata. */
function persistedPreUpgradeState(): WebSessionTabsSyncState {
  const aPty = toRemoteRuntimePtyId('t-handle', ENV_A)
  const tab = (id: string, ptyId: string | null, sortOrder: number) => ({
    id,
    worktreeId: WT,
    ptyId,
    title: `Session ${id}`,
    launchAgent: 'codex' as const,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  })
  return makeState({
    activeWorktreeId: null,
    tabsByWorktree: { [WT]: [tab(T, aPty, 0), tab(U, null, 1)] },
    ptyIdsByTabId: { [T]: [aPty] },
    terminalLayoutsByTabId: {
      [T]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: aPty }
      },
      [U]: { root: { type: 'leaf', leafId: LEAF_ID }, activeLeafId: LEAF_ID, expandedLeafId: null }
    },
    unifiedTabsByWorktree: {
      [WT]: [
        {
          id: T,
          entityId: T,
          groupId: 'group-1',
          worktreeId: WT,
          executionHostId: 'runtime:env-a',
          contentType: 'terminal',
          label: 'Session t',
          customLabel: null,
          color: null,
          sortOrder: 0,
          createdAt: 0
        }
      ]
    }
  })
}

function sessionKeysByTab(state: WebSessionTabsSyncState): Map<string, string | null> {
  const source = {
    ...sessionTestSource(),
    tabsByWorktree: state.tabsByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    agentStatusByPaneKey: state.agentStatusByPaneKey
  }
  return new Map(buildSidebarSessions(source).map((row) => [row.tabId ?? '', row.sessionKey]))
}

function restartAndReplay(
  state: WebSessionTabsSyncState,
  frames: readonly [string, RuntimeMobileSessionTabsResult][]
): WebSessionTabsSyncState {
  // Why: a restart drops every module-level freshness/tracking record; only persisted state survives.
  resetWebSessionTabsSyncTestState()
  let next = state
  for (const [environmentId, snapshot] of frames) {
    next = { ...next, ...applyFreshWebSessionTabsSnapshot(next, snapshot, environmentId, NOW) }
  }
  return next
}

function mirrorIdentity(state: WebSessionTabsSyncState): unknown {
  return {
    rows: (state.tabsByWorktree[WT] ?? []).map((tab) => [tab.id, tab.ptyId]).sort(),
    unified: (state.unifiedTabsByWorktree[WT] ?? [])
      .map((tab) => [tab.id, tab.executionHostId])
      .sort(),
    layouts: Object.keys(state.terminalLayoutsByTabId).sort(),
    bindings: Object.entries(state.ptyIdsByTabId).sort()
  }
}

describe('upgrading persisted mirror state to owner buckets', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps archived provisional keys on their proven owner, idempotently across restarts', () => {
    const before = persistedPreUpgradeState()
    const archivedKey = sessionKeysByTab(before).get(T)
    expect(archivedKey).toEqual(expect.stringContaining(makePaneKey(T, LEAF_ID)))

    const firstBoot = restartAndReplay(before, [
      [ENV_A, frame(['t', 'u'], 'renderer:a-1')],
      [ENV_B, frame(['t'], 'renderer:b-1')]
    ])
    const qualified = toOwnerQualifiedWebTerminalSurfaceTabId(ENV_B, 't')
    expect(firstBoot.tabsByWorktree[WT]?.map((tab) => tab.id).sort()).toEqual(
      [T, U, qualified].sort()
    )
    // Why: the legacy id stays A's identity (its evidence proves it), so the archive and
    // organization key minted from its pane before the upgrade still names the same row.
    const firstKeys = sessionKeysByTab(firstBoot)
    expect(firstKeys.get(T)).toBe(archivedKey)
    expect(firstKeys.get(qualified)).not.toBe(archivedKey)
    expect(firstBoot.ptyIdsByTabId[T]).toEqual([toRemoteRuntimePtyId('t-handle', ENV_A)])
    expect(firstBoot.ptyIdsByTabId[U]).toEqual([toRemoteRuntimePtyId('u-handle', ENV_A)])

    // Second restart: new publication epochs, the other arrival order, same persisted state.
    const secondBoot = restartAndReplay(firstBoot, [
      [ENV_B, frame(['t'], 'renderer:b-2')],
      [ENV_A, frame(['t', 'u'], 'renderer:a-2')]
    ])
    expect(mirrorIdentity(secondBoot)).toEqual(mirrorIdentity(firstBoot))
    expect(sessionKeysByTab(secondBoot).get(T)).toBe(archivedKey)
  })

  it('keeps the archive key when the saved unified-tab stamp is the only owner evidence', () => {
    // What an upgraded user has after a restart: no PTY bindings, only the tab's saved host stamp.
    const stampOnly = persistedPreUpgradeState()
    const t = stampOnly.tabsByWorktree[WT]![0]!
    const stamped: WebSessionTabsSyncState = {
      ...stampOnly,
      tabsByWorktree: { [WT]: [{ ...t, ptyId: null }] },
      ptyIdsByTabId: {},
      terminalLayoutsByTabId: {
        [T]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        }
      }
    }
    const archivedKey = sessionKeysByTab(stamped).get(T)

    const booted = restartAndReplay(stamped, [
      [ENV_B, frame(['t'], 'renderer:b-1')],
      [ENV_A, frame(['t'], 'renderer:a-1')]
    ])

    expect(booted.tabsByWorktree[WT]?.map((tab) => tab.id).sort()).toEqual(
      [T, toOwnerQualifiedWebTerminalSurfaceTabId(ENV_B, 't')].sort()
    )
    expect(booted.ptyIdsByTabId[T]).toEqual([toRemoteRuntimePtyId('t-handle', ENV_A)])
    expect(sessionKeysByTab(booted).get(T)).toBe(archivedKey)
  })
})
