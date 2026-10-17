import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pasteDraftWhenAgentReady } from './agent-paste-draft'
import { markAgentStartInFlight, resetAgentStartsInFlightForTests } from './agent-start-in-flight'

// Why: main admits at most 3 agent starts per rolling 10 s. A launch whose start waits for a slot
// has no PTY for longer than the 8 s spawn budget; that must not drop the launch prompt.

const testState = vi.hoisted(() => ({
  appState: {
    settings: {},
    ptyIdsByTabId: {} as Record<string, string[]>,
    tabsByWorktree: {}
  },
  storeSubscribers: new Set<(state: { ptyIdsByTabId: Record<string, string[]> }) => void>(),
  waitForReady: vi.fn(),
  sendPaste: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => testState.appState,
    subscribe: (
      subscriber: (state: { ptyIdsByTabId: Record<string, string[]> }) => void
    ): (() => void) => {
      testState.storeSubscribers.add(subscriber)
      return () => testState.storeSubscribers.delete(subscriber)
    }
  }
}))

vi.mock('./agent-draft-readiness', () => ({
  waitForAgentDraftInputReady: testState.waitForReady
}))

vi.mock('./agent-bracketed-paste-transaction', () => ({
  sendBracketedPasteToAgent: testState.sendPaste,
  POST_PASTE_SUBMIT_DELAY_MS: 0
}))

vi.mock('./agent-startup-review', () => ({
  waitForAgentStartupReview: async () => true
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(async () => null),
  sendRuntimePtyInputVerified: vi.fn(async () => true),
  isRemoteRuntimePtyId: vi.fn(() => false)
}))

function spawnPty(tabId: string, ptyId: string): void {
  testState.appState.ptyIdsByTabId = { [tabId]: [ptyId] }
  for (const subscriber of Array.from(testState.storeSubscribers)) {
    subscriber(testState.appState)
  }
}

describe('launch prompt delivery behind the agent start admission queue', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    })
    resetAgentStartsInFlightForTests()
    testState.appState.ptyIdsByTabId = {}
    testState.storeSubscribers.clear()
    testState.waitForReady.mockReset()
    testState.waitForReady.mockResolvedValue(true)
    testState.sendPaste.mockReset()
    testState.sendPaste.mockResolvedValue(true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('still pastes when the start waited more than 8 s for an admission slot', async () => {
    const release = markAgentStartInFlight('tab-1')
    const onTimeout = vi.fn()
    const delivered = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: 'fix the flaky test',
      agent: 'gemini',
      forcePaste: true,
      onTimeout
    })

    // Queued behind a full window for 14 s; the spawn budget alone is 8 s.
    await vi.advanceTimersByTimeAsync(14_000)
    expect(onTimeout).not.toHaveBeenCalled()
    release()
    spawnPty('tab-1', 'pty-1')

    await expect(delivered).resolves.toBe(true)
    expect(onTimeout).not.toHaveBeenCalled()
    expect(testState.sendPaste).toHaveBeenCalledWith(
      expect.objectContaining({ ptyId: 'pty-1', content: 'fix the flaky test' })
    )
  })

  it('keeps the 8 s verdict when no start is in flight for the tab', async () => {
    const onTimeout = vi.fn()
    const delivered = pasteDraftWhenAgentReady({
      tabId: 'tab-1',
      content: 'fix the flaky test',
      agent: 'gemini',
      forcePaste: true,
      onTimeout
    })
    await vi.advanceTimersByTimeAsync(8_000)
    await expect(delivered).resolves.toBe(false)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    expect(testState.sendPaste).not.toHaveBeenCalled()
  })
})
