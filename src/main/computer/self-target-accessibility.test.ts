import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isSelfTargetedComputerApp,
  prepareSelfTargetedComputerRequest,
  registerSelfTargetAccessibilityHost,
  resetSelfTargetAccessibilityForTest,
  selfTargetAccessibilityActive,
  type SelfTargetAccessibilityHost
} from './self-target-accessibility'

type Harness = {
  host: SelfTargetAccessibilityHost
  unregister: () => void
  focus: ReturnType<typeof vi.fn>
  setEnabled: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
  timers: (() => void)[]
  cleared: unknown[]
  focused: { value: boolean }
  focusListeners: (() => void)[]
}

function harness(
  options: { focused?: boolean; alreadyEnabled?: boolean; appName?: string } = {}
): Harness {
  const focused = { value: options.focused ?? true }
  const focusListeners: (() => void)[] = []
  const timers: (() => void)[] = []
  const setEnabled = vi.fn()
  const log = vi.fn()
  let enabled = options.alreadyEnabled ?? false
  const focus = vi.fn()
  const cleared: unknown[] = []
  const host: SelfTargetAccessibilityHost = {
    appName: () => options.appName ?? 'OmniConsole',
    pid: 4242,
    isAccessibilitySupportEnabled: () => enabled,
    setAccessibilitySupportEnabled: (value) => {
      enabled = value
      setEnabled(value)
    },
    window: {
      isDestroyed: () => false,
      isFocused: () => focused.value,
      focus,
      onceFocused: (listener) => {
        focusListeners.push(listener)
        return () => {
          const index = focusListeners.indexOf(listener)
          if (index !== -1) {
            focusListeners.splice(index, 1)
          }
        }
      }
    },
    log,
    setTimer: (handler) => {
      timers.push(handler)
      return timers.length
    },
    clearTimer: (timer) => {
      cleared.push(timer)
    },
    focusTimeoutMs: 5,
    sessionIdleMs: 10
  }
  const unregister = registerSelfTargetAccessibilityHost(host)
  return { host, unregister, focus, setEnabled, log, timers, cleared, focused, focusListeners }
}

beforeEach(() => {
  resetSelfTargetAccessibilityForTest()
})
afterEach(() => {
  resetSelfTargetAccessibilityForTest()
})

