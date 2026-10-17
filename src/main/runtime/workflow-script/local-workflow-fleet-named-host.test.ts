import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import { WORKFLOW_FLEET_RUNTIME_PROBE_COMMAND } from './local-workflow-fleet-hosts'
import {
  listWorkflowFleetHostOptions,
  placeLocalWorkflow,
  WorkflowFleetPlacementRefusal
} from './local-workflow-fleet-placement'

const NOW = 1_800_000_000_000
const LOCAL = { hostname: 'mw0003.local', cores: 10, load1: 1 }
const ESTATE = JSON.stringify({
  hosts: [
    { name: 'macserver-primary', machine: 'macserver-3-95', ssh: 'studio', heavy_ok: false },
    { name: 'mw0002', machine: 'macserver-0-02', ssh: 'mw0002', heavy_ok: true },
    { name: 'mw0003', machine: 'mw0003', hostname: 'mw0003', ssh: 'mw0003', heavy_ok: true },
    { name: 'mw0004', machine: 'mw0004', hostname: 'mw0004', ssh: 'mw0004', heavy_ok: true }
  ]
})
const NO_ACCOUNTS = JSON.stringify({
  id: 'cli-1',
  ok: false,
  error: { code: 'runtime_error', message: 'Account services are not configured on this runtime' }
})
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function hostsFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omni-fleet-named-'))
  directories.push(dir)
  const path = join(dir, 'hosts.json')
  await writeFile(path, ESTATE)
  return path
}

const done = (stdout: string, code = 0): ProcessResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})

/** Load readings per alias; the runtime probe answers as an orcad host without accounts. */
function readings(loads: Record<string, string | undefined>) {
  return vi.fn(async (spec: ProcessSpec): Promise<ProcessResult> => {
    const [alias, command] = spec.args!.slice(-2)
    if (command === WORKFLOW_FLEET_RUNTIME_PROBE_COMMAND) {
      return done(NO_ACCOUNTS, 1)
    }
    const load = loads[alias!]
    if (load === undefined) {
      throw new Error(`no ssh to ${alias}`)
    }
    return done(load)
  })
}

async function place(
  pick: Parameters<typeof placeLocalWorkflow>[2],
  loads: Record<string, string | undefined>,
  runsOn: 'fleet' | 'local' = 'fleet'
) {
  const run = readings(loads)
  const placement = placeLocalWorkflow(
    runsOn,
    { hostsFile: await hostsFile(), run, local: LOCAL, now: () => NOW },
    pick
  )
  return { placement, run }
}

