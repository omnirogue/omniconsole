import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { useAppStore } from '@/store'
import { findUnhydratedHostMirrorForPane } from '@/lib/host-mirrored-pane-liveness'
import { getSessionOwnershipUnverifiedReason } from '@/lib/session-ownership-verdict'
import {
  applyFreshWebSessionTabsSnapshot,
  shouldRespawnWebRuntimeTerminalAfterWake,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  queueAcceptedWebSessionTerminalSnapshot,
  subscribeAcceptedWebSessionTerminalHandle
} from './web-session-terminal-handle-events'
import { recoverWebSessionTerminalOrphansBeforeApply } from './web-session-terminal-orphan-recovery'
import {
  LEAF_ID,
  NOW,
  WT,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const ENV_A = 'env-a'
const ENV_B = 'env-b'
const LOCAL_WT = 'repo-local::/local'
const SSH_WT = 'repo-ssh::/remote'

function terminalFrame(
  hostTabIds: readonly string[],
  options: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  const worktree = options.worktree ?? WT
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
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
      terminal: `${hostTabId}-handle`
    })),
    ...options
  }
}

/** What a restarted runtime answers for a workspace it has published nothing for yet. */
function placeholder(worktree = WT): RuntimeMobileSessionTabsResult {
  return terminalFrame([], { worktree, publicationEpoch: 'none', snapshotVersion: 0 })
}

function send(
  state: WebSessionTabsSyncState,
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult
): WebSessionTabsSyncState {
  return { ...state, ...applyFreshWebSessionTabsSnapshot(state, snapshot, environmentId, NOW) }
}

function rows(state: WebSessionTabsSyncState, worktreeId = WT): [string, boolean][] {
  return (state.tabsByWorktree[worktreeId] ?? []).map((tab) => [
    tab.id,
    tab.mirrorAbsenceUnverified === true
  ])
}

const id = toWebTerminalSurfaceTabId

describe('scoped absence authority on per-workspace frames (step 6, C4)', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps rows through an unpublished empty v0 frame and lets a real frame repair them', () => {
    let state = send(makeState(), ENV_A, terminalFrame(['a', 'b']))
    const binding = state.ptyIdsByTabId[id('a')]

    state = send(state, ENV_A, placeholder())
    expect(rows(state)).toEqual([
      [id('a'), true],
      [id('b'), true]
    ])
    expect(state.ptyIdsByTabId[id('a')]).toBe(binding)

    state = send(state, ENV_A, terminalFrame(['a', 'b'], { publicationEpoch: 'epoch-2' }))
    expect(rows(state)).toEqual([
      [id('a'), false],
      [id('b'), false]
    ])
  })

  it('removes exactly a verified local close while an offline SSH host keeps its rows unverifiable', () => {
    let state = send(makeState(), ENV_A, terminalFrame(['l1', 'l2'], { worktree: LOCAL_WT }))
    state = send(state, ENV_A, terminalFrame(['s1'], { worktree: SSH_WT }))

    state = send(state, ENV_A, terminalFrame(['l2'], { worktree: LOCAL_WT, snapshotVersion: 2 }))
    // The owner's census could not ask the SSH host, so its frame says so.
    state = send(
      state,
      ENV_A,
      terminalFrame([], { worktree: SSH_WT, snapshotVersion: 2, membershipUnverified: true })
    )

    expect(rows(state, LOCAL_WT)).toEqual([[id('l2'), false]])
    expect(rows(state, SSH_WT)).toEqual([[id('s1'), true]])
    expect(
      getSessionOwnershipUnverifiedReason(state as never, {
        kind: 'terminal',
        tabId: id('s1'),
        worktreeId: SSH_WT
      })
    ).toBe('absence-unverified')
    expect(
      getSessionOwnershipUnverifiedReason(state as never, {
        kind: 'terminal',
        tabId: id('l2'),
        worktreeId: LOCAL_WT
      })
    ).toBeNull()
  })

  it('still applies the rows an owner-marked frame lists', () => {
    let state = send(makeState(), ENV_A, terminalFrame(['a', 'b']))
    const marked = terminalFrame(['a'], { snapshotVersion: 2, membershipUnverified: true })
    marked.tabs[0] = { ...marked.tabs[0]!, title: 'Renamed a' }
    state = send(state, ENV_A, marked)
    expect(rows(state)).toEqual([
      [id('b'), true],
      [id('a'), false]
    ])
    expect(state.tabsByWorktree[WT]?.find((tab) => tab.id === id('a'))?.title).toBe('Renamed a')
  })

  it("keeps an older owner's real publication as membership evidence (mixed version)", () => {
    let state = send(makeState(), ENV_A, terminalFrame(['a', 'b']))
    state = send(state, ENV_A, terminalFrame(['a'], { snapshotVersion: 2 }))
    expect(rows(state)).toEqual([[id('a'), false]])
  })

  // Every paired client has a device id, so the placeholder it receives went through the owner's
  // per-device navigation projection; an older owner also sends no marker.
  it.each([
    ['an older owner (no marker)', {}],
    ['a current owner (marked)', { membershipUnverified: true as const }]
  ])('keeps rows through the device-projected placeholder from %s', (_label, marker) => {
    let state = send(makeState(), ENV_A, terminalFrame(['a']))
    state = send(state, ENV_A, {
      ...placeholder(),
      publicationEpoch: 'none:client-navigation',
      snapshotVersion: 3,
      ...marker
    })
    expect(rows(state)).toEqual([[id('a'), true]])
    expect(
      shouldRespawnWebRuntimeTerminalAfterWake({
        activeWorktreeId: WT,
        requestedRespawnAfterWake: false,
        snapshotIsFresh: true,
        localTerminalCount: 1,
        hasLiveLocalPty: false,
        event: { ...placeholder(), publicationEpoch: 'none:client-navigation', type: 'snapshot' }
      })
    ).toBe(false)
  })

  it('keeps and labels a structured chat an unverified frame omits', () => {
    const chatFrame = (snapshot: Partial<RuntimeMobileSessionTabsResult>) =>
      terminalFrame([], {
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
        ],
        ...snapshot
      })
    let state = send(makeState(), ENV_A, chatFrame({}))
    state = send(state, ENV_A, { ...placeholder(), publicationEpoch: 'none:client-navigation' })
    const chat = state.unifiedTabsByWorktree[WT]?.find((tab) => tab.contentType === 'agent-session')
    expect(chat?.mirrorAbsenceUnverified).toBe(true)
    expect(
      getSessionOwnershipUnverifiedReason(state as never, {
        kind: 'structured',
        tabId: chat!.id,
        worktreeId: WT
      })
    ).toBe('absence-unverified')

    state = send(state, ENV_A, chatFrame({ publicationEpoch: 'epoch-2' }))
    expect(
      state.unifiedTabsByWorktree[WT]?.find((tab) => tab.contentType === 'agent-session')
        ?.mirrorAbsenceUnverified
    ).toBeUndefined()
  })

  it("never flags another owner's rows from this environment's unverified frame", () => {
    let state = send(makeState(), ENV_A, terminalFrame(['a']))
    state = send(state, ENV_B, terminalFrame(['b']))
    state = send(state, ENV_A, placeholder())
    expect(rows(state)).toEqual([
      [id('a'), true],
      [id('b'), false]
    ])
  })
})

