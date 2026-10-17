import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostListEntry } from '../format'
import type { RuntimeClient } from '../runtime-client'
import { quoteCliCommandArgument } from '../shell-command-quote'

const { listEnvironmentsMock, readHostListCapacityMock } = vi.hoisted(() => ({
  listEnvironmentsMock: vi.fn(),
  readHostListCapacityMock: vi.fn()
}))

vi.mock('../launch-capacity-host-list', () => ({
  readHostListCapacity: readHostListCapacityMock
}))

vi.mock('../runtime/environments', () => ({
  addEnvironmentFromPairingCode: vi.fn(),
  listEnvironments: listEnvironmentsMock,
  removeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

import { ENVIRONMENT_HANDLERS } from './environment'

function clientWithSshTargets(targets: { id: string; label: string }[]): RuntimeClient {
  return {
    call: vi.fn(async () => ({ id: 'rpc', ok: true, result: { targets } }))
  } as unknown as RuntimeClient
}

async function hostList(
  environments: { id: string; name: string }[],
  sshTargets: { id: string; label: string }[],
  json: boolean,
  flags = new Map<string, string | boolean>()
): Promise<string> {
  listEnvironmentsMock.mockReturnValue(environments)
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  await ENVIRONMENT_HANDLERS['host list']!({
    flags,
    client: clientWithSshTargets(sshTargets),
    cwd: '/tmp',
    json
  })
  return String(log.mock.calls.at(-1)?.[0])
}

async function hostListJson(
  environments: { id: string; name: string }[],
  sshTargets: { id: string; label: string }[]
): Promise<HostListEntry[]> {
  return JSON.parse(await hostList(environments, sshTargets, true)).result.hosts
}

afterEach(() => {
  vi.restoreAllMocks()
  listEnvironmentsMock.mockReset()
  readHostListCapacityMock.mockReset()
})

describe('omni host list', () => {
  it('quotes selectors and names each computer for session launch', async () => {
    const hosts = await hostListJson(
      [
        { id: 'env-studio', name: 'Mac Studio' },
        { id: 'env-2586', name: 'mw0002' }
      ],
      [{ id: 'ssh-1759-abc', label: 'studio' }]
    )

    expect(hosts).toEqual([
      {
        kind: 'local',
        name: 'this machine',
        id: 'local',
        selector: '--host local',
        launch: '--host local'
      },
      {
        kind: 'ssh',
        name: 'studio',
        id: 'ssh-1759-abc',
        selector: '--host ssh:ssh-1759-abc',
        launch: '--host studio'
      },
      {
        kind: 'environment',
        name: 'Mac Studio',
        id: 'env-studio',
        selector: `--environment ${quoteCliCommandArgument('Mac Studio')}`,
        launch: `--host ${quoteCliCommandArgument('Mac Studio')}`
      },
      {
        kind: 'environment',
        name: 'mw0002',
        id: 'env-2586',
        selector: '--environment mw0002',
        launch: '--host mw0002'
      }
    ])
    // Why: the regression was `--environment Mac Studio` printed bare, which a shell splits in two.
    expect(hosts[2]!.selector).not.toBe('--environment Mac Studio')
  })

  it('falls back to the exact id when a name is shared or reads as a launch keyword', async () => {
    const hosts = await hostListJson(
      [
        { id: 'env-a', name: 'desk' },
        { id: 'env-b', name: 'Desk' },
        { id: 'env-auto', name: 'auto' }
      ],
      [
        { id: 'ssh-local', label: 'local' },
        { id: 'ssh-prefixed', label: 'runtime:box' },
        { id: 'ssh-machine', label: 'This Machine' }
      ]
    )

    expect(Object.fromEntries(hosts.map((host) => [host.id, host.launch]))).toEqual({
      local: '--host local',
      'ssh-local': '--host ssh:ssh-local',
      'ssh-prefixed': '--host ssh:ssh-prefixed',
      // Why: session launch reads "this machine" as this computer, the name host list prints for it.
      'ssh-machine': '--host ssh:ssh-machine',
      'env-a': '--host runtime:env-a',
      'env-b': '--host runtime:env-b',
      'env-auto': '--host runtime:env-auto'
    })
  })

  it('keeps one name on both rows when a paired computer and an SSH target share it', async () => {
    const hosts = await hostListJson(
      [{ id: 'env-2556', name: 'mw0001' }],
      [{ id: 'ssh-2556', label: 'mw0001' }]
    )

    expect(hosts.filter((host) => host.kind !== 'local').map((host) => host.launch)).toEqual([
      '--host mw0001',
      '--host mw0001'
    ])
  })

  it('prints each launch flag and a session launch footer', async () => {
    const text = await hostList(
      [{ id: 'env-studio', name: 'Mac Studio' }],
      [{ id: 'ssh-1', label: 'studio' }],
      false
    )

    const quoted = quoteCliCommandArgument('Mac Studio')
    expect(text).toContain(`Mac Studio  ->  --environment ${quoted}  launch: --host ${quoted}`)
    expect(text).toContain('studio  ->  --host ssh:ssh-1  launch: --host studio')
    expect(text.split('\n').at(-1)).toBe(
      'Launch on any of these: omni session launch --host <name> …'
    )
  })

  it('stays a local listing: it never reads capacity without --capacity', async () => {
    await hostList([{ id: 'env-studio', name: 'Mac Studio' }], [], true)
    expect(readHostListCapacityMock).not.toHaveBeenCalled()
  })

  it('refuses capacity flags without --capacity instead of ignoring them', async () => {
    await expect(hostList([], [], true, new Map([['provider', 'claude']]))).rejects.toThrow(
      '--provider only applies with --capacity'
    )
    expect(readHostListCapacityMock).not.toHaveBeenCalled()
  })

  it('prints the capacity view as JSON with --capacity', async () => {
    const view = {
      provider: 'claude',
      model: null,
      project: null,
      checkedAt: 1,
      rows: [],
      recommendedCommand: null,
      notes: ['No computer can take this claude launch now. Nothing to launch.']
    }
    readHostListCapacityMock.mockResolvedValue(view)
    const flags = new Map<string, string | boolean>([
      ['capacity', true],
      ['provider', 'claude']
    ])

    const printed = JSON.parse(await hostList([], [], true, flags))

    expect(readHostListCapacityMock).toHaveBeenCalledWith(flags)
    expect(printed.result).toEqual(view)
  })

  it('--capacity never builds the routed client, so a stale ambient selector cannot refuse it', async () => {
    readHostListCapacityMock.mockResolvedValue({ provider: 'claude', rows: [], notes: [] })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const flags = new Map<string, string | boolean>([
      ['capacity', true],
      ['provider', 'claude']
    ])
    await ENVIRONMENT_HANDLERS['host list']!({
      flags,
      get client(): RuntimeClient {
        throw new Error('Unknown environment: desk')
      },
      cwd: '/tmp',
      json: true
    })
    expect(readHostListCapacityMock).toHaveBeenCalledWith(flags)
  })
})