describe('a Start on a named host', () => {
  it('reads only that host and places dispatched seats there, recording the pick', async () => {
    const { placement, run } = await place(
      { host: 'mw0004', hostId: 'ssh:ssh-2602' },
      { mw0004: '10\n{ 7.00 6.00 5.00 }\n' }
    )
    // 0.7 is over the auto chooser's 0.6 but under the 0.8 bound a named host is held to.
    expect(await placement).toEqual({
      runsOn: 'fleet',
      mode: 'dispatched-seats',
      choice: 'named',
      hostId: 'ssh:ssh-2602',
      host: {
        name: 'mw0004',
        machine: 'mw0004',
        cores: 10,
        loadPerCore: 0.7,
        readAt: NOW,
        ssh: 'mw0004'
      }
    })
    const aliases = run.mock.calls.map(([spec]) => spec.args!.at(-2))
    expect(new Set(aliases)).toEqual(new Set(['mw0004']))
  })

  it('refuses a named host above 0.8 load per core by name', async () => {
    const { placement } = await place({ host: 'mw0004' }, { mw0004: '10\n{ 9.10 6.00 5.00 }\n' })
    await expect(placement).rejects.toThrow(
      'mw0004 is too busy for this run (0.91 load per core, over 0.8). Choose another host, or force it with a reason.'
    )
  })

  it("takes a busy named host when a person forces it, and records the person's reason", async () => {
    const { placement } = await place(
      { host: 'mw0004', forceReason: 'the batch finishes in a minute' },
      { mw0004: '10\n{ 9.10 6.00 5.00 }\n' }
    )
    expect(await placement).toMatchObject({
      mode: 'dispatched-seats',
      choice: 'named',
      forced: 'the batch finishes in a minute'
    })
  })

  it('does not record a forced reason the reading did not need', async () => {
    const { placement } = await place(
      { host: 'mw0004', forceReason: 'just in case' },
      { mw0004: '10\n{ 1.00 1.00 1.00 }\n' }
    )
    expect(await placement).not.toHaveProperty('forced')
  })

  it('refuses a named host it cannot read, never assuming its capacity', async () => {
    const { placement } = await place({ host: 'mw0004' }, {})
    const refusal = await placement.catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(WorkflowFleetPlacementRefusal)
    expect((refusal as Error).message).toBe(
      "mw0004 cannot take this run (unreachable). Choose another host, the fleet, or 'this computer'."
    )
  })

  it('refuses a name the hosts file does not have, listing the heavy-work hosts', async () => {
    const { placement } = await place({ host: 'mw9999' }, {})
    await expect(placement).rejects.toThrow(
      /^No fleet host is named mw9999 in .*hosts\.json \(heavy-work hosts: mw0002, mw0003, mw0004\)\.$/
    )
  })

  it('refuses a host that is not for heavy work', async () => {
    const { placement } = await place({ host: 'macserver-primary' }, {})
    await expect(placement).rejects.toThrow(
      "macserver-primary cannot take this run (not a heavy-work host). Choose another host, the fleet, or 'this computer'."
    )
  })

  it('runs here when the named host is this computer', async () => {
    const { placement, run } = await place({ host: 'mw0003', hostId: 'local' }, {})
    expect(await placement).toEqual({
      runsOn: 'fleet',
      mode: 'local',
      choice: 'named',
      hostId: 'local',
      host: { name: 'mw0003', machine: 'mw0003', cores: 10, loadPerCore: 0.1, readAt: NOW }
    })
    expect(run).not.toHaveBeenCalled()
  })

  it("refuses 'this computer' and a named host together", async () => {
    const { placement } = await place({ host: 'mw0004' }, {}, 'local')
    await expect(placement).rejects.toThrow(
      "Choose either 'this computer' or a host to run on, not both (mw0004)."
    )
  })
})

describe('an SSH alias', () => {
  it('never reaches ssh when it reads as an option', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omni-fleet-alias-'))
    directories.push(dir)
    const path = join(dir, 'hosts.json')
    await writeFile(
      path,
      JSON.stringify({
        hosts: [{ name: 'evil', ssh: '-oProxyCommand=touch /tmp/owned', heavy_ok: true }]
      })
    )
    const run = readings({})
    await expect(
      placeLocalWorkflow(
        'fleet',
        { hostsFile: path, run, local: LOCAL, now: () => NOW },
        {
          host: 'evil'
        }
      )
    ).rejects.toThrow('evil cannot take this run (unreachable).')
    expect(run).not.toHaveBeenCalled()
  })
})

describe('the hosts a form offers', () => {
  it('lists heavy-work hosts only, marking this computer', async () => {
    const listed = await listWorkflowFleetHostOptions({
      hostsFile: await hostsFile(),
      local: LOCAL
    })
    expect(listed.hosts).toEqual([
      {
        name: 'mw0002',
        machine: 'macserver-0-02',
        hostname: 'mw0002',
        ssh: 'mw0002',
        local: false
      },
      { name: 'mw0003', machine: 'mw0003', hostname: 'mw0003', ssh: 'mw0003', local: true },
      { name: 'mw0004', machine: 'mw0004', hostname: 'mw0004', ssh: 'mw0004', local: false }
    ])
  })
})
