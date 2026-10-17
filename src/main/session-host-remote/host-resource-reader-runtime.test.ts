import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionHostStatsResult } from '../../shared/session-host-stats'

const mocks = vi.hoisted(() => ({
  collectHostMemory: vi.fn(),
  current: vi.fn(),
  countLiveSessions: vi.fn(),
  clientFor: vi.fn(),
  sshState: vi.fn()
}))

vi.mock('../memory/host-memory', () => ({ collectHostMemory: mocks.collectHostMemory }))
vi.mock('../session-host/session-host-runtime', () => ({
  activeRuntimeSessionHost: () => ({ current: mocks.current })
}))
vi.mock('../session-host/session-host-stats', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  countLiveSessions: mocks.countLiveSessions
}))
vi.mock('./remote-session-hosts-runtime', () => ({
  getRemoteSessionHosts: () => ({ clientFor: mocks.clientFor })
}))
vi.mock('../ssh/ssh-target-registry', () => ({ getRegisteredSshState: mocks.sshState }))

const LOCAL_ID = 'host_0000000000000000000000000000000a'
const REMOTE_ID = 'host_0000000000000000000000000000000b'
const MEMORY = { totalMemory: 64, availableMemory: 20, cpuCoreCount: 10, loadAverage1m: 3 }

function stats(hostId: string): SessionHostStatsResult {
  return {
    status: 'ok',
    host: { hostId, incarnation: 'relay-1' },
    observedAt: 1,
    memory: MEMORY,
    liveSessions: 2
  }
}

// Why a fresh module per test: the reader and the kept ids are per-process singletons.
async function load() {
  vi.resetModules()
  return await import('./host-resource-reader-runtime')
}

describe('host resource reader runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.collectHostMemory.mockResolvedValue({ ...MEMORY, freeMemory: 10, usedMemory: 44 })
    mocks.current.mockReturnValue({ identity: { hostId: LOCAL_ID, incarnation: 'runtime-1' } })
    mocks.countLiveSessions.mockResolvedValue(3)
  })

  it('reads this computer with the readLocal recipe and names it by its registry id', async () => {
    const runtime = await load()
    const [local] = await runtime.getHostResourceReader().read(['local'])
    expect(local).toMatchObject({ hostKey: 'local', state: 'ok', memory: MEMORY, liveSessions: 3 })
    expect(runtime.hostResourceMachineId('local')).toBe(LOCAL_ID)
  })

  it('names nothing for this computer before its registry is open', async () => {
    mocks.current.mockReturnValue(null)
    const runtime = await load()
    const [local] = await runtime.getHostResourceReader().read(['local'])
    expect(local).toMatchObject({ state: 'ok', liveSessions: null })
    expect(runtime.hostResourceMachineId('local')).toBeNull()
  })

  it('keeps an SSH host id from its hostStats answer without adding it to the reading', async () => {
    mocks.clientFor.mockResolvedValue({ hostStats: async () => stats(REMOTE_ID) })
    const runtime = await load()
    const [remote] = await runtime.getHostResourceReader().read(['ssh:mw0002'])
    expect(remote).toMatchObject({ state: 'ok', memory: MEMORY, liveSessions: 2 })
    expect(remote).not.toHaveProperty('hostId')
    expect(runtime.hostResourceMachineId('ssh:mw0002')).toBe(REMOTE_ID)
    expect(runtime.hostResourceMachineId('ssh:other')).toBeNull()
  })

  it('keeps no id for a host that refuses, cannot be reached or fails', async () => {
    const refused: SessionHostStatsResult = {
      status: 'refused',
      refusal: { code: 'unsupported-capability', message: 'Too old for host stats.' }
    }
    mocks.clientFor.mockImplementation(async (hostKey: string) => {
      if (hostKey === 'ssh:old') {
        return { hostStats: async () => refused }
      }
      if (hostKey === 'ssh:down') {
        return { hostStats: () => Promise.reject(new Error('That SSH host is not connected.')) }
      }
      return null
    })
    const runtime = await load()
    const readings = await runtime
      .getHostResourceReader()
      .read(['ssh:old', 'ssh:down', 'ssh:unknown'])
    expect(readings.map((reading) => [reading.state, reading.detail])).toEqual([
      ['unavailable', 'Too old for host stats.'],
      ['unavailable', 'That SSH host is not connected.'],
      ['unavailable', 'This computer cannot reach that host right now.']
    ])
    for (const hostKey of ['ssh:old', 'ssh:down', 'ssh:unknown']) {
      expect(runtime.hostResourceMachineId(hostKey)).toBeNull()
    }
  })

  it("names this computer's OS and an SSH host's relay-detected OS, else none", async () => {
    mocks.sshState.mockImplementation((targetId: string) =>
      targetId === 'win-box' ? { remotePlatform: 'win32' } : targetId === 'new' ? {} : undefined
    )
    const runtime = await load()
    expect(runtime.hostResourcePlatform('local')).toBe(process.platform)
    expect(runtime.hostResourcePlatform('ssh:win-box')).toBe('win32')
    expect(runtime.hostResourcePlatform('ssh:new')).toBeNull()
    expect(runtime.hostResourcePlatform('ssh:gone')).toBeNull()
    expect(runtime.hostResourcePlatform('runtime:env-1')).toBeNull()
    expect(mocks.sshState).toHaveBeenCalledWith('win-box')
  })

  it('forgets a kept id once the host stops answering', async () => {
    vi.useFakeTimers()
    try {
      let answer: () => Promise<SessionHostStatsResult> = async () => stats(REMOTE_ID)
      mocks.clientFor.mockResolvedValue({ hostStats: () => answer() })
      const runtime = await load()
      await runtime.getHostResourceReader().read(['ssh:mw0002'])
      expect(runtime.hostResourceMachineId('ssh:mw0002')).toBe(REMOTE_ID)
      answer = () => Promise.reject(new Error('That SSH host is not connected.'))
      // Past the reader's reuse window, so the next read asks the host again.
      vi.setSystemTime(Date.now() + 30_000)
      await runtime.getHostResourceReader().read(['ssh:mw0002'])
      expect(runtime.hostResourceMachineId('ssh:mw0002')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
