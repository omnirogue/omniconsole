import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostResourceReading } from '../../shared/host-resource-model'
import {
  getHostResourceReader,
  hostResourceMachineId,
  hostResourcePlatform
} from '../session-host-remote/host-resource-reader-runtime'
import {
  AGENT_LAUNCH_LOAD_MAX_AGE_MS,
  readAgentLaunchLoad,
  readRuntimeAgentLaunchLoad,
  type AgentLaunchLoadSource
} from './agent-launch-load'

vi.mock('../session-host-remote/host-resource-reader-runtime', () => ({
  getHostResourceReader: vi.fn(),
  hostResourceMachineId: vi.fn(),
  hostResourcePlatform: vi.fn()
}))

const NOW = 1_000_000
const LOCAL_ID = 'host_00000000000000000000000000000001'
const SSH_ID = 'host_00000000000000000000000000000002'

function reading(overrides: Partial<HostResourceReading> = {}): HostResourceReading {
  return {
    hostKey: 'local',
    state: 'ok',
    readAt: NOW - 5_000,
    memory: { totalMemory: 64, availableMemory: 20, cpuCoreCount: 10, loadAverage1m: 3 },
    liveSessions: 4,
    ...overrides
  }
}

/** `platforms` overrides the OS per host key; otherwise this computer is a Mac, SSH hosts Linux. */
function source(
  read: AgentLaunchLoadSource['read'],
  waitMs?: number,
  platforms: Record<string, string | null> = {}
): AgentLaunchLoadSource {
  return {
    read,
    machineId: (hostKey) => (hostKey === 'local' ? LOCAL_ID : SSH_ID),
    now: () => NOW,
    hostPlatform: (hostKey) =>
      hostKey in platforms
        ? (platforms[hostKey] ?? null)
        : hostKey === 'local'
          ? 'darwin'
          : 'linux',
    ...(waitMs === undefined ? {} : { waitMs })
  }
}

const ZERO_LOAD = { totalMemory: 64, availableMemory: 20, cpuCoreCount: 8, loadAverage1m: 0 }

