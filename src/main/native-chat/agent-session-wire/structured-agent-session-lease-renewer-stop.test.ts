import { describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { StructuredAgentSessionLeaseRenewer } from './structured-agent-session-lease-renewer'

const NOW = 1_800_000_000_000

describe('stopping structured agent-session lease renewal', () => {
  it('resolves only after a renewal already writing the store has finished', async () => {
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: 'session-stop',
        runtimeKind: 'native',
        runtimeFence: 1,
        ownerProcess: {
          hostId: 'local',
          pid: 4200,
          processStartTimeMs: NOW - 1_000,
          spawnToken: 'spawn-stop'
        },
        reservedSpawnToken: 'spawn-stop',
        lastRenewedAt: NOW,
        leaseDeadlineAt: NOW + 30_000
      })
    )
    let write!: (records: AgentSessionRecord[]) => void
    let reached!: () => void
    const writing = new Promise<void>((resolve) => {
      reached = resolve
    })
    const renewLeases = vi.fn(
      () =>
        new Promise<AgentSessionRecord[]>((resolve) => {
          write = resolve
          reached()
        })
    )
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store: { listRecords: () => [record], renewLeases } as unknown as AgentSessionRecordStore,
      probe: async () => ({ outcome: 'identity-matched', matchedOn: ['spawn-token'] }),
      now: () => NOW + 10_000
    })

    const renewal = renewer.renewNow()
    await writing
    let stopped = false
    const stop = Promise.resolve(renewer.stop()).then(() => {
      stopped = true
    })
    // Give a stop that does not wait every chance to resolve before the write lands.
    for (let turn = 0; turn < 10; turn++) {
      await Promise.resolve()
    }
    expect(stopped).toBe(false)

    write([record])
    await stop
    await renewal
    expect(stopped).toBe(true)
  })

  it('resolves at once when no renewal is running', async () => {
    const renewer = new StructuredAgentSessionLeaseRenewer({
      store: { listRecords: () => [], renewLeases: vi.fn() } as unknown as AgentSessionRecordStore,
      probe: vi.fn(),
      now: () => NOW
    })
    renewer.start()
    await expect(renewer.stop()).resolves.toBeUndefined()
  })
})
