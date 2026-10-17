// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
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

import {
  frameOrderingMocks as mocks,
  HOST_PARENT_TAB_ID,
  HOST_SURFACE_ID,
  makeHostSnapshot,
  MIRROR_TAB_ID,
  OTHER_HOST_PARENT_TAB_ID,
  OTHER_HOST_SURFACE_ID,
  WT
} from './host-session-mirror-frame-fixtures'
import {
  findSubscription,
  installFrameOrderingHarness,
  publish,
  runtimeCall,
  settle,
  tabIds
} from './host-session-mirror-frame-ordering-harness'
import { useWebSessionTabsSync } from './web-session-tabs-sync'

function ordered(
  snapshot: RuntimeMobileSessionTabsResult,
  epoch: string,
  revision: number
): RuntimeMobileSessionTabsResult {
  return { ...snapshot, publicationEpoch: epoch, inventoryOrder: { generation: 'gen', revision } }
}

/**
 * The receiver's arrival-order gates (latest received, recovery supersession) run before the
 * ordering decision; driven through the real subscribeAll and listAll handlers, because the race
 * between them is the thing under test.
 */
describe('owner order decides in the receiver pipeline, not arrival (step 3)', () => {
  installFrameOrderingHarness()

  it('keeps a stream frame whose recovery is in flight over an older listAll reply', async () => {
    let resolveListAll: (response: unknown) => void = () => {}
    runtimeCall.mockImplementation((request: { method: string }) =>
      request.method === 'session.tabs.listAll'
        ? new Promise((resolve) => {
            resolveListAll = resolve
          })
        : new Promise(() => {})
    )
    let finishStreamRecovery: () => void = () => {}
    mocks.recoverSnapshot.mockImplementation(
      async (_state: unknown, snapshot: RuntimeMobileSessionTabsResult) => {
        if (snapshot.inventoryOrder?.revision === 7) {
          await new Promise<void>((resolve) => {
            finishStreamRecovery = resolve
          })
        }
        return snapshot
      }
    )
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    // Revision 7 arrives on the stream; its orphan recovery is still running.
    const newer = ordered(
      makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID),
      'renderer:after-reload',
      7
    )
    await publish(findSubscription('session.tabs.subscribeAll'), { type: 'snapshot', ...newer })

    // Then the initial listAll reply lands, older (revision 6) and under another epoch.
    const older = ordered(
      makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID),
      'renderer:a',
      6
    )
    await act(async () => {
      resolveListAll({
        id: 'listall',
        ok: true as const,
        result: { snapshots: [older] },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })
    await act(async () => {
      finishStreamRecovery()
      await settle()
    })

    // Before the fix: revision 6 became "latest received", revision 7 was skipped as superseded,
    // and revision 6 (older than nothing accepted yet) was applied.
    expect(tabIds(WT)).toEqual([toWebTerminalSurfaceTabId(OTHER_HOST_PARENT_TAB_ID)])
    expect(tabIds(WT)).not.toContain(MIRROR_TAB_ID)
  })

  it('still lets a newer listAll reply win over an older stream frame', async () => {
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

    await publish(findSubscription('session.tabs.subscribeAll'), {
      type: 'snapshot',
      ...ordered(makeHostSnapshot(WT, HOST_SURFACE_ID, HOST_PARENT_TAB_ID), 'renderer:a', 6)
    })
    await act(async () => {
      resolveListAll({
        id: 'listall',
        ok: true as const,
        result: {
          snapshots: [
            ordered(
              makeHostSnapshot(WT, OTHER_HOST_SURFACE_ID, OTHER_HOST_PARENT_TAB_ID),
              'renderer:b',
              7
            )
          ]
        },
        _meta: { runtimeId: 'runtime-a' }
      })
      await settle()
    })

    expect(tabIds(WT)).toEqual([toWebTerminalSurfaceTabId(OTHER_HOST_PARENT_TAB_ID)])
  })
})
