// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { tagRuntimeSubscriptionReplayResponse } from '../../../shared/runtime-subscription-replay'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
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
import {
  BG_WT,
  HOST_PARENT_TAB_ID,
  HOST_SURFACE_ID,
  makeHostSnapshot,
  makeWorktree,
  OTHER_HOST_PARENT_TAB_ID,
  OTHER_HOST_SURFACE_ID,
  REPO_ID,
  WT
} from './host-session-mirror-frame-fixtures'
import {
  findSubscription,
  installFrameOrderingHarness,
  settle,
  setDocumentVisibility
} from './host-session-mirror-frame-ordering-harness'
import {
  useWebSessionTabsSync,
  WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS
} from './web-session-tabs-sync'
import { WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS } from './window-visibility-subscription-parking'

// A MacBook worktree removed while this window was parked: known here only by this computer's
// record of one of its panes (live 6 Oct: the review-1411-1412-* records).
const REMOVED_WT = `${REPO_ID}::/workspace/removed-on-owner`
const LEAF = '11111111-1111-4111-8111-111111111111'

function seedRecordOnlyWorkspace(): string {
  const tabId = toWebTerminalSurfaceTabId('closed-host-tab')
  const paneKey = makePaneKey(tabId, LEAF)
  useAppStore.setState((state) => ({
    worktreesByRepo: {
      ...state.worktreesByRepo,
      [REPO_ID]: [
        ...(state.worktreesByRepo[REPO_ID] ?? []),
        makeWorktree(REMOVED_WT, '/workspace/removed-on-owner')
      ]
    },
    sleepingAgentSessionsByPaneKey: {
      ...state.sleepingAgentSessionsByPaneKey,
      [paneKey]: {
        paneKey,
        tabId,
        worktreeId: REMOVED_WT,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'codex-session-removed' },
        prompt: '',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        origin: 'live'
      }
    }
  }))
  return paneKey
}

describe('a reconnect replay inside a visibility-restart subscription (A4)', () => {
  installFrameOrderingHarness({ fakeTimers: true })

  it('reconciles omitted workspaces, record-only ones included', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)
    const paneKey = seedRecordOnlyWorkspace()

    // The window parks and resumes: the global stream restarts as a visibility subscription.
    act(() => {
      setDocumentVisibility('hidden')
      vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
      setDocumentVisibility('visible')
      vi.advanceTimersByTime(WEB_SESSION_TABS_VISIBILITY_RESUME_STAGGER_MS)
    })
    await act(settle)
    const resumed = findSubscription('session.tabs.subscribeAll', 1)

    // Then the network drops and the connection replays the stream: the owner's inventory, with
    // its scoped evidence, omits the removed worktree.
    await act(async () => {
      resumed.callbacks.onResponse(
        tagRuntimeSubscriptionReplayResponse({
          id: 'replayed-inventory',
          ok: true as const,
          result: {
            type: 'snapshots',
            snapshots: [
              makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID),
              makeHostSnapshot(BG_WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID)
            ],
            coverage: { unverifiedRepoIds: [], unverifiedWorkspaces: [] }
          },
          _meta: { runtimeId: 'runtime-a' }
        }) as never
      )
      await settle()
    })

    // Before the fix a visibility-restart subscription never reconciled them, replay or not.
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
  })
})
