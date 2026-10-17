import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHarnessStoreState, loadIpcEventsHarness } from './ipc-events-test-harness'

describe('useIpcEvents terminal create title', () => {
  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => {
    rejections.push(reason)
  }
  beforeEach(() => {
    rejections.length = 0
    process.on('unhandledRejection', onRejection)
  })
  afterEach(() => {
    process.off('unhandledRejection', onRejection)
  })

  it('names a new tab from a store with no tab maps yet, without an unhandled rejection', async () => {
    // Why no unifiedTabsByWorktree: a window before hydration has none, and the record reads it.
    const storeState = createHarnessStoreState({
      tabsByWorktree: {},
      worktreesByRepo: { 'repo-1': [{ id: 'wt-2', repoId: 'repo-1' }] }
    })
    const harness = await loadIpcEventsHarness(storeState)
    harness.useIpcEvents()

    harness.requestTerminalCreate({
      requestId: 'req-title',
      worktreeId: 'wt-2',
      title: 'Refund triage',
      titleOrigin: 'generated'
    })

    expect(harness.replyTerminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-title', title: 'Refund triage' })
    )
    await vi.waitFor(() =>
      expect(storeState.setTabCustomTitle).toHaveBeenCalledWith(
        expect.any(String),
        'Refund triage',
        { recordInteraction: false, origin: 'generated' }
      )
    )
    // Why a macrotask: an unhandled rejection is reported after the microtask queue drains.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rejections).toEqual([])
  })
})
