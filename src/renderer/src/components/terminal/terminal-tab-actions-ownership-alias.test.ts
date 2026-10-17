import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'

// Why: drives the real closeTerminalTab against the real store so a person's close of a mirror
// whose owner evidence conflicts is proven to retract only the local row.

const runtime = vi.hoisted(() => ({
  closeWebRuntimeSessionTab: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => true)
}))

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/runtime/web-runtime-session', () => ({
  activateWebRuntimeSessionTab: vi.fn(),
  closeWebRuntimeSessionTab: runtime.closeWebRuntimeSessionTab,
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: runtime.isWebRuntimeSessionActive,
  isWebTerminalSurfaceTabId: vi.fn(() => true),
  toHostSessionTabId: vi.fn((tabId: string) => tabId)
}))

vi.mock('@/runtime/web-session-tabs-sync', () => ({
  getLatestWebSessionTabsPublicationEpoch: vi.fn(() => null),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(() => null)
}))

const { createTabsSliceMockApi } = await import('@/store/slices/tabs-slice-test-harness')
createTabsSliceMockApi()

const { createTestStore, makeTab, makeTabGroup, makeUnifiedTab, makeWorktree, seedStore } =
  await import('@/store/slices/store-test-helpers')
const store = createTestStore()

vi.mock('@/store', () => ({ useAppStore: store }))

const { closeTerminalTab } = await import('./terminal-tab-actions')

const WT = 'repo1::/tmp/wt1'
const GROUP = 'group-1'
const ALIAS = toWebTerminalSurfaceTabId('host-alias')

function seedAlias(): void {
  seedStore(store, {
    activeWorktreeId: WT,
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/tmp/wt1' })] },
    // Why conflicting: the PTY names env-a while the saved stamp names env-b.
    tabsByWorktree: {
      [WT]: [makeTab({ id: ALIAS, worktreeId: WT, ptyId: 'remote:env-a@@handle' })]
    },
    unifiedTabsByWorktree: {
      [WT]: [
        makeUnifiedTab({
          id: ALIAS,
          entityId: ALIAS,
          groupId: GROUP,
          worktreeId: WT,
          executionHostId: 'runtime:env-b'
        })
      ]
    },
    groupsByWorktree: {
      [WT]: [makeTabGroup({ id: GROUP, worktreeId: WT, activeTabId: ALIAS, tabOrder: [ALIAS] })]
    },
    layoutByWorktree: { [WT]: { type: 'leaf', groupId: GROUP } },
    activeGroupIdByWorktree: { [WT]: GROUP },
    activeTabId: ALIAS,
    activeTabIdByWorktree: { [WT]: ALIAS },
    activeTabType: 'terminal',
    openFiles: [],
    browserTabsByWorktree: {}
  } as Partial<AppState>)
}

beforeEach(() => {
  runtime.closeWebRuntimeSessionTab.mockReset()
  seedAlias()
})

describe('closing a mirror whose owning computer cannot be verified', () => {
  it("retracts the row locally on a person's close, with no RPC to a guessed computer", () => {
    const onClosed = vi.fn()
    closeTerminalTab(ALIAS, { reason: 'user', skipRunningProcessConfirm: true, onClosed })

    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(store.getState().tabsByWorktree[WT] ?? []).toEqual([])
    expect(runtime.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
  })

  it('keeps the row when only its stream exited', () => {
    const onCancel = vi.fn()
    closeTerminalTab(ALIAS, { reason: 'pty-exit', onCancel })

    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(store.getState().tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([ALIAS])
    expect(runtime.closeWebRuntimeSessionTab).not.toHaveBeenCalled()
  })
})
