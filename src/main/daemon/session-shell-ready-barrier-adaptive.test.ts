import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import {
  CODEX_SHELL_READY_ADAPTIVE_CAP_MS,
  CODEX_SHELL_READY_TIMEOUT_MS
} from './session-shell-ready-adaptive-bound'
import type { DaemonLaunchStageReport } from './session-launch-stage-report'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { HeadlessEmulator } from './headless-emulator'
import { SHELL_STARTUP_IDENTITY_PREFIX } from '../shell-startup-identity-scanner'

const SHELL_READY_MARKER = ']777;omni-shell-ready'

type Harness = {
  barrier: SessionShellReadyBarrier
  written: string[]
  readinessEvents: { event: string; details: Record<string, unknown> }[]
  launchStages: { sessionId: string; report: DaemonLaunchStageReport }[]
}

function createBarrier(opts: { adaptive: boolean }): Harness {
  const written: string[] = []
  const readinessEvents: { event: string; details: Record<string, unknown> }[] = []
  const launchStages: { sessionId: string; report: DaemonLaunchStageReport }[] = []
  const subprocess = {
    pid: 4242,
    shellPath: '/bin/zsh',
    write: (data: string) => written.push(data)
  } as unknown as SubprocessHandle
  // The DA1 responder only needs a parser that accepts a CSI handler.
  const responderParser = {
    registerCsiHandler: () => ({ dispose: () => {} })
  } as unknown as HeadlessEmulator['responderParser']
  const barrier = new SessionShellReadyBarrier({
    sessionId: 'codex-session',
    subprocess,
    responderParser,
    shellReadySupported: true,
    shellReadyTimeoutMs: CODEX_SHELL_READY_TIMEOUT_MS,
    ...(opts.adaptive ? { shellReadyAdaptiveCapMs: CODEX_SHELL_READY_ADAPTIVE_CAP_MS } : {}),
    installDeviceAttributesFilter: () => {},
    releaseDeviceAttributesFilter: () => {},
    acceptStartupIngress: () => {},
    reportReadinessEvent: (event, details) => readinessEvents.push({ event, details }),
    reportLaunchStage: (sessionId, report) => launchStages.push({ sessionId, report })
  })
  return { barrier, written, readinessEvents, launchStages }
}

describe('SessionShellReadyBarrier adaptive Codex bound', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Why: 10 of the 11 measured shell-ready timeouts fired at 300ms, and a Mac
  // under load routinely needs longer just to source the shell profile.
  it('holds the queued startup command past 300ms while the shell is unidentified', () => {
    const { barrier, written, readinessEvents } = createBarrier({ adaptive: true })
    barrier.tryEnqueue('codex\n')

    vi.advanceTimersByTime(CODEX_SHELL_READY_TIMEOUT_MS)

    expect(written).toEqual([])
    expect(barrier.state).toBe('pending')
    expect(readinessEvents.map((entry) => entry.event)).toEqual(['shell-ready-timeout-extended'])
    expect(readinessEvents[0]?.details).toMatchObject({
      timeoutMs: CODEX_SHELL_READY_TIMEOUT_MS,
      capMs: CODEX_SHELL_READY_ADAPTIVE_CAP_MS,
      elapsedMs: CODEX_SHELL_READY_TIMEOUT_MS
    })
  })

  it('releases at the ready marker inside the extended window', () => {
    const { barrier, written } = createBarrier({ adaptive: true })
    barrier.tryEnqueue('codex\n')

    vi.advanceTimersByTime(900)
    barrier.ingestSubprocessData(`${SHELL_READY_MARKER}prompt% `)
    // The post-ready flush gate settles the line editor before writing.
    vi.advanceTimersByTime(500)

    expect(barrier.state).toBe('ready')
    expect(written).toEqual(['codex\n'])
  })

  // Today's flush behaviour is the contract at the cap: release DA1, release the
  // held bytes, flush the queue -- only later than 300ms.
  it('expires at the 3s cap and keeps the flush', () => {
    const { barrier, written, readinessEvents, launchStages } = createBarrier({ adaptive: true })
    barrier.tryEnqueue('codex\n')

    vi.advanceTimersByTime(CODEX_SHELL_READY_ADAPTIVE_CAP_MS)

    expect(barrier.state).toBe('timed_out')
    expect(written).toEqual(['codex\n'])
    const expiry = readinessEvents.at(-1)
    expect(expiry?.event).toBe('shell-ready-timeout')
    expect(expiry?.details).toMatchObject({
      timeoutMs: CODEX_SHELL_READY_TIMEOUT_MS,
      capMs: CODEX_SHELL_READY_ADAPTIVE_CAP_MS,
      outcome: 'expired',
      elapsedMs: CODEX_SHELL_READY_ADAPTIVE_CAP_MS
    })
    expect(launchStages.map((entry) => entry.report.stage)).toEqual([
      'shell_ready',
      'startup_command'
    ])
    expect(launchStages[0]?.report.outcome).toBe('timeout_expired')
    expect(launchStages[1]?.report).toMatchObject({
      outcome: 'flushed_after_timeout',
      queuedWrites: 1
    })
  })

  // Why: the plain-Codex launch enables neither the ready nor the identity wrapper
  // feature, so "the shell started printing" is its only liveness evidence — and
  // without this the common fast launch would pay the whole cap.
  it('expires at the floor once the shell has printed anything', () => {
    const { barrier, written } = createBarrier({ adaptive: true })
    barrier.tryEnqueue('codex\n')
    barrier.ingestSubprocessData('user@host ~ % ')

    vi.advanceTimersByTime(CODEX_SHELL_READY_TIMEOUT_MS)

    expect(barrier.state).toBe('timed_out')
    expect(written).toEqual(['codex\n'])
  })

  // Why: once the shell has announced its PID it is far enough along that the
  // configured bound stands; the extension exists for a shell still booting.
  it('expires at the floor once the shell identity marker arrived', () => {
    const { barrier, written } = createBarrier({ adaptive: true })
    barrier.tryEnqueue('codex\n')
    barrier.ingestSubprocessData(`${SHELL_STARTUP_IDENTITY_PREFIX}991`)

    vi.advanceTimersByTime(CODEX_SHELL_READY_TIMEOUT_MS)

    expect(barrier.state).toBe('timed_out')
    expect(written).toEqual(['codex\n'])
  })

  // The non-Codex path passes no cap, so nothing about its timing may change.
  it('leaves a launch without a cap on the fixed bound', () => {
    const { barrier, written, readinessEvents } = createBarrier({ adaptive: false })
    barrier.tryEnqueue('codex\n')

    vi.advanceTimersByTime(CODEX_SHELL_READY_TIMEOUT_MS)

    expect(barrier.state).toBe('timed_out')
    expect(written).toEqual(['codex\n'])
    expect(readinessEvents.map((entry) => entry.event)).toEqual(['shell-ready-timeout'])
    // No cap ⇒ no adaptive annotations on the historical event shape.
    expect(readinessEvents[0]?.details.outcome).toBeUndefined()
    expect(readinessEvents[0]?.details.capMs).toBeUndefined()
  })
})
