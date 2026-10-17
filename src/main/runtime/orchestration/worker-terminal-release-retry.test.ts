import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../omni-runtime'
import { reconcileRequestedWorkerTerminalReleases } from './worker-terminal-release-reconciliation'
import { retryRequestedWorkerTerminalReleases } from './worker-terminal-release-retry'

vi.mock('./worker-terminal-release-reconciliation', () => ({
  reconcileRequestedWorkerTerminalReleases: vi.fn().mockResolvedValue({ pending: 1 })
}))

function host() {
  const runtime = {
    getOrchestrationDb: () => ({})
  } as unknown as OrcaRuntimeService
  return { runtime }
}

describe('requested worker release retries on the host tick', () => {
  beforeEach(() => vi.clearAllMocks())

  it('retries persisted requests at a bounded cadence without another coordinator acknowledgment', () => {
    const { runtime } = host()
    retryRequestedWorkerTerminalReleases(runtime, 1_000)
    retryRequestedWorkerTerminalReleases(runtime, 3_000)
    expect(reconcileRequestedWorkerTerminalReleases).toHaveBeenCalledTimes(1)
    retryRequestedWorkerTerminalReleases(runtime, 11_000)
    expect(reconcileRequestedWorkerTerminalReleases).toHaveBeenCalledTimes(2)
    retryRequestedWorkerTerminalReleases(runtime, 21_000)
    expect(reconcileRequestedWorkerTerminalReleases).toHaveBeenCalledTimes(3)
  })

  it('reconciles restored requests immediately on a new runtime', () => {
    const first = host()
    const restarted = host()
    retryRequestedWorkerTerminalReleases(first.runtime, 1_000)
    retryRequestedWorkerTerminalReleases(restarted.runtime, 2_000)
    expect(reconcileRequestedWorkerTerminalReleases).toHaveBeenCalledTimes(2)
  })

  it('leaves hosts without orchestration state alone', () => {
    const runtime = {
      getOrchestrationDb: () => {
        throw new Error('Not installed')
      }
    } as unknown as OrcaRuntimeService
    expect(() => retryRequestedWorkerTerminalReleases(runtime, 1_000)).not.toThrow()
    expect(reconcileRequestedWorkerTerminalReleases).not.toHaveBeenCalled()
  })
})
