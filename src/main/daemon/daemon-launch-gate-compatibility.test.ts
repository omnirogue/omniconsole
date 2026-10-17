import { afterEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import {
  PTY_LAUNCH_GATE_PROTOCOL_VERSION,
  PTY_LAUNCH_GATE_OBSERVATION_PROTOCOL_VERSION
} from './daemon-protocol-version'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from './daemon-pty-adapter-test-harness'
import { SshPtyProvider } from '../providers/ssh-pty-provider'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'

const opts = {
  cols: 80,
  rows: 24,
  command: 'codex',
  launchGate: { version: 1, launchId: 'dispatch-test' } as const
}
const { readBirth } = vi.hoisted(() => ({ readBirth: vi.fn(async () => 1700000000000) }))
vi.mock('../runtime/agent-session-process-identity-probe', () => ({
  readProcessStartTimeMs: readBirth
}))
vi.mock('../providers/macos-pty-process-observer-path', () => ({
  resolveMacosPtyProcessObserver: () => '/test/observer'
}))

describe.skipIf(process.platform === 'win32')('launch gate wire compatibility', () => {
  let harness: DaemonAdapterHarness | undefined
  afterEach(async () => {
    vi.restoreAllMocks()
    harness?.adapter.dispose()
    await harness?.server.shutdown()
    if (harness) {
      rmSync(harness.dir, { recursive: true, force: true })
    }
    harness = undefined
  })

  it('refuses an old daemon before spawn while preserving ordinary launches', async () => {
    const spawn = vi.fn(() => createMockSubprocess())
    harness = await startDaemonAdapterHarness(spawn)
    const legacy = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      protocolVersion: PTY_LAUNCH_GATE_PROTOCOL_VERSION - 1
    })
    try {
      expect(legacy.supportsLaunchGate()).toBe(false)
      await expect(legacy.spawn(opts)).rejects.toThrow('gate_unavailable')
      expect(spawn).not.toHaveBeenCalled()
      await harness.adapter.spawn({ cols: 80, rows: 24, command: 'codex' })
      expect(spawn).toHaveBeenCalledTimes(1)
    } finally {
      legacy.dispose()
    }
  })

  it('uses a distinct prepare RPC and never retries an unknown method as ordinary create', async () => {
    const spawn = vi.fn(() => createMockSubprocess())
    harness = await startDaemonAdapterHarness(spawn)
    const request = vi.spyOn(DaemonClient.prototype, 'request')
    request.mockRejectedValueOnce(new Error('Unknown request type: prepareLaunch'))
    await expect(harness.adapter.spawn(opts)).rejects.toThrow('Unknown request type: prepareLaunch')
    expect(request.mock.calls.map(([method]) => method)).toEqual(['prepareLaunch'])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('refuses a host that supports input gates but cannot require process observation', async () => {
    const spawn = vi.fn(() => createMockSubprocess())
    harness = await startDaemonAdapterHarness(spawn)
    const oldGateHost = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      protocolVersion: PTY_LAUNCH_GATE_OBSERVATION_PROTOCOL_VERSION - 1
    })
    try {
      expect(oldGateHost.supportsLaunchGateObservation()).toBe(false)
      await expect(
        oldGateHost.spawn({
          ...opts,
          launchGate: {
            ...opts.launchGate,
            startupCommandMode: 'exec',
            processObservation: 'required'
          }
        })
      ).rejects.toThrow('exit_observer_unavailable')
      expect(spawn).not.toHaveBeenCalled()
    } finally {
      oldGateHost.dispose()
    }
  })

  it('never falls back from required process observation to the ordinary prepare RPC', async () => {
    const spawn = vi.fn(() => createMockSubprocess())
    harness = await startDaemonAdapterHarness(spawn)
    const request = vi.spyOn(DaemonClient.prototype, 'request')
    request.mockRejectedValueOnce(new Error('Unknown request type: prepareObservedLaunch'))
    await expect(
      harness.adapter.spawn({
        ...opts,
        launchGate: {
          ...opts.launchGate,
          startupCommandMode: 'exec',
          processObservation: 'required'
        }
      })
    ).rejects.toThrow('Unknown request type: prepareObservedLaunch')
    expect(request.mock.calls.map(([method]) => method)).toEqual(['prepareObservedLaunch'])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('retains the gate across disconnect and releases through a fresh adapter exactly once', async () => {
    const sub = createMockSubprocess()
    const rawWrite = sub.write
    const spawn = vi.fn(() => sub)
    harness = await startDaemonAdapterHarness(spawn)
    const first = await harness.adapter.spawn({ ...opts, sessionId: 'reconnected-gate' })
    await harness.adapter.disconnectOnly()
    const fresh = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    try {
      const replay = await fresh.spawn({ ...opts, sessionId: first.id })
      expect(replay.launchGate).toEqual(first.launchGate)
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(rawWrite).not.toHaveBeenCalled()
      const release = { gate: first.launchGate!, startAcknowledgement: 'persisted-start' }
      await fresh.releaseLaunchGate(release)
      await fresh.releaseLaunchGate(release)
      // The shell-ready fallback is independent; force it for this mock with no marker.
      sub._simulateData('\u001b]133;A\u0007')
    } finally {
      fresh.dispose()
    }
  })

  it('refuses SSH without any remote spawn or local process probe', async () => {
    const write = vi.fn()
    const mux = new SshChannelMultiplexer({ write, onData: vi.fn(), onClose: vi.fn() })
    const provider = new SshPtyProvider('gate-test-ssh', mux)
    try {
      await expect(provider.spawn(opts)).rejects.toThrow('gate_unavailable')
      expect(write).not.toHaveBeenCalled()
    } finally {
      provider.dispose()
      mux.dispose()
    }
  })
})