describe('unverified omissions are never woken', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('keeps a flagged mirror pane undecidable for the resume sweep', () => {
    let state = send(makeState(), ENV_A, terminalFrame(['a']))
    state = send(state, ENV_A, placeholder())
    const record = {
      paneKey: makePaneKey(id('a'), LEAF_ID),
      tabId: id('a'),
      worktreeId: WT
    } as unknown as SleepingAgentSessionRecord
    const appState = { ...state, repos: [] } as unknown as ReturnType<typeof useAppStore.getState>
    expect(findUnhydratedHostMirrorForPane(record, appState)).not.toBeNull()
    // Control: the same row once a frame lists it again is decidable (its handle is published).
    const relisted = send(state, ENV_A, terminalFrame(['a'], { publicationEpoch: 'epoch-2' }))
    expect(
      findUnhydratedHostMirrorForPane(record, {
        ...relisted,
        repos: []
      } as unknown as ReturnType<typeof useAppStore.getState>)
    ).toBeNull()
  })

  it('does not respawn a terminal after wake on a placeholder frame', () => {
    const args = {
      activeWorktreeId: WT,
      requestedRespawnAfterWake: false,
      snapshotIsFresh: true,
      localTerminalCount: 1,
      hasLiveLocalPty: false
    }
    expect(
      shouldRespawnWebRuntimeTerminalAfterWake({
        ...args,
        event: { ...placeholder(), type: 'snapshot' }
      })
    ).toBe(false)
    expect(
      shouldRespawnWebRuntimeTerminalAfterWake({
        ...args,
        event: { ...terminalFrame([]), type: 'snapshot' }
      })
    ).toBe(true)
  })

  it('does not tell a mounted pane its surface is gone from a frame that cannot vouch', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAcceptedWebSessionTerminalHandle(
      { environmentId: ENV_A, worktreeId: WT, hostTabId: 'a' },
      listener
    )
    queueAcceptedWebSessionTerminalSnapshot(placeholder(), ENV_A)
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()

    queueAcceptedWebSessionTerminalSnapshot(terminalFrame([]), ENV_A)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledWith({ surfacePresent: false, terminalHandle: null })
    unsubscribe()
  })

  // Step 6 through orphan recovery: an omitted row with this host's handle is checked, the host
  // lists nothing, and the frame passes on undecided; only its membership evidence decides.
  it.each([
    ['the unpublished placeholder keeps it', placeholder(), [[id('a'), true]]],
    ['a complete publication removes it', terminalFrame([], { snapshotVersion: 2 }), []]
  ])('after orphan recovery finds no orphan, %s', async (_label, frame, expected) => {
    const state = send(makeState(), ENV_A, terminalFrame(['a']))
    const call = vi.fn(async () => ({
      id: 'list',
      ok: true as const,
      result: { terminals: [], truncated: false },
      _meta: { runtimeId: 'rt' }
    }))

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(state, frame, ENV_A, call)

    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'terminal.list',
        params: expect.objectContaining({ handles: ['a-handle'] })
      })
    )
    expect(recovered).toBe(frame)
    expect(rows(send(state, ENV_A, recovered!))).toEqual(expected)
  })
})
