import { describe, expect, it, vi } from 'vitest'
import type { IPtyProvider } from '../providers/types'
import type { PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import { readDaemonLaunchGateObservation } from './daemon-launch-gate-observation'

const gate: PtyLaunchGateReceipt = {
  version: 1,
  state: 'closed',
  launchId: 'test',
  gateId: 'gate-test',
  ptyId: 'pty-test',
  incarnationId: 'incarnation-test',
  pid: 42,
  processStartTimeMs: 1700000000000,
  processKind: 'pty-root',
  reportsChildExitStatus: true,
  startupCommandMode: 'exec'
}
const observed = {
  gateId: gate.gateId,
  ptyId: gate.ptyId,
  incarnationId: gate.incarnationId,
  pid: gate.pid,
  processStartTimeMs: gate.processStartTimeMs,
  state: 'exited',
  startAcknowledgement: 'start',
  source: 'macos-kqueue',
  exitCode: 37,
  signal: null,
  waitStatus: 9472,
  observedAtMs: 1700000001000
} as const

function adapter(read: () => Promise<unknown>): IPtyProvider {
  return {
    supportsLaunchGateObservation: () => true,
    readLaunchGateObservation: vi.fn(read)
  } as unknown as IPtyProvider
}

describe('retained daemon launch observation routing', () => {
  it('reads the exact legacy host receipt after ordinary live routing forgot the terminal', async () => {
    const current = adapter(async () => {
      throw new Error('gate unavailable')
    })
    const legacy = adapter(async () => observed)
    expect(await readDaemonLaunchGateObservation([current, legacy], gate)).toEqual(observed)
    expect(legacy.readLaunchGateObservation).toHaveBeenCalledWith(gate)
  })

  it('never substitutes a different process or an unreachable host for physical proof', async () => {
    const current = adapter(async () => ({ ...observed, pid: gate.pid + 1 }))
    const legacy = adapter(async () => {
      throw new Error('connection lost')
    })
    await expect(readDaemonLaunchGateObservation([current, legacy], gate)).rejects.toThrow(
      'observation_unverifiable'
    )
  })
})
