import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readClientSessionHostDeclaration,
  SESSION_CONTROL_OWNER_CAPABILITY,
  SESSION_HOST_STATS_CAPABILITY
} from '../../shared/session-host-capabilities'
import { SESSION_HOST_RPC } from '../../shared/session-host-protocol'
import { SessionHostStatsReplySchema } from '../../shared/session-host-stats'
import { phase4ClientCapabilities } from '../../shared/session-host-wire-fixtures'
import { handleSessionHostRemoteCall, type SessionHostRemotePeer } from './session-host-remote-gate'
import { countLiveSessions, readSessionHostStats } from './session-host-stats'
import {
  adoptTestConversation,
  FakeSessionHostExecutor,
  testHostProcess,
  testHostRoot,
  type TestHostRoot
} from './session-host-test-fixture'

let host: TestHostRoot
beforeEach(() => {
  host = testHostRoot()
})
afterEach(() => {
  host.dispose()
})

const peer = (declared: readonly string[]): SessionHostRemotePeer => ({
  transport: 'paired-runtime',
  peer: 'paired:mac-a',
  declared: readClientSessionHostDeclaration([...declared]),
  connection: null
})

const MEMORY = {
  totalMemory: 32 * 1024 ** 3,
  freeMemory: 4 * 1024 ** 3,
  availableMemory: 12 * 1024 ** 3,
  availableMemorySource: 'memory-pressure' as const,
  usedMemory: 20 * 1024 ** 3,
  memoryUsagePercent: 62.5,
  cpuCoreCount: 10,
  loadAverage1m: 3.2
}

describe('sessionHost.hostStats', () => {
  it('answers memory, cores, load and live sessions in a shape the client reads', async () => {
    const executor = new FakeSessionHostExecutor()
    const process = testHostProcess({ root: host.root, incarnation: 'runtime-1', executor })
    const service = await process.service()
    await adoptTestConversation(service)
    const stats = await readSessionHostStats(service, { collect: async () => MEMORY, now: () => 7 })
    expect(stats).toMatchObject({
      status: 'ok',
      observedAt: 7,
      memory: { totalMemory: MEMORY.totalMemory, availableMemory: MEMORY.availableMemory },
      liveSessions: 1
    })
    expect(Object.keys(stats.memory).sort()).toEqual(
      ['availableMemory', 'cpuCoreCount', 'loadAverage1m', 'totalMemory'].sort()
    )
    expect(SessionHostStatsReplySchema.safeParse(stats).success).toBe(true)
  })

  it('is served through the gate to a client that negotiated it, and refused to one that did not', async () => {
    const executor = new FakeSessionHostExecutor()
    const process = testHostProcess({ root: host.root, incarnation: 'runtime-1', executor })
    const served = await handleSessionHostRemoteCall(
      process,
      SESSION_HOST_RPC.hostStats,
      {},
      peer(phase4ClientCapabilities())
    )
    expect(SessionHostStatsReplySchema.parse(served)).toMatchObject({
      status: 'ok',
      liveSessions: 0
    })
    const older = await handleSessionHostRemoteCall(
      process,
      SESSION_HOST_RPC.hostStats,
      {},
      peer(phase4ClientCapabilities([SESSION_CONTROL_OWNER_CAPABILITY]))
    )
    expect(older).toMatchObject({
      status: 'refused',
      refusal: { code: 'unsupported-capability', capability: SESSION_HOST_STATS_CAPABILITY }
    })
    const malformed = await handleSessionHostRemoteCall(
      process,
      SESSION_HOST_RPC.hostStats,
      { extra: true },
      peer(phase4ClientCapabilities())
    )
    expect(malformed).toMatchObject({ status: 'refused', refusal: { code: 'invalid-request' } })
  })

  it('reports an unobservable registry as unknown, never as zero sessions', async () => {
    const failing = async (): Promise<never> => {
      throw new Error('x')
    }
    expect(await countLiveSessions({ observe: failing })).toBe(null)
    expect(
      await countLiveSessions({
        observe: async () => ({
          status: 'refused',
          refusal: { code: 'storage-unavailable', message: 'no' }
        })
      })
    ).toBe(null)
  })

  it('shares one observe across concurrent and recent reads', async () => {
    let calls = 0
    const service = {
      observe: async () => {
        calls += 1
        return { status: 'ok', sessions: [{ verdict: 'live' }] } as never
      }
    }
    let clock = 0
    const [a, b] = await Promise.all([
      countLiveSessions(service, () => clock),
      countLiveSessions(service, () => clock)
    ])
    expect([a, b, calls]).toEqual([1, 1, 1])
    clock = 60_000
    await countLiveSessions(service, () => clock)
    expect(calls).toBe(2)
  })
})
