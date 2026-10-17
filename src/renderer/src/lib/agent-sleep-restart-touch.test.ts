import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetAgentHibernationCoordinatorForTests } from './agent-hibernation-coordinator'
import {
  setHibernationPaneAgeStorageForTests,
  simulateHibernationPaneAgeRestartForTests
} from './agent-hibernation-pane-age'
import { persistHibernationPaneTouchesNow } from './agent-hibernation-plan-now'
import {
  resetForegroundTerminalTabIdsForTests,
  setForegroundTerminalTabIds
} from './foreground-terminal-tabs'
import {
  daemonSessions,
  HIBERNATION,
  install,
  MIN,
  NOW,
  PANE,
  setUpAgentSleepTest,
  tearDownAgentSleepTest,
  ticks
} from './agent-sleep-test-fixture'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const data = new Map<string, string>()
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key)
  }
}

/** What an app restart does: the window's memory is gone; storage and the daemon PTY stay. */
function restartApp(): void {
  resetAgentHibernationCoordinatorForTests()
  simulateHibernationPaneAgeRestartForTests()
  resetForegroundTerminalTabIdsForTests()
  useAppStore.setState({ lastTerminalInputAtByPaneKey: {} })
}

beforeEach(() => {
  setUpAgentSleepTest()
  setHibernationPaneAgeStorageForTests(memoryStorage())
})
afterEach(tearDownAgentSleepTest)

describe('an app restart keeps the idle clock and what guards it (requirement 4, G2)', () => {
  it('never sleeps a pane holding a draft typed after its agent finished', async () => {
    const shutdown = install(HIBERNATION)
    useAppStore.getState().recordTerminalInput(PANE, NOW - 20 * MIN)
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    restartApp()
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('keeps a pane revealed 5 minutes before the restart, and sleeps it a window later', async () => {
    const shutdown = install(HIBERNATION)
    vi.setSystemTime(NOW - 6 * MIN)
    setForegroundTerminalTabIds(['tab-1'])
    vi.setSystemTime(NOW - 5 * MIN)
    setForegroundTerminalTabIds([])
    vi.setSystemTime(NOW)
    await ticks(1)
    restartApp()
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
    // The carried reveal only floors the window; it does not keep the pane forever.
    vi.setSystemTime(NOW + 26 * MIN)
    await ticks(2)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('saves a keystroke the last tick never saw when the window goes away', async () => {
    const shutdown = install(HIBERNATION)
    await ticks(1)
    useAppStore.getState().recordTerminalInput(PANE, Date.now())
    persistHibernationPaneTouchesNow()
    restartApp()
    await ticks(3)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('still sleeps an untouched pane right after the restart (the clock is not reset)', async () => {
    const shutdown = install(HIBERNATION)
    await ticks(1)
    restartApp()
    await ticks(2)
    expect(shutdown).toHaveBeenCalledTimes(1)
    // One listing names the PTY's lifetime before the restart, one proves it after; no more.
    expect(daemonSessions).toHaveBeenCalledTimes(2)
  })

  it('gives a pane cold-restored under the same PTY id a fresh window', async () => {
    const shutdown = install(HIBERNATION)
    await ticks(1)
    restartApp()
    // The daemon died with the restart; the pane came back as a new process under the old id.
    daemonSessions.mockImplementation(async () => [
      { sessionId: 'pty-1', incarnationId: 'restored-after-reboot', pid: 5151 }
    ])
    await ticks(5)
    expect(shutdown).not.toHaveBeenCalled()
    // It still sleeps once a full window passes without a touch.
    vi.setSystemTime(Date.now() + 30 * MIN)
    await ticks(2)
    expect(shutdown).toHaveBeenCalledTimes(1)
  })

  it('gives a fresh window when the daemon cannot be listed after the restart', async () => {
    const shutdown = install(HIBERNATION)
    await ticks(1)
    restartApp()
    daemonSessions.mockImplementation(async () => {
      throw new Error('daemon unavailable')
    })
    await ticks(5)
    expect(shutdown).not.toHaveBeenCalled()
  })
})