describe('self-targeted computer-use requests', () => {
  it('recognizes only this app as the self target', () => {
    harness()

    expect(isSelfTargetedComputerApp('com.omniconsole.ide')).toBe(true)
    expect(isSelfTargetedComputerApp('com.omniconsole.ide.local')).toBe(true)
    expect(isSelfTargetedComputerApp('OmniConsole')).toBe(true)
    expect(isSelfTargetedComputerApp('omniconsole')).toBe(true)
    expect(isSelfTargetedComputerApp('pid:4242')).toBe(true)
    expect(isSelfTargetedComputerApp('pid:4243')).toBe(false)
    expect(isSelfTargetedComputerApp('com.spotify.client')).toBe(false)
    expect(isSelfTargetedComputerApp('Spotify')).toBe(false)
    expect(isSelfTargetedComputerApp(undefined)).toBe(false)
  })

  it('refuses the sibling install that answers to the other side of our bundle id', () => {
    // The dev copy and the packaged app run side by side on purpose. Answering for each
    // other enables accessibility and raises the window in the WRONG process, and no
    // retry can repair that for the app the caller actually addressed.
    const packaged = harness()

    expect(isSelfTargetedComputerApp('com.omniconsole.ide.dev')).toBe(false)
    expect(isSelfTargetedComputerApp('com.omniconsole.ide.dev.wt')).toBe(false)
    packaged.unregister()

    harness({ appName: 'OmniConsole Dev' })

    expect(isSelfTargetedComputerApp('com.omniconsole.ide.dev')).toBe(true)
    expect(isSelfTargetedComputerApp('com.omniconsole.ide.dev.wt')).toBe(true)
    expect(isSelfTargetedComputerApp('com.omniconsole.ide')).toBe(false)
  })

  it('reports no self target without a registered app window', () => {
    expect(selfTargetAccessibilityActive()).toBe(false)
    expect(isSelfTargetedComputerApp('com.omniconsole.ide')).toBe(false)
  })

  it('enables Electron accessibility support once per self-targeting session', async () => {
    const test = harness()

    await expect(
      prepareSelfTargetedComputerRequest('OmniConsole', { requireFocus: false })
    ).resolves.toBe(true)
    await prepareSelfTargetedComputerRequest('com.omniconsole.ide', { requireFocus: false })

    expect(test.setEnabled.mock.calls).toEqual([[true]])
    expect(test.log).toHaveBeenCalledTimes(1)
  })

  it('never enables accessibility support for a foreign app', async () => {
    const test = harness({ focused: false })

    await expect(
      prepareSelfTargetedComputerRequest('Spotify', { requireFocus: true })
    ).resolves.toBe(false)

    expect(test.setEnabled).not.toHaveBeenCalled()
    expect(test.focus).not.toHaveBeenCalled()
  })

  it('leaves support alone when it is already enabled outside this app', async () => {
    const test = harness({ alreadyEnabled: true })

    await prepareSelfTargetedComputerRequest('OmniConsole', { requireFocus: false })
    test.timers.forEach((run) => run())

    expect(test.setEnabled).not.toHaveBeenCalled()
  })

  it('releases support it enabled once the self-targeting session goes idle', async () => {
    const test = harness()

    await prepareSelfTargetedComputerRequest('OmniConsole', { requireFocus: false })
    test.timers.at(-1)!()

    expect(test.setEnabled.mock.calls).toEqual([[true], [false]])
  })

  it('resolves focus through the app window instead of the OS focused window', async () => {
    const test = harness({ focused: false })

    const pending = prepareSelfTargetedComputerRequest('OmniConsole', { requireFocus: true })
    await Promise.resolve()
    expect(test.focus).toHaveBeenCalledTimes(1)
    test.focused.value = true
    test.focusListeners.forEach((listener) => listener())

    await expect(pending).resolves.toBe(true)
  })

  it('refuses a self-targeted action when the app window never takes focus', async () => {
    const test = harness({ focused: false })

    const pending = prepareSelfTargetedComputerRequest('OmniConsole', { requireFocus: true })
    await Promise.resolve()
    test.focusListeners.forEach((listener) => listener())

    await expect(pending).rejects.toMatchObject({ code: 'window_not_focused' })
  })

  it('refuses a self-targeted action when the focus wait times out', async () => {
    // The realistic never-focused path: no focus event ever arrives and the timeout timer
    // is the only thing that can end the wait. Without it the request hangs forever.
    const test = harness({ focused: false })

    const pending = prepareSelfTargetedComputerRequest('OmniConsole', { requireFocus: true })
    await Promise.resolve()
    expect(test.focus).toHaveBeenCalledTimes(1)
    const focusTimeout = test.timers.at(-1)!
    focusTimeout()

    await expect(pending).rejects.toMatchObject({ code: 'window_not_focused' })
    expect(test.focusListeners).toHaveLength(0)
  })

  it('stops the focus timeout once the window reports focus', async () => {
    const test = harness({ focused: false })

    const pending = prepareSelfTargetedComputerRequest('OmniConsole', { requireFocus: true })
    await Promise.resolve()
    const timerCount = test.timers.length
    test.focused.value = true
    test.focusListeners.forEach((listener) => listener())

    await expect(pending).resolves.toBe(true)
    expect(test.cleared).toContain(timerCount)
  })

  it('accepts a focus event delivered synchronously by the host', async () => {
    const focused = { value: false }
    const setEnabled = vi.fn()
    registerSelfTargetAccessibilityHost({
      appName: () => 'OmniConsole',
      pid: 4242,
      isAccessibilitySupportEnabled: () => false,
      setAccessibilitySupportEnabled: setEnabled,
      window: {
        isDestroyed: () => false,
        isFocused: () => focused.value,
        focus: () => {
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

    await expect(
      prepareSelfTargetedComputerRequest('OmniConsole', { requireFocus: true })
    ).resolves.toBe(true)
  })

  it('stops treating the app as a self target after the window unregisters', async () => {
    const test = harness()

    await prepareSelfTargetedComputerRequest('OmniConsole', { requireFocus: false })
    test.unregister()

    expect(selfTargetAccessibilityActive()).toBe(false)
    expect(test.setEnabled.mock.calls).toEqual([[true], [false]])
  })
})