describe('readAgentLaunchLoad', () => {
  afterEach(() => vi.useRealTimers())

  it('bands a timed reading by load per core and keeps its time and live sessions', async () => {
    await expect(
      readAgentLaunchLoad(
        source(async () => reading()),
        'local'
      )
    ).resolves.toEqual({
      load: {
        loadPerCore: 0.3,
        band: 'ok',
        liveSessions: 4,
        observedAt: NOW - 5_000,
        freeBytes: 20,
        totalBytes: 64
      },
      machineId: LOCAL_ID
    })
    const hot = reading({
      hostKey: 'ssh:mw0003',
      memory: { totalMemory: 64, availableMemory: 2, cpuCoreCount: 8, loadAverage1m: 7.3 }
    })
    await expect(
      readAgentLaunchLoad(
        source(async () => hot),
        'ssh:mw0003'
      )
    ).resolves.toMatchObject({ load: { band: 'hot' }, machineId: SSH_ID })
  })

  it('keeps uncounted live sessions null, never zero', async () => {
    const report = await readAgentLaunchLoad(
      source(async () => reading({ liveSessions: null })),
      'local'
    )
    expect(report.load?.liveSessions).toBeNull()
  })

  it('reads an unavailable, unread or failed host as unknown, never idle', async () => {
    for (const read of [
      async () => reading({ state: 'unavailable', memory: null, detail: 'not connected' }),
      async () => reading({ state: 'checking', readAt: null, memory: null }),
      async () => undefined,
      async () => {
        throw new Error('reader failed')
      }
    ]) {
      await expect(readAgentLaunchLoad(source(read), 'ssh:down')).resolves.toEqual({
        load: null,
        machineId: null
      })
    }
  })

  it('still names this runtime when its own load is unread', async () => {
    await expect(
      readAgentLaunchLoad(
        source(async () => undefined),
        'local'
      )
    ).resolves.toEqual({
      load: null,
      machineId: LOCAL_ID
    })
  })

  it("reads this Windows computer's zero load average as unknown, never ok", async () => {
    const read = vi.fn(async () => reading({ memory: ZERO_LOAD }))
    await expect(
      readAgentLaunchLoad(source(read, undefined, { local: 'win32' }), 'local')
    ).resolves.toEqual({
      load: null,
      machineId: LOCAL_ID
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('still bands an SSH host read from a Windows runtime by its own load average', async () => {
    const remote = reading({ hostKey: 'ssh:mw0002' })
    await expect(
      readAgentLaunchLoad(
        source(async () => remote, undefined, { local: 'win32' }),
        'ssh:mw0002'
      )
    ).resolves.toMatchObject({ load: { band: 'ok', loadPerCore: 0.3 }, machineId: SSH_ID })
  })

  it("reads a Windows SSH host's zero load average as unknown, never ok, and keeps its id", async () => {
    const remote = reading({ hostKey: 'ssh:win', memory: ZERO_LOAD })
    await expect(
      readAgentLaunchLoad(
        source(async () => remote, undefined, { 'ssh:win': 'win32' }),
        'ssh:win'
      )
    ).resolves.toEqual({ load: null, machineId: SSH_ID })
  })

  it('reads a zero from an SSH host of unknown OS as unknown, and bands a known POSIX zero', async () => {
    const zero = reading({ hostKey: 'ssh:new', memory: ZERO_LOAD })
    await expect(
      readAgentLaunchLoad(
        source(async () => zero, undefined, { 'ssh:new': null }),
        'ssh:new'
      )
    ).resolves.toEqual({ load: null, machineId: SSH_ID })
    // Why: only Windows reports a zero it never measured; a nonzero needs no OS to be read.
    const busy = reading({ hostKey: 'ssh:new' })
    await expect(
      readAgentLaunchLoad(
        source(async () => busy, undefined, { 'ssh:new': null }),
        'ssh:new'
      )
    ).resolves.toMatchObject({ load: { band: 'ok', loadPerCore: 0.3 } })
    await expect(
      readAgentLaunchLoad(
        source(async () => zero),
        'ssh:new'
      )
    ).resolves.toMatchObject({ load: { band: 'ok', loadPerCore: 0 }, machineId: SSH_ID })
  })

  it('treats a reading older than the max age as unknown', async () => {
    const old = reading({ readAt: NOW - AGENT_LAUNCH_LOAD_MAX_AGE_MS - 1 })
    await expect(
      readAgentLaunchLoad(
        source(async () => old),
        'ssh:slow'
      )
    ).resolves.toEqual({
      load: null,
      machineId: null
    })
  })

  it('answers unknown after the wait when the host never answers', async () => {
    vi.useFakeTimers()
    const pending = readAgentLaunchLoad(
      source(() => new Promise(() => {}), 2_000),
      'ssh:hung'
    )
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(pending).resolves.toEqual({ load: null, machineId: null })
  })
})

describe('readRuntimeAgentLaunchLoad', () => {
  it('reads the one host key through the shared reader and its kept machine id', async () => {
    const read = vi.fn(async (keys: readonly string[]) =>
      keys.map((hostKey) => reading({ hostKey, readAt: Date.now() }))
    )
    vi.mocked(getHostResourceReader).mockReturnValue({ read } as never)
    vi.mocked(hostResourceMachineId).mockReturnValue(SSH_ID)
    vi.mocked(hostResourcePlatform).mockReturnValue('linux')
    await expect(readRuntimeAgentLaunchLoad('ssh:mw0002')).resolves.toMatchObject({
      load: { band: 'ok', liveSessions: 4 },
      machineId: SSH_ID
    })
    expect(read).toHaveBeenCalledWith(['ssh:mw0002'])
    expect(hostResourceMachineId).toHaveBeenCalledWith('ssh:mw0002')
    expect(hostResourcePlatform).toHaveBeenCalledWith('ssh:mw0002')
  })

  it("answers this Windows computer's own load as unknown without reading it", async () => {
    const read = vi.fn(async (keys: readonly string[]) =>
      keys.map((hostKey) => reading({ hostKey, readAt: Date.now(), memory: ZERO_LOAD }))
    )
    vi.mocked(getHostResourceReader).mockReturnValue({ read } as never)
    vi.mocked(hostResourceMachineId).mockReturnValue(LOCAL_ID)
    vi.mocked(hostResourcePlatform).mockReturnValue('win32')
    await expect(readRuntimeAgentLaunchLoad('local')).resolves.toEqual({
      load: null,
      machineId: LOCAL_ID
    })
    expect(read).not.toHaveBeenCalled()
  })
})

it('does not turn malformed memory into a measured zero', async () => {
  const report = await readAgentLaunchLoad(
    source(async () =>
      reading({
        memory: { totalMemory: 64, availableMemory: Number.NaN, cpuCoreCount: 10, loadAverage1m: 3 }
      })
    ),
    'local'
  )
  expect(report.load).toMatchObject({ band: 'ok', loadPerCore: 0.3 })
  expect(report.load).not.toHaveProperty('freeBytes')
  expect(report.load).not.toHaveProperty('totalBytes')
})
