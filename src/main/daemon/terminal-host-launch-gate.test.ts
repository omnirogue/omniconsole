import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalHost } from './terminal-host'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { createPtySubprocess } from './pty-subprocess'
import { STARTUP_DA1_RESPONSE } from './startup-device-attributes-responder'

const { readBirth } = vi.hoisted(() => ({
  readBirth: vi.fn(async (): Promise<number | null> => 1700000000000)
}))
vi.mock('../runtime/agent-session-process-identity-probe', () => ({
  readProcessStartTimeMs: readBirth
}))

describe.skipIf(process.platform === 'win32')('TerminalHost launch gate', () => {
  let host: TerminalHost | undefined
  afterEach(async () => {
    vi.useRealTimers()
    readBirth.mockResolvedValue(1700000000000)
    await host?.dispose()
  })

  it('survives shell readiness fallback, queued input, and reattach without releasing', async () => {
    vi.useFakeTimers()
    const sub = createMockSubprocess()
    const rawWrite = sub.write
    const spawn = vi.fn(() => sub)
    host = new TerminalHost({ spawnSubprocess: spawn })
    const opts = {
      sessionId: 'held-terminal',
      cols: 80,
      rows: 24,
      command: 'codex',
      launchGate: { version: 1, launchId: 'dispatch-test' } as const,
      shellReadySupported: true,
      shellReadyTimeoutMs: 20,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    }
    const first = await host.createOrAttach(opts)
    host.write(opts.sessionId, 'queued input\n')
    await vi.advanceTimersByTimeAsync(20_000)
    const replay = await host.createOrAttach(opts)
    expect(replay.launchGate).toEqual(first.launchGate)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(rawWrite).not.toHaveBeenCalled()
    const release = { gate: first.launchGate!, startAcknowledgement: 'persisted-start' }
    await host.releaseLaunchGate(release)
    await host.releaseLaunchGate(release)
    expect(rawWrite.mock.calls.flat().join('')).toContain('codex')
    expect(rawWrite.mock.calls.flat().join('')).toContain('queued input')
    sub._simulateExit(0)
  })

  it('answers a shell DA1 query through the raw subprocess while the launch gate is closed', async () => {
    const sub = createMockSubprocess()
    const rawWrite = sub.write
    host = new TerminalHost({ spawnSubprocess: () => sub })
    await host.createOrAttach({
      sessionId: 'fish-da1',
      cols: 80,
      rows: 24,
      command: 'codex',
      shellReadySupported: true,
      launchGate: { version: 1, launchId: 'dispatch-test' },
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    sub._simulateData('\x1b[c')
    expect(rawWrite).toHaveBeenCalledWith(STARTUP_DA1_RESPONSE)
    host.write('fish-da1', 'user input\n')
    expect(rawWrite).not.toHaveBeenCalledWith('user input\n')
  })

  it('kills the exact new process when gate preparation cannot verify its birth', async () => {
    const sub = createMockSubprocess()
    const rawWrite = sub.write
    host = new TerminalHost({ spawnSubprocess: () => sub })
    readBirth.mockResolvedValue(null)
    await expect(
      host.createOrAttach({
        sessionId: 'unknown-birth',
        cols: 80,
        rows: 24,
        command: 'codex',
        launchGate: { version: 1, launchId: 'dispatch-test' },
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).rejects.toThrow('birth_unverifiable')
    expect(sub.forceKill).toHaveBeenCalledTimes(1)
    expect(rawWrite).not.toHaveBeenCalled()
    expect(host.listSessions()).toHaveLength(0)
  })

  it('leaves an adopted gate owner alive when an attach request is rejected', async () => {
    const sub = createMockSubprocess()
    host = new TerminalHost({ spawnSubprocess: () => sub })
    const opts = {
      sessionId: 'adopted-gate',
      cols: 80,
      rows: 24,
      command: 'codex',
      launchGate: { version: 1, launchId: 'original' } as const,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    }
    await host.createOrAttach(opts)
    await expect(
      host.createOrAttach({ ...opts, launchGate: { version: 1, launchId: 'different' } })
    ).rejects.toThrow()
    expect(sub.forceKill).not.toHaveBeenCalled()
    expect(host.listSessions()).toHaveLength(1)
  })

  it('reaps a real newly spawned shell after gate preparation fails', async () => {
    let spawnedPid = 0
    host = new TerminalHost({
      spawnSubprocess: async (opts) => {
        const sub = await createPtySubprocess(opts)
        spawnedPid = sub.pid
        return sub
      }
    })
    readBirth.mockResolvedValue(null)
    await expect(
      host.createOrAttach({
        sessionId: 'real-gate-rejection',
        cols: 80,
        rows: 24,
        command: 'codex',
        launchGate: { version: 1, launchId: 'dispatch-test' },
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).rejects.toThrow('birth_unverifiable')
    expect(spawnedPid).toBeGreaterThan(0)
    expect(host.listSessions()).toHaveLength(0)
    expect(() => process.kill(spawnedPid, 0)).toThrow()
  })

  it('does not attest an ordinary existing terminal as held', async () => {
    const sub = createMockSubprocess()
    host = new TerminalHost({ spawnSubprocess: () => sub })
    const opts = {
      sessionId: 'ordinary',
      cols: 80,
      rows: 24,
      command: 'codex',
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    }
    await host.createOrAttach(opts)
    await expect(
      host.createOrAttach({ ...opts, launchGate: { version: 1, launchId: 'dispatch-test' } })
    ).rejects.toThrow('gate_unavailable')
  })

  it('refuses Windows argv auto-start before creating a subprocess', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
    const spawn = vi.fn(() => createMockSubprocess())
    host = new TerminalHost({ spawnSubprocess: spawn })
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      await expect(
        host.createOrAttach({
          sessionId: 'unsupported-windows',
          cols: 80,
          rows: 24,
          command: 'codex',
          launchGate: { version: 1, launchId: 'dispatch-test' },
          streamClient: { onData: vi.fn(), onExit: vi.fn() }
        })
      ).rejects.toThrow('gate_unavailable')
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', descriptor)
    }
  })
})
