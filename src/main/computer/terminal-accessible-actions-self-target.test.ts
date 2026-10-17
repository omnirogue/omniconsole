import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComputerSnapshotResult } from '../../shared/runtime-types'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { callComputerSidecarAction, callComputerSidecarSnapshot } from './sidecar-client'
import {
  registerSelfTargetAccessibilityHost,
  resetSelfTargetAccessibilityForTest
} from './self-target-accessibility'
import {
  observeTerminalAccessibleSnapshot,
  performTerminalAccessibleAction,
  resetTerminalAccessibleSnapshots
} from './terminal-accessible-actions'

vi.mock('./terminal-accessible-renderer', () => ({ actOnTerminalAccessibleRenderer: vi.fn() }))
vi.mock('./sidecar-client', () => ({
  callComputerSidecarAction: vi.fn(),
  callComputerSidecarSnapshot: vi.fn()
}))

const CHROME_ONLY_TREE = '0 window Orca\n  1 container\n  2 close button'

function snapshot(treeText: string, elementCount: number): ComputerSnapshotResult {
  return {
    snapshot: {
      id: 'snapshot',
      app: { name: 'OmniConsole', bundleId: 'com.omniconsole.ide', pid: process.pid },
      window: { title: 'Orca', width: 1200, height: 800 },
      coordinateSpace: 'window',
      treeText,
      elementCount,
      focusedElementId: null
    },
    screenshot: null,
    screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' }
  }
}

function runtime() {
  return {
    resolveTerminalPane: vi.fn().mockReturnValue({ handle: 'terminal-a' }),
    focusTerminal: vi.fn().mockResolvedValue({ navigated: true })
  } as unknown as Pick<OrcaRuntimeService, 'resolveTerminalPane' | 'focusTerminal'>
}

function registerHost(options: { focused: boolean }) {
  const setEnabled = vi.fn()
  const focus = vi.fn()
  const focused = { value: options.focused }
  let enabled = false
  const unregister = registerSelfTargetAccessibilityHost({
    appName: () => 'OmniConsole',
    pid: process.pid,
    isAccessibilitySupportEnabled: () => enabled,
    setAccessibilitySupportEnabled: (value) => {
      enabled = value
      setEnabled(value)
    },
    window: {
      isDestroyed: () => false,
      isFocused: () => focused.value,
      focus: () => {
        focus()
        focused.value = true
      },
      onceFocused: (listener) => {
        listener()
        return () => {}
      }
    },
    log: () => {},
    setTimer: () => 1,
    clearTimer: () => {}
  })
  return { setEnabled, focus, focused, unregister }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetTerminalAccessibleSnapshots()
  resetSelfTargetAccessibilityForTest()
  vi.mocked(callComputerSidecarSnapshot).mockResolvedValue(snapshot(CHROME_ONLY_TREE, 5))
  vi.mocked(callComputerSidecarAction).mockResolvedValue(snapshot(CHROME_ONLY_TREE, 5))
})
afterEach(() => {
  resetSelfTargetAccessibilityForTest()
})

describe('computer-use targeting OmniConsole itself', () => {
  it('enables accessibility support and refuses a chrome-only observation', async () => {
    const host = registerHost({ focused: true })

    await expect(
      observeTerminalAccessibleSnapshot({ app: 'com.omniconsole.ide' }, runtime())
    ).rejects.toMatchObject({ code: 'accessibility_tree_unavailable' })
    expect(host.setEnabled.mock.calls).toEqual([[true]])
  })

  it('returns the observation once the renderer tree is exposed', async () => {
    registerHost({ focused: true })
    vi.mocked(callComputerSidecarSnapshot).mockResolvedValue(
      snapshot(`${CHROME_ONLY_TREE}\n  3 html content Orca`, 441)
    )

    await expect(
      observeTerminalAccessibleSnapshot({ app: 'OmniConsole' }, runtime())
    ).resolves.toMatchObject({ snapshot: { elementCount: 441 } })
  })

  it('takes focus through the app window before acting on itself', async () => {
    const host = registerHost({ focused: false })

    await performTerminalAccessibleAction('click', { app: 'OmniConsole' }, runtime())

    expect(host.focus).toHaveBeenCalledTimes(1)
    expect(callComputerSidecarAction).toHaveBeenCalledTimes(1)
  })

  it('leaves a foreign app to the provider focus guard', async () => {
    const host = registerHost({ focused: false })

    await performTerminalAccessibleAction('click', { app: 'Spotify' }, runtime())

    expect(host.focus).not.toHaveBeenCalled()
    expect(host.setEnabled).not.toHaveBeenCalled()
  })

  it('enables the renderer tree for a snapshot that is us under a name it does not answer to', async () => {
    // Windows and Linux list this window by its executable name, which matches no
    // self-selector form — the snapshot's pid is what proves it is us.
    const host = registerHost({ focused: true })

    await expect(
      observeTerminalAccessibleSnapshot({ app: 'Orca' }, runtime())
    ).rejects.toMatchObject({
      code: 'accessibility_tree_unavailable',
      message: expect.stringContaining('accessibility support was enabled for this request')
    })
    expect(host.setEnabled.mock.calls).toEqual([[true]])
  })

  it('does not judge the tree of a sibling install that answers to our bundle id', async () => {
    // The dev copy and the packaged app coexist; a chrome-only tree from the OTHER one
    // is not ours to refuse, and enabling accessibility here would repair nothing.
    registerHost({ focused: true })
    const sibling = snapshot(CHROME_ONLY_TREE, 5)
    sibling.snapshot.app = {
      name: 'OmniConsole',
      bundleId: 'com.omniconsole.ide',
      pid: process.pid + 1
    }
    vi.mocked(callComputerSidecarSnapshot).mockResolvedValue(sibling)

    await expect(
      observeTerminalAccessibleSnapshot({ app: 'com.omniconsole.ide' }, runtime())
    ).resolves.toMatchObject({ snapshot: { elementCount: 5 } })
  })

  it('does not assert the tree for a foreign app', async () => {
    registerHost({ focused: true })
    const foreign = snapshot(CHROME_ONLY_TREE, 5)
    foreign.snapshot.app = { name: 'Spotify', bundleId: 'com.spotify.client', pid: process.pid + 1 }
    vi.mocked(callComputerSidecarSnapshot).mockResolvedValue(foreign)

    await expect(
      observeTerminalAccessibleSnapshot({ app: 'Spotify' }, runtime())
    ).resolves.toMatchObject({ snapshot: { elementCount: 5 } })
  })
})
