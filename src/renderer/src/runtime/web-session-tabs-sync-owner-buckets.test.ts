import { beforeEach, describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  toHostSessionTabId,
  toOwnerQualifiedWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import type { Repo } from '../../../shared/repo-types'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import {
  applyFreshWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot,
  resolveHostSessionTabIdForWebSessionTab,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  getIgnoredForeignOwnerWebSessionTabsFrameCounts,
  resetIgnoredForeignOwnerWebSessionTabsFrameCountsForTests,
  resolveMirroredTerminalActionEnvironmentId
} from './web-session-mirror-owner'
import {
  LEAF_ID,
  NOW,
  WT,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const ENV_A = 'env-a'
const ENV_B = 'env-b'

function terminalFrame(
  hostTabIds: readonly string[],
  options: { worktree?: string; snapshotVersion?: number; publicationEpoch?: string } = {}
): RuntimeMobileSessionTabsResult {
  const worktree = options.worktree ?? WT
  return {
    worktree,
    publicationEpoch: options.publicationEpoch ?? 'epoch-1',
    snapshotVersion: options.snapshotVersion ?? 1,
    activeGroupId: null,
    activeTabId: hostTabIds[0] ? `${hostTabIds[0]}::${LEAF_ID}` : null,
    activeTabType: hostTabIds.length > 0 ? 'terminal' : null,
    tabs: hostTabIds.map((hostTabId, index) => ({
      type: 'terminal' as const,
      id: `${hostTabId}::${LEAF_ID}`,
      parentTabId: hostTabId,
      leafId: LEAF_ID,
      title: `Session ${hostTabId}`,
      launchAgent: 'codex' as const,
      isActive: index === 0,
      status: 'ready' as const,
      terminal: `${hostTabId}-handle`,
      agentStatus: {
        state: 'working' as const,
        prompt: `prompt ${hostTabId}`,
        updatedAt: 100,
        stateStartedAt: 90,
        agentType: 'codex' as const,
        paneKey: `${hostTabId}:${LEAF_ID}`,
        tabId: hostTabId,
        worktreeId: worktree,
        stateHistory: []
      }
    }))
  }
}

function send(
  state: WebSessionTabsSyncState,
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  return { ...state, ...applyFreshWebSessionTabsSnapshot(state, snapshot, environmentId, NOW) }
}

function rowIds(state: WebSessionTabsSyncState, worktreeId = WT): string[] {
  return (state.tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
}

describe('receiver mirrors keyed by (environment, workspace)', () => {
  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    resetIgnoredForeignOwnerWebSessionTabsFrameCountsForTests()
  })

  it('keeps both owners of one workspace string: A[a], B[b,c], A[a] is 1→3→3 (was 1→2→1)', () => {
    const a = toWebTerminalSurfaceTabId('a')
    const aPane = makePaneKey(a, LEAF_ID)
    const counts: number[] = []

    let state = send(makeState(), ENV_A, terminalFrame(['a']))
    counts.push(rowIds(state).length)
    const aBinding = state.ptyIdsByTabId[a]
    const aLayout = state.terminalLayoutsByTabId[a]
    const aStatus = state.agentStatusByPaneKey[aPane]
    expect(aBinding).toEqual([toRemoteRuntimePtyId('a-handle', ENV_A)])

    state = send(state, ENV_B, terminalFrame(['b', 'c']))
    counts.push(rowIds(state).length)
    // Why: B's frame no longer replaces A's mirrors, bindings or status.
    expect(state.ptyIdsByTabId[a]).toBe(aBinding)
    expect(state.terminalLayoutsByTabId[a]).toBe(aLayout)
    expect(state.agentStatusByPaneKey[aPane]).toBe(aStatus)

    state = send(state, ENV_A, terminalFrame(['a'], { snapshotVersion: 2 }))
    counts.push(rowIds(state).length)
    expect(counts).toEqual([1, 3, 3])
    expect(state.unifiedTabsByWorktree[WT]?.map((tab) => tab.executionHostId).sort()).toEqual([
      'runtime:env-a',
      'runtime:env-b',
      'runtime:env-b'
    ])

    const removal = {
      ...terminalFrame([], { snapshotVersion: 3 }),
      removed: true
    } as RuntimeMobileSessionTabsResult
    state = send(state, ENV_A, removal)
    expect(rowIds(state).sort()).toEqual([
      toWebTerminalSurfaceTabId('b'),
      toWebTerminalSurfaceTabId('c')
    ])
    expect(state.agentStatusByPaneKey[aPane]).toBeUndefined()
    expect(
      state.agentStatusByPaneKey[makePaneKey(toWebTerminalSurfaceTabId('b'), LEAF_ID)]
    ).toEqual(expect.objectContaining({ prompt: 'prompt b' }))
  })

  it("keeps A's structured chat when B publishes the same workspace", () => {
    const chatFrame: RuntimeMobileSessionTabsResult = {
      ...terminalFrame([]),
      activeTabType: 'agent-session',
      tabs: [
        {
          type: 'agent-session',
          id: 'agent-session:session-a',
          title: 'Codex Chat',
          sessionId: 'session-a',
          agent: 'codex',
          isActive: true
        }
      ]
    }
    let state = send(makeState(), ENV_A, chatFrame)
    state = send(state, ENV_B, terminalFrame(['b']))
    expect(
      state.unifiedTabsByWorktree[WT]?.map((tab) => [tab.contentType, tab.entityId]).sort()
    ).toEqual([
      ['agent-session', 'session-a'],
      ['terminal', toWebTerminalSurfaceTabId('b')]
    ])

    state = send(state, ENV_A, { ...terminalFrame([], { snapshotVersion: 2 }) })
    expect(state.unifiedTabsByWorktree[WT]?.map((tab) => tab.contentType)).toEqual(['terminal'])
  })

  it('gives an identical host tab id from a second owner its own client row', () => {
    const legacy = toWebTerminalSurfaceTabId('t')
    const qualified = toOwnerQualifiedWebTerminalSurfaceTabId(ENV_B, 't')

    let state = send(makeState(), ENV_A, terminalFrame(['t']))
    state = send(state, ENV_B, terminalFrame(['t']))

    expect(rowIds(state)).toEqual([legacy, qualified])
    expect(state.ptyIdsByTabId[legacy]).toEqual([toRemoteRuntimePtyId('t-handle', ENV_A)])
    expect(state.ptyIdsByTabId[qualified]).toEqual([toRemoteRuntimePtyId('t-handle', ENV_B)])
    expect(Object.keys(state.agentStatusByPaneKey).sort()).toEqual(
      [makePaneKey(legacy, LEAF_ID), makePaneKey(qualified, LEAF_ID)].sort()
    )
    // Why: owner qualification is client-local; every RPC still names the host's own tab id.
    expect(toHostSessionTabId(qualified)).toBe('t')
    expect(
      resolveHostSessionTabIdForWebSessionTab(state, {
        environmentId: ENV_B,
        worktreeId: WT,
        tabId: qualified
      })
    ).toBe('t')
    expect(resolveMirroredTerminalActionEnvironmentId(state, WT, qualified, ENV_A)).toEqual({
      kind: 'route',
      environmentId: ENV_B
    })

    state = send(state, ENV_B, terminalFrame([], { snapshotVersion: 2 }))
    expect(rowIds(state)).toEqual([legacy])
    expect(state.ptyIdsByTabId[legacy]).toEqual([toRemoteRuntimePtyId('t-handle', ENV_A)])
  })

  it("ignores and counts B's echo of a workspace A positively owns", () => {
    const owned = makeState({
      repos: [
        { id: 'repo', executionHostId: 'runtime:env-a', connectionId: null } as unknown as Repo
      ]
    } as Partial<WebSessionTabsSyncState>)
    const state = send(owned, ENV_A, terminalFrame(['a']))
    const echo = terminalFrame(['a', 'x'])

    expect(decideWebSessionTabsSnapshot(echo, ENV_B, undefined, undefined, state)).toEqual({
      apply: false,
      settlesHostMirror: false
    })
    expect(applyFreshWebSessionTabsSnapshot(state, echo, ENV_B, NOW)).toBe(state)
    expect(getIgnoredForeignOwnerWebSessionTabsFrameCounts().get(ENV_B)).toBe(2)
    expect(rowIds(state)).toEqual([toWebTerminalSurfaceTabId('a')])
    expect(state.ptyIdsByTabId[toWebTerminalSurfaceTabId('a')]).toEqual([
      toRemoteRuntimePtyId('a-handle', ENV_A)
    ])
  })

  it("never lets the workspace owner's frame evict a row whose evidence names another owner", () => {
    const echoId = toWebTerminalSurfaceTabId('x')
    const owned = makeState({
      repos: [
        { id: 'repo', executionHostId: 'runtime:env-a', connectionId: null } as unknown as Repo
      ],
      tabsByWorktree: {
        [WT]: [
          {
            id: echoId,
            worktreeId: WT,
            ptyId: toRemoteRuntimePtyId('x-handle', ENV_B),
            title: 'echo',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    } as Partial<WebSessionTabsSyncState>)

    let state = send(owned, ENV_A, terminalFrame(['a']))
    expect(rowIds(state).sort()).toEqual([echoId, toWebTerminalSurfaceTabId('a')].sort())

    // Why: only B's own removal (or its inventory omitting the workspace) retracts B's row.
    state = send(state, ENV_B, {
      ...terminalFrame([]),
      removed: true
    } as RuntimeMobileSessionTabsResult)
    expect(rowIds(state)).toEqual([toWebTerminalSurfaceTabId('a')])
  })

  it("keeps both owners while A's copy of the workspace is open: 1→3→3", () => {
    // Why: the open workspace's route is navigation, not ownership; B is not an echo of A here.
    const open = makeState({
      activeWorktreeId: WT,
      activeWorkspaceExecutionHostId: 'runtime:env-a'
    } as Partial<WebSessionTabsSyncState>)
    const counts: number[] = []
    let state = send(open, ENV_A, terminalFrame(['a']))
    counts.push(rowIds(state).length)
    state = send(state, ENV_B, terminalFrame(['b', 'c']))
    counts.push(rowIds(state).length)
    state = send(state, ENV_A, terminalFrame(['a'], { snapshotVersion: 2 }))
    counts.push(rowIds(state).length)
    expect(counts).toEqual([1, 3, 3])
    expect(getIgnoredForeignOwnerWebSessionTabsFrameCounts().get(ENV_B)).toBeUndefined()
  })

  it('preserves an ambiguous legacy alias and refuses actions against a guessed owner', () => {
    const alias = toWebTerminalSurfaceTabId('z')
    const restored = makeState({
      tabsByWorktree: {
        [WT]: [
          {
            id: alias,
            worktreeId: WT,
            ptyId: toRemoteRuntimePtyId('z-handle', ENV_A),
            title: 'conflicting',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      unifiedTabsByWorktree: {
        [WT]: [
          {
            id: alias,
            entityId: alias,
            groupId: 'group',
            worktreeId: WT,
            executionHostId: 'runtime:env-b',
            contentType: 'terminal',
            label: 'conflicting',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    })

    let state = send(restored, ENV_A, terminalFrame(['a']))
    state = send(state, ENV_B, terminalFrame(['b']))

    expect(rowIds(state)).toContain(alias)
    expect(rowIds(state)).toHaveLength(3)
    expect(resolveMirroredTerminalActionEnvironmentId(state, WT, alias, ENV_A)).toEqual({
      kind: 'refuse'
    })
  })
})
