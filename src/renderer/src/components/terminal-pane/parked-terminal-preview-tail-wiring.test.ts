import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ParkedTerminalCommandStatus from './parked-terminal-command-status'
import type { startParkedTerminalByteWatcher } from './parked-terminal-byte-watcher'
import type * as ParkedPreviewTail from './terminal-parked-preview-tail'

type StartWatcher = typeof startParkedTerminalByteWatcher

const PTY_ID = 'pty-preview-1'
const OTHER_PTY_ID = 'pty-preview-2'
const LEAF_ID = '33333333-3333-4333-8333-333333333333'

type MockStoreState = {
  settings: {
    terminalMainSideEffectAuthority?: boolean
    notifications?: { enabled?: boolean; agentTaskComplete?: boolean }
  } | null
  setRuntimePaneTitle: ReturnType<typeof vi.fn>
  clearRuntimePaneTitle: ReturnType<typeof vi.fn>
  updateTabTitle: ReturnType<typeof vi.fn>
  markWorktreeUnread: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  setCacheTimerStartedAt: ReturnType<typeof vi.fn>
  observeTerminalGitHubPullRequestLink: ReturnType<typeof vi.fn>
  agentStatusByPaneKey: Record<string, unknown>
}

let mockStoreState: MockStoreState

vi.mock('./use-notification-dispatch', () => ({
  dispatchTerminalNotification: vi.fn()
}))

vi.mock('./parked-terminal-command-status', async (importOriginal) => ({
  ...(await importOriginal<typeof ParkedTerminalCommandStatus>()),
  createParkedTerminalCommandStatusPolicy: vi.fn(() => ({
    onCommandFinished: vi.fn(),
    onCommandCodeWorking: vi.fn(),
    onCommandCodeDone: vi.fn(),
    dispose: vi.fn()
  }))
}))

vi.mock('@/lib/terminal-theme', () => ({
  getSystemPrefersDark: () => true
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState
  }
}))

function createMockStoreState(mainAuthority: boolean): MockStoreState {
  return {
    settings: {
      terminalMainSideEffectAuthority: mainAuthority,
      notifications: { enabled: false, agentTaskComplete: false }
    },
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabTitle: vi.fn(),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    markTerminalPaneUnread: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    observeTerminalGitHubPullRequestLink: vi.fn(),
    agentStatusByPaneKey: {}
  }
}

