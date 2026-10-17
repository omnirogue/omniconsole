/**
 * The guard behind "the app starts frozen right after an update": a daemon-backed startup step
 * that hangs must not hold the rest of startup, and giving up the wait must not be mistaken for
 * the step having failed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { timeRendererStartupStepWithDeadline } from './startup-diagnostics'

const diagnostics: string[] = []

beforeEach(() => {
  diagnostics.length = 0
  vi.stubGlobal('window', {
    api: {
      app: {
        startupDiagnostic: async (event: string) => {
          diagnostics.push(event)
        }
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('a startup step that cannot freeze the app', () => {
  it('returns the step result when it answers inside the deadline', async () => {
    await expect(
      timeRendererStartupStepWithDeadline('probe', async () => 'answered', 50)
    ).resolves.toBe('answered')
    expect(diagnostics).toContain('renderer-probe-done')
    expect(diagnostics).not.toContain('renderer-probe-deadline')
  })

  it('carries on when the step hangs, and says so', async () => {
    let settle: (() => void) | undefined
    const hung = new Promise<void>((resolve) => {
      settle = resolve
    })

    await expect(
      timeRendererStartupStepWithDeadline('probe', () => hung, 10)
    ).resolves.toBeUndefined()
    expect(diagnostics).toContain('renderer-probe-deadline')
    // The work was never cancelled: it is still in flight, and settling it must not throw.
    settle?.()
    await expect(hung).resolves.toBeUndefined()
  })

  it('still reports a step that fails rather than swallowing it', async () => {
    await expect(
      timeRendererStartupStepWithDeadline(
        'probe',
        async () => {
          throw new Error('daemon refused')
        },
        50
      )
    ).rejects.toThrow('daemon refused')
    expect(diagnostics).toContain('renderer-probe-failed')
  })
})
