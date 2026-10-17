// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type * as WebRuntimeSessionModule from './web-runtime-session'
import type * as WebSessionTerminalHandleEventsModule from './web-session-terminal-handle-events'

vi.mock('./web-session-terminal-handle-events', async (importOriginal) => {
  const actual = await importOriginal<typeof WebSessionTerminalHandleEventsModule>()
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return {
    ...actual,
    queueAcceptedWebSessionTerminalSnapshot: frameOrderingMocks.queueAcceptedSnapshot
  }
})

vi.mock('./use-runtime-session-mirror-environment-key', async () => {
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return {
    useRuntimeSessionMirrorEnvironmentKey: frameOrderingMocks.runtimeSessionMirrorEnvironmentKey
  }
})

vi.mock('./web-session-terminal-orphan-recovery', async () => {
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return { recoverWebSessionTerminalOrphansBeforeApply: frameOrderingMocks.recoverSnapshot }
})

vi.mock('./web-runtime-session', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeSessionModule>()
  const { frameOrderingMocks } = await import('./host-session-mirror-frame-fixtures')
  return { ...actual, createWebRuntimeSessionTerminal: frameOrderingMocks.createTerminal }
})

import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'
import {
  takeAllPendingBackgroundTerminalWorktreeMounts,
  takePendingBackgroundTerminalWorktreeMount
} from '@/components/terminal/background-terminal-worktree-mount'
import { wakeSleepingAgentsForWorktreeInBackground } from '@/lib/wake-sleeping-agents-in-background'
import {
  BG_MIRROR_TAB_ID,
  BG_WT,
  ENV,
  frameOrderingMocks as mocks,
  HOST_PARENT_TAB_ID,
  HOST_PTY_ID,
  HOST_SURFACE_ID,
  LEAF_ID,
  MIRROR_TAB_ID,
  makeEmptyHostSnapshot,
  makeHostSnapshot,
  OTHER_HOST_PARENT_TAB_ID,
  OTHER_HOST_SURFACE_ID,
  WT
} from './host-session-mirror-frame-fixtures'
import {
  expectHeldForOwner,
  expectReleasedWithoutRelaunch,
  findSubscription,
  installFrameOrderingHarness,
  publish,
  runtimeCall,
  seedSleepingRecord,
  settle,
  setDocumentVisibility,
  tabIds
} from './host-session-mirror-frame-ordering-harness'
import {
  clearWebSessionTabsTrackingForEnvironment,
  useWebSessionTabsSync,
  WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS
} from './web-session-tabs-sync'
import { hasHostSessionMirrorHydrated } from './host-session-mirror-hydration'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'

/**
 * Parked waiters drain synchronously, so a settle placed before its frame's
 * patch reaches the store re-runs recovery while ptyIdsByTabId is still empty
 * — the pane reads as dead and the duplicate `codex resume` fires anyway.
 * These drive the real handlers because that ordering is the thing under test.
 *
 * The second block pins the other half: this latch releases into replaying a
 * resume, so `unverifiable` must not read as `exited` and settle anything.
 */
