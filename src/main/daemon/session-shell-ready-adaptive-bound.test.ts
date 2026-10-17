import { describe, expect, it } from 'vitest'
import {
  CODEX_SHELL_READY_ADAPTIVE_CAP_MS,
  CODEX_SHELL_READY_TIMEOUT_MS,
  decideAdaptiveShellReadyWait,
  resolveShellReadyAdaptiveCapMs
} from './session-shell-ready-adaptive-bound'

const codex = {
  baseTimeoutMs: CODEX_SHELL_READY_TIMEOUT_MS,
  capMs: CODEX_SHELL_READY_ADAPTIVE_CAP_MS
}

describe('decideAdaptiveShellReadyWait', () => {
  it('extends past the floor while the probe has not identified the shell', () => {
    const decision = decideAdaptiveShellReadyWait({
      ...codex,
      elapsedMs: CODEX_SHELL_READY_TIMEOUT_MS,
      probeIdentifiedShell: false,
      shellOutputObserved: false
    })

    expect(decision).toEqual({
      action: 'extend',
      waitMs: CODEX_SHELL_READY_TIMEOUT_MS,
      elapsedMs: CODEX_SHELL_READY_TIMEOUT_MS
    })
  })

  // Why: the floor is the guarantee that nothing waits LESS than today. Every
  // extension step is floor-sized, so the total wait can only grow.
  it('never returns a wait shorter than the floor until the cap is near', () => {
    for (let elapsedMs = 300; elapsedMs <= 2_600; elapsedMs += 100) {
      const decision = decideAdaptiveShellReadyWait({
        ...codex,
        elapsedMs,
        probeIdentifiedShell: false,
        shellOutputObserved: false
      })
      expect(decision.action).toBe('extend')
      if (decision.action === 'extend') {
        expect(decision.waitMs).toBe(CODEX_SHELL_READY_TIMEOUT_MS)
        expect(elapsedMs + decision.waitMs).toBeGreaterThan(CODEX_SHELL_READY_TIMEOUT_MS)
      }
    }
  })

  it('clamps the final extension so the total wait never passes the cap', () => {
    const decision = decideAdaptiveShellReadyWait({
      ...codex,
      elapsedMs: 2_900,
      probeIdentifiedShell: false,
      shellOutputObserved: false
    })

    expect(decision).toEqual({ action: 'extend', waitMs: 100, elapsedMs: 2_900 })
  })

  it('expires at the cap', () => {
    expect(
      decideAdaptiveShellReadyWait({
        ...codex,
        elapsedMs: CODEX_SHELL_READY_ADAPTIVE_CAP_MS,
        probeIdentifiedShell: false,
        shellOutputObserved: false
      })
    ).toEqual({ action: 'expire', elapsedMs: CODEX_SHELL_READY_ADAPTIVE_CAP_MS })
  })

  // Why: once the shell has announced its PID it is far enough along that the
  // configured bound stands -- the extension exists for a shell still booting.
  it('expires as before once the probe identified the shell', () => {
    expect(
      decideAdaptiveShellReadyWait({
        ...codex,
        elapsedMs: CODEX_SHELL_READY_TIMEOUT_MS,
        probeIdentifiedShell: true,
        shellOutputObserved: false
      })
    ).toEqual({ action: 'expire', elapsedMs: CODEX_SHELL_READY_TIMEOUT_MS })
  })

  // Why: the plain-Codex path enables neither the ready nor the identity wrapper
  // feature, so its only evidence that the shell finished sourcing its profile is
  // that the shell started printing. Without this the fast case would pay the cap.
  it('expires once the shell has produced output', () => {
    expect(
      decideAdaptiveShellReadyWait({
        ...codex,
        elapsedMs: CODEX_SHELL_READY_TIMEOUT_MS,
        probeIdentifiedShell: false,
        shellOutputObserved: true
      })
    ).toEqual({ action: 'expire', elapsedMs: CODEX_SHELL_READY_TIMEOUT_MS })
  })

  it('leaves a launch with no cap on todays fixed behaviour', () => {
    expect(
      decideAdaptiveShellReadyWait({
        baseTimeoutMs: 15_000,
        elapsedMs: 15_000,
        probeIdentifiedShell: false,
        shellOutputObserved: false
      })
    ).toEqual({ action: 'expire', elapsedMs: 15_000 })
  })

  it('ignores a cap that would not actually extend the floor', () => {
    expect(
      decideAdaptiveShellReadyWait({
        baseTimeoutMs: 3_000,
        capMs: 3_000,
        elapsedMs: 3_000,
        probeIdentifiedShell: false,
        shellOutputObserved: false
      })
    ).toEqual({ action: 'expire', elapsedMs: 3_000 })
  })
})

describe('resolveShellReadyAdaptiveCapMs', () => {
  it('opts the Codex floor into the cap', () => {
    expect(resolveShellReadyAdaptiveCapMs(CODEX_SHELL_READY_TIMEOUT_MS)).toBe(
      CODEX_SHELL_READY_ADAPTIVE_CAP_MS
    )
  })

  it('leaves every other bound alone', () => {
    expect(resolveShellReadyAdaptiveCapMs(undefined)).toBeUndefined()
    expect(resolveShellReadyAdaptiveCapMs(15_000)).toBeUndefined()
    expect(resolveShellReadyAdaptiveCapMs(100)).toBeUndefined()
  })
})