describe('parked watcher preview-tail wiring', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window
  const dataListeners: ((payload: { id: string; data: string }) => void)[] = []

  function emit(ptyId: string, data: string): void {
    for (const listener of dataListeners) {
      listener({ id: ptyId, data })
    }
  }

  async function loadModules(): Promise<{
    start: StartWatcher
    tail: typeof ParkedPreviewTail
  }> {
    const watcher = await import('./parked-terminal-byte-watcher')
    const tail = await import('./terminal-parked-preview-tail')
    return { start: watcher.startParkedTerminalByteWatcher, tail }
  }

  function watch(start: StartWatcher, ptyId: string = PTY_ID): () => void {
    return start({
      ptyId,
      tabId: `tab-${ptyId}`,
      worktreeId: 'repo::/wt',
      leafId: LEAF_ID,
      paneId: 1
    })
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    dataListeners.length = 0
    mockStoreState = createMockStoreState(false)
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        pty: {
          onData: vi.fn((callback: (payload: { id: string; data: string }) => void) => {
            dataListeners.push(callback)
            return () => {
              const index = dataListeners.indexOf(callback)
              if (index !== -1) {
                dataListeners.splice(index, 1)
              }
            }
          }),
          onReplay: vi.fn(() => () => {}),
          onExit: vi.fn(() => () => {}),
          ackData: vi.fn(),
          write: vi.fn()
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    vi.useRealTimers()
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('records sanitized parked output as the PTY preview tail', async () => {
    const { start, tail } = await loadModules()
    const dispose = watch(start)

    emit(PTY_ID, '\x1b]0;⠋ Build feature\x07\x1b[32mcompiled 12 files\x1b[0m\r\n$ ')
    vi.advanceTimersByTime(0)

    expect(tail.getParkedTerminalPreviewTail(PTY_ID)).toMatchObject({
      sourceKind: 'recent-output',
      lastPreviewLines: ['compiled 12 files', '$ '],
      truncated: false
    })
    dispose()
  })

  it('keeps titles flowing to the store while the preview captures text', async () => {
    const { start, tail } = await loadModules()
    const dispose = watch(start)

    emit(PTY_ID, '\x1b]0;✳ Build feature\x07done\n')
    vi.advanceTimersByTime(0)

    expect(mockStoreState.setRuntimePaneTitle).toHaveBeenCalled()
    expect(tail.getParkedTerminalPreviewTail(PTY_ID)?.lastPreviewLines).toEqual(['done'])
    dispose()
  })

  it('ignores bytes addressed to another PTY', async () => {
    const { start, tail } = await loadModules()
    const dispose = watch(start)

    emit(OTHER_PTY_ID, 'not mine\n')

    expect(tail.getParkedTerminalPreviewTail(PTY_ID)).toBeNull()
    expect(tail.getParkedTerminalPreviewTail(OTHER_PTY_ID)).toBeNull()
    dispose()
  })

  it('clears the preview when the watcher is disposed for reveal', async () => {
    const { start, tail } = await loadModules()
    const dispose = watch(start)
    emit(PTY_ID, 'before reveal\n')
    expect(tail.getParkedTerminalPreviewTail(PTY_ID)).not.toBeNull()

    dispose()

    expect(tail.getParkedTerminalPreviewTail(PTY_ID)).toBeNull()
    expect(tail.getParkedTerminalPreviewTailCensus()).toEqual({ tails: 0, bytes: 0 })
  })

  it('stops recording after dispose even if late bytes arrive', async () => {
    const { start, tail } = await loadModules()
    const dispose = watch(start)
    dispose()

    emit(PTY_ID, 'late\n')

    expect(tail.getParkedTerminalPreviewTail(PTY_ID)).toBeNull()
  })

  it('starts a fresh preview epoch when the PTY is parked again', async () => {
    const { start, tail } = await loadModules()
    const firstDispose = watch(start)
    emit(PTY_ID, 'first park\n')
    const firstEpoch = tail.getParkedTerminalPreviewTail(PTY_ID)?.epoch
    firstDispose()

    const secondDispose = watch(start)
    emit(PTY_ID, 'second park\n')
    const second = tail.getParkedTerminalPreviewTail(PTY_ID)

    expect(second?.lastPreviewLines).toEqual(['second park'])
    expect(second?.epoch).not.toBe(firstEpoch)
    secondDispose()
  })

  it('replacing a stale watcher for the same PTY drops the stale preview', async () => {
    const { start, tail } = await loadModules()
    watch(start)
    emit(PTY_ID, 'stale\n')

    const dispose = watch(start)

    expect(tail.getParkedTerminalPreviewTail(PTY_ID)).toBeNull()
    emit(PTY_ID, 'fresh\n')
    expect(tail.getParkedTerminalPreviewTail(PTY_ID)?.lastPreviewLines).toEqual(['fresh'])
    dispose()
  })

  it('keeps per-PTY previews separate across concurrent parked watchers', async () => {
    const { start, tail } = await loadModules()
    const disposeFirst = watch(start, PTY_ID)
    const disposeSecond = watch(start, OTHER_PTY_ID)

    emit(PTY_ID, 'alpha\n')
    emit(OTHER_PTY_ID, 'beta\n')

    expect(tail.getParkedTerminalPreviewTail(PTY_ID)?.lastPreviewLines).toEqual(['alpha'])
    expect(tail.getParkedTerminalPreviewTail(OTHER_PTY_ID)?.lastPreviewLines).toEqual(['beta'])
    disposeFirst()
    expect(tail.getParkedTerminalPreviewTail(OTHER_PTY_ID)).not.toBeNull()
    disposeSecond()
  })

  it('records nothing under main side-effect authority, where raw bytes never reach the renderer', async () => {
    mockStoreState = createMockStoreState(true)
    const { start, tail } = await loadModules()
    const dispose = watch(start)

    emit(PTY_ID, 'facts only\n')

    expect(tail.getParkedTerminalPreviewTail(PTY_ID)).toBeNull()
    dispose()
  })
})