describe('mirrored-pane resume deferral against real stream frames', () => {
  installFrameOrderingHarness()

  it('does not relaunch when a stream frame is the first hydration signal', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-ordering-1')

    // Nothing has hydrated yet, so the sweep must park rather than relaunch.
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)
    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])

    // The host answers on the stream, before listAll ever resolves. The frame
    // says this pane's PTY is alive; the replay must see that, not the empty
    // handle map that existed when the frame arrived.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [makeHostSnapshot(WT, HOST_SURFACE_ID, 'host-tab-1')]
    })

    expect(useAppStore.getState().ptyIdsByTabId[MIRROR_TAB_ID]).toEqual([HOST_PTY_ID])
    // RED before the ordering fix: the drain ran while ptyIdsByTabId was still
    // empty, so a second `codex resume` tab was appended here.
    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('a single-worktree frame does not release panes parked on another worktree', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const backgroundPaneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-bg-1')

    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    // The active worktree's scoped mirror answers. It says nothing whatsoever
    // about the background workspace, so that pane must stay parked.
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, HOST_SURFACE_ID, 'host-tab-1')
    })

    expect(tabIds(BG_WT)).toEqual([BG_MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[backgroundPaneKey]).toBeDefined()

    // A full inventory with its owner's evidence DOES speak for every worktree, including by
    // omission (step 6: without evidence the omission would be unverified).
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [makeHostSnapshot(WT, HOST_SURFACE_ID, 'host-tab-1')],
      authoritative: true
    })

    // The background mirror tab was retracted by the inventory: the pane is released, its record
    // retired with it, and nothing relaunches the conversation its owner closed (A4).
    expect(tabIds(BG_WT)).toEqual([])
    expectReleasedWithoutRelaunch(backgroundPaneKey, BG_WT)
  })

  // The three tests below pin the remaining release sites one frame at a time:
  // each delivers ONLY its own path's frame, so a release that stops happening
  // there cannot be covered for by another handler.
  it('the initial listAll releases the pane it parked', async () => {
    let resolveListAll: (response: unknown) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((resolve) => {
            resolveListAll = resolve
          })
        : new Promise(() => {})
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-listall-release')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // The inventory retracts the mirror tab, so the host HAS spoken: this pane
    // is gone and the resume it parked is finally justified.
    await act(async () => {
      resolveListAll({
        id: 'listall',
        ok: true as const,
        result: {
          snapshots: [makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)]
        },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectReleasedWithoutRelaunch(paneKey, WT)
  })

  it('a single frame on the global stream releases the pane it parked', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-global-frame')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectReleasedWithoutRelaunch(paneKey, WT)
  })

  it('the active-worktree scoped frame releases the pane it parked', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-scoped-frame')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
    })

    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectReleasedWithoutRelaunch(paneKey, WT)
  })

  it('does not let a scoped frame from before tracking reset release its pane', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-scoped-old-tracking')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    clearWebSessionTabsTrackingForEnvironment(ENV)
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
    })

    // Why the record may go: the frame still applied, and its owner's membership omits the pane
    // (A4). What it must not do is settle, and nothing may relaunch.
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
    expect(hasHostSessionMirrorHydrated(ENV, WT)).toBe(false)
  })
})

describe('mirror latch verdicts against real stream failures', () => {
  installFrameOrderingHarness()

  it('a rejected inventory keeps a parked pane parked', async () => {
    let rejectListAll: (error: Error) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((_resolve, reject) => {
            rejectListAll = reject
          })
        : new Promise(() => {})
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-listall-reject')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // Contact is lost AFTER the pane parked. That is `unverifiable`, not proof
    // the host-owned PTY exited, so nothing may drain on it.
    await act(async () => {
      rejectListAll(new Error('relay disconnected'))
      await settle()
    })

    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('a scoped stream error settles neither its own worktree nor another', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const activePaneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-active-error')
    const backgroundPaneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-bg-error')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)
    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    await act(async () => {
      findSubscription('session.tabs.subscribe').callbacks.onError?.({
        message: 'stream closed'
      } as never)
      await settle()
    })

    const state = useAppStore.getState()
    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(state.sleepingAgentSessionsByPaneKey[activePaneKey]).toBeDefined()
    expect(tabIds(BG_WT)).toEqual([BG_MIRROR_TAB_ID])
    expect(state.sleepingAgentSessionsByPaneKey[backgroundPaneKey]).toBeDefined()
    expect(Object.keys(state.automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('a spawn that rejects after the patch still settles the frame that landed', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-spawn-reject')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // The wake respawn this frame triggers fails, but the frame it failed after
    // already reached the store — the host is healthy and has spoken.
    mocks.createTerminal.mockRejectedValue(new Error('spawn failed'))
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeEmptyHostSnapshot(WT)
    })

    expect(mocks.createTerminal).toHaveBeenCalled()
    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
    expectReleasedWithoutRelaunch(paneKey, WT)
  })

  it('a rejection before the patch settles nothing', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(MIRROR_TAB_ID, WT, 'codex-session-preapply-reject')
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)

    // Nothing of this frame reached the store, so it is no evidence at all.
    mocks.recoverSnapshot.mockRejectedValue(new Error('orphan recovery failed'))
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
    })

    expect(tabIds(WT)).toEqual([MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()
    expect(Object.keys(useAppStore.getState().automaticAgentResumeClaimsByTabId)).toHaveLength(0)
  })

  it('an inventory whose recovery drops a worktree settles only the applied ones', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const backgroundPaneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-bg-drop')
    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    // The background snapshot never reaches the store, so the pane it would
    // have published a PTY for is still unaccounted for.
    mocks.recoverSnapshot.mockImplementation(
      async (_state: unknown, snapshot: RuntimeMobileSessionTabsResult) =>
        snapshot.worktree === BG_WT ? null : snapshot
    )
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [
        makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID),
        makeHostSnapshot(BG_WT, `host-tab-2::${LEAF_ID}`, 'host-tab-2')
      ]
    })

    expect(useAppStore.getState().ptyIdsByTabId[MIRROR_TAB_ID]).toEqual([HOST_PTY_ID])
    expect(tabIds(BG_WT)).toEqual([BG_MIRROR_TAB_ID])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[backgroundPaneKey]).toBeDefined()
  })
})

// Session parity (C4/F10, step 7): this used to pin that the parked sweep's replay background-mounted
// the resume tab it launched. The workspace a phone opens here belongs to a paired computer, so the
// background wake sweeps nothing in it — before the inventory settles it and after — and there is no
// launched tab to mount: the owner resumes its own conversation, and this computer's record stays
// for the owner's conversation ledger to vouch for or retire.
describe('a background wake in a workspace a paired computer owns', () => {
  installFrameOrderingHarness()
  beforeEach(takeAllPendingBackgroundTerminalWorktreeMounts)
  afterEach(takeAllPendingBackgroundTerminalWorktreeMounts)

  it('launches and mounts nothing, before and after the inventory settles the workspace', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-parked-wake')

    // A phone opens a workspace the desktop is not looking at, while the mirror
    // for its pane is still unanswered.
    wakeSleepingAgentsForWorktreeInBackground(BG_WT)
    expect(takePendingBackgroundTerminalWorktreeMount(BG_WT)).toBeNull()
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeDefined()

    // The inventory settles the background workspace. It carries no evidence, so its omission
    // confirms nothing (step 6): the pane is still listed here — by its owner, who alone resumes it.
    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshots',
      snapshots: [makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)]
    })

    expectHeldForOwner(paneKey, BG_WT, BG_MIRROR_TAB_ID)
    // Why: nothing was launched, so there is no tab to background-mount either.
    expect(takePendingBackgroundTerminalWorktreeMount(BG_WT)).toBeNull()
  })
})

describe('an inventory whose post-patch bookkeeping throws', () => {
  installFrameOrderingHarness({ fakeTimers: true })

  it('still settles the frames that reached the store', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    // Seeds this worktree's freshness — so the resume inventory reads as
    // unchanged for it — without settling the environment latch.
    await publish(findSubscription('session.tabs.subscribe'), {
      type: 'snapshot',
      ...makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID)
    })
    const paneKey = seedSleepingRecord(BG_MIRROR_TAB_ID, BG_WT, 'codex-session-bookkeeping-throw')
    expect(resumeSleepingAgentSessionsForWorktree(BG_WT)).toBe(0)

    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
      vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS)
    })
    await act(settle)

    // Bookkeeping for the unchanged worktree fails AFTER the background
    // worktree's patch landed — a healthy host that has already spoken.
    mocks.queueAcceptedSnapshot.mockImplementation((snapshot: RuntimeMobileSessionTabsResult) => {
      if (snapshot.worktree === WT) {
        throw new Error('accepted-handle queue failed')
      }
    })
    await publish(findSubscription('session.tabs.subscribeAll', 1), {
      type: 'snapshots',
      snapshots: [
        makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID),
        makeHostSnapshot(BG_WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
      ]
    })

    // Only the post-patch site queues the unchanged worktree, so this proves
    // the throw landed after the background patch reached the store.
    expect(mocks.queueAcceptedSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ worktree: WT }),
      ENV
    )
    expect(tabIds(BG_WT)).not.toContain(BG_MIRROR_TAB_ID)
    expectReleasedWithoutRelaunch(paneKey, BG_WT)
  })
})
