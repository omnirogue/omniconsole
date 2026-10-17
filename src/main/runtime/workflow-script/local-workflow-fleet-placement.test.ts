import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import { chooseWorkflowFleetHost } from '../../../shared/local-workflow-placement'
import {
  isLocalWorkflowFleetHost,
  parseWorkflowFleetLoad,
  parseWorkflowFleetRuntimeProbe,
  probeWorkflowFleetRuntime,
  readWorkflowFleetCapacity,
  readWorkflowFleetHosts,
  WORKFLOW_FLEET_HOSTS_FILE_ENV,
  WORKFLOW_FLEET_LOAD_COMMAND,
  WORKFLOW_FLEET_RUNTIME_PROBE_COMMAND,
  workflowFleetHostsFilePath,
  type WorkflowFleetHost
} from './local-workflow-fleet-hosts'
import { placeLocalWorkflow } from './local-workflow-fleet-placement'

const NOW = 1_800_000_000_000
const LOCAL = { hostname: 'macserver-0-01.local', cores: 24, load1: 6 }
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function hostsFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'omni-fleet-hosts-'))
  directories.push(dir)
  const path = join(dir, 'hosts.json')
  await writeFile(path, contents)
  return path
}

const ESTATE = JSON.stringify({
  hosts: [
    { name: 'macserver-primary', machine: 'macserver-3-95', ssh: null, heavy_ok: false },
    {
      name: 'mw0001',
      machine: 'macserver-0-01',
      hostname: 'macserver-0-01',
      ssh: 'mw0001',
      heavy_ok: true
    },
    { name: 'mw0001-estate', machine: 'macserver-0-01', ssh: 'mw0001-estate', heavy_ok: true },
    {
      name: 'mw0002',
      machine: 'macserver-0-02',
      hostname: 'macserver-0-02',
      ssh: 'mw0002',
      heavy_ok: true
    },
    {
      name: 'demo-claude',
      machine: 'cloud-vm',
      hostname: 'cloud-vm',
      ssh: 'demo-claude',
      heavy_ok: true
    },
    { name: 'mw0003', machine: 'mw0003', hostname: 'mw0003', ssh: 'mw0003', heavy_ok: true },
    { ssh: 'nameless', heavy_ok: true }
  ]
})

/** What `omni account list --json` prints where account services exist (this Mac, 28 Sep 2026). */
const RUNTIME_WITH_ACCOUNTS = JSON.stringify({
  id: 'cli-1',
  ok: true,
  result: { claude: { accounts: [] }, codex: { accounts: [] }, rateLimits: {} },
  _meta: { runtimeId: 'runtime-1' }
})
/** What the plain-Node orcad on mw0002 printed on 28 Sep 2026, with exit 1: no account services. */
const RUNTIME_WITHOUT_ACCOUNTS = JSON.stringify({
  id: 'cli-1',
  ok: false,
  error: { code: 'runtime_error', message: 'Account services are not configured on this runtime' },
  _meta: { runtimeId: 'runtime-2' }
})

const done = (stdout: string, code = 0): ProcessResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})

/** ssh runs answered per alias; an alias without an answer rejects as a spawn failure. */
function fakeRun(answers: Record<string, ProcessResult | 'throw'>) {
  return vi.fn(async (spec: ProcessSpec): Promise<ProcessResult> => {
    const alias = spec.args![4]!
    const answer = answers[alias]
    if (!answer || answer === 'throw') {
      throw new Error(`no ssh to ${alias}`)
    }
    return answer
  })
}

describe('the estate hosts file', () => {
  it('is read from OMNI_ESTATE_HOSTS_FILE, else the canonical path under the home folder', () => {
    expect(workflowFleetHostsFilePath({ [WORKFLOW_FLEET_HOSTS_FILE_ENV]: '/x/hosts.json' })).toBe(
      '/x/hosts.json'
    )
    expect(workflowFleetHostsFilePath({}, '/Users/maintainer')).toBe(
      join('/Users/maintainer', 'Work', 'Ops', 'autonomy', 'canonical', 'hosts.json')
    )
  })

  it('lists named rows once per machine and reads a missing file as no hosts', async () => {
    expect(await readWorkflowFleetHosts(join(tmpdir(), 'omni-fleet-none', 'hosts.json'))).toEqual(
      []
    )
    const hosts = await readWorkflowFleetHosts(await hostsFile(ESTATE))
    expect(hosts.map((host) => host.name)).toEqual([
      'macserver-primary',
      'mw0001',
      'mw0002',
      'demo-claude',
      'mw0003'
    ])
    expect(hosts[0]).toEqual({
      name: 'macserver-primary',
      machine: 'macserver-3-95',
      hostname: 'macserver-primary',
      ssh: null,
      heavyOk: false
    })
    await expect(readWorkflowFleetHosts(await hostsFile('{nope'))).rejects.toThrow('is not JSON')
  })

  it('knows which row is this computer, with or without .local', () => {
    const row: WorkflowFleetHost = {
      name: 'mw0001',
      machine: 'macserver-0-01',
      hostname: 'macserver-0-01',
      ssh: 'mw0001',
      heavyOk: true
    }
    expect(isLocalWorkflowFleetHost(row, 'macserver-0-01.local')).toBe(true)
    expect(isLocalWorkflowFleetHost(row, 'MacServer-3-93')).toBe(true)
    expect(isLocalWorkflowFleetHost(row, 'macserver-0-02.local')).toBe(false)
  })
})

describe('capacity readings', () => {
  it('parses the macOS and Linux outputs of the one load command', () => {
    expect(parseWorkflowFleetLoad('16\n{ 7.57 11.96 11.86 }\n')).toEqual({ cores: 16, load1: 7.57 })
    expect(parseWorkflowFleetLoad('8\n0.52 0.58 0.59 1/1234 5678\n')).toEqual({
      cores: 8,
      load1: 0.52
    })
    expect(parseWorkflowFleetLoad('')).toBeUndefined()
    expect(parseWorkflowFleetLoad('0\n{ 1.0 }')).toBeUndefined()
    expect(parseWorkflowFleetLoad('banner\n16\n{ 1.0 }')).toBeUndefined()
  })

  it('never reads a number out of malformed output as a load', () => {
    // A stray number in an error line must not become an idle, verified host.
    expect(parseWorkflowFleetLoad('16\nprobe failed with code 0\n')).toBeUndefined()
    expect(parseWorkflowFleetLoad('16\n{ 7.57 11.96 11.86 }\nbanner after\n')).toBeUndefined()
    expect(parseWorkflowFleetLoad('16 cores\n{ 0.10 0.20 0.30 }\n')).toBeUndefined()
    expect(parseWorkflowFleetLoad('16\n0.10 0.20\n')).toBeUndefined()
    expect(parseWorkflowFleetLoad('-16\n{ 0.10 0.20 0.30 }\n')).toBeUndefined()
    // A core count past the safe-integer range would read as Infinity cores and zero load.
    expect(parseWorkflowFleetLoad(`${'9'.repeat(309)}\n{ 1.00 1.00 1.00 }\n`)).toBeUndefined()
    expect(parseWorkflowFleetLoad('9007199254740993\n{ 1.00 1.00 1.00 }\n')).toBeUndefined()
  })

  it('records malformed output as unreachable, so the chooser never verifies it', async () => {
    const candidates = await readWorkflowFleetCapacity(
      [{ name: 'worker', machine: 'worker', hostname: 'worker', ssh: 'worker', heavyOk: true }],
      { run: async () => done('16\nprobe failed with code 0\n'), local: LOCAL, now: () => NOW }
    )
    expect(candidates[0]?.capacity).toEqual({ state: 'unreachable' })
    expect(chooseWorkflowFleetHost(candidates, NOW)).toBeUndefined()
  })

  it('reads this computer locally and every other heavy host over bounded ssh, in parallel', async () => {
    const run = fakeRun({
      mw0002: done('16\n{ 7.57 11.96 11.86 }\n'),
      'demo-claude': done('8\n0.52 0.58 0.59 1/1234 5678\n'),
      mw0003: done('', 255)
    })
    const candidates = await readWorkflowFleetCapacity(
      await readWorkflowFleetHosts(await hostsFile(ESTATE)),
      { run, local: LOCAL, now: () => NOW }
    )
    expect(candidates).toEqual([
      {
        name: 'mw0001',
        machine: 'macserver-0-01',
        ssh: 'mw0001',
        heavyOk: true,
        local: true,
        cores: 24,
        capacity: { state: 'fresh', loadPerCore: 0.25, readAt: NOW }
      },
      {
        name: 'mw0002',
        machine: 'macserver-0-02',
        ssh: 'mw0002',
        heavyOk: true,
        local: false,
        cores: 16,
        capacity: { state: 'fresh', loadPerCore: 7.57 / 16, readAt: NOW }
      },
      {
        name: 'demo-claude',
        machine: 'cloud-vm',
        ssh: 'demo-claude',
        heavyOk: true,
        local: false,
        cores: 8,
        capacity: { state: 'fresh', loadPerCore: 0.52 / 8, readAt: NOW }
      },
      {
        name: 'mw0003',
        machine: 'mw0003',
        ssh: 'mw0003',
        heavyOk: true,
        local: false,
        cores: 0,
        capacity: { state: 'unreachable' }
      }
    ])
    // The primary is not a heavy host and this computer is never asked over ssh.
    expect(run.mock.calls.map(([spec]) => spec.args![4])).toEqual([
      'mw0002',
      'demo-claude',
      'mw0003'
    ])
    expect(run.mock.calls[0]![0]).toEqual({
      program: 'ssh',
      args: [
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=3',
        'mw0002',
        WORKFLOW_FLEET_LOAD_COMMAND
      ],
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024
    })
  })

  it('reads this computer as unknown where the OS keeps no load average', async () => {
    // Windows: `os.loadavg()` is zeros, and zero must never read as an idle, verified host.
    const candidates = await readWorkflowFleetCapacity(
      await readWorkflowFleetHosts(await hostsFile(ESTATE)),
      { run: fakeRun({}), local: { ...LOCAL, load1: undefined }, now: () => NOW }
    )
    expect(candidates.find((candidate) => candidate.local)?.capacity).toEqual({ state: 'unknown' })
    expect(chooseWorkflowFleetHost(candidates, NOW)).toBeUndefined()
  })

  it('leaves a host unreachable when ssh times out, fails to start or answers nonsense', async () => {
    const hosts: WorkflowFleetHost[] = ['slow', 'gone', 'odd'].map((name) => ({
      name,
      machine: name,
      hostname: name,
      ssh: name,
      heavyOk: true
    }))
    const run = fakeRun({
      slow: { ...done(''), timedOut: true },
      gone: 'throw',
      odd: done('not a number\n')
    })
    const candidates = await readWorkflowFleetCapacity(hosts, { run, local: LOCAL })
    expect(candidates.map((candidate) => candidate.capacity)).toEqual([
      { state: 'unreachable' },
      { state: 'unreachable' },
      { state: 'unreachable' }
    ])
  })
})

describe('the runtime probe', () => {
  it('reads the CLI envelope, never a bare snapshot or the top level', () => {
    expect(parseWorkflowFleetRuntimeProbe(RUNTIME_WITH_ACCOUNTS)).toBe(true)
    // The CLI prints the envelope; the snapshot alone never reaches stdout.
    expect(
      parseWorkflowFleetRuntimeProbe('{"claude":{"accounts":[]},"codex":{"accounts":[]}}')
    ).toBe(false)
    expect(parseWorkflowFleetRuntimeProbe(RUNTIME_WITHOUT_ACCOUNTS)).toBe(false)
    expect(
      parseWorkflowFleetRuntimeProbe(JSON.stringify({ ok: true, result: { claude: {} } }))
    ).toBe(false)
    expect(
      parseWorkflowFleetRuntimeProbe(
        JSON.stringify({ ok: 'true', result: { claude: {}, codex: {} } })
      )
    ).toBe(false)
    expect(parseWorkflowFleetRuntimeProbe('No owning Orca client is connected')).toBe(false)
    expect(parseWorkflowFleetRuntimeProbe('null')).toBe(false)
  })

  it('passes only when the host answers the success envelope with exit 0', async () => {
    const host = { ssh: 'mw0002' }
    const run = fakeRun({ mw0002: done(RUNTIME_WITH_ACCOUNTS) })
    expect(await probeWorkflowFleetRuntime(host, { run })).toBe(true)
    expect(run.mock.calls[0]![0].args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=3',
      'mw0002',
      WORKFLOW_FLEET_RUNTIME_PROBE_COMMAND
    ])
    for (const answer of [
      // orcad today: the failure envelope and exit 1.
      done(RUNTIME_WITHOUT_ACCOUNTS, 1),
      // A failure envelope with a zero exit is still no runtime with account services.
      done(RUNTIME_WITHOUT_ACCOUNTS),
      done(RUNTIME_WITH_ACCOUNTS, 1),
      { ...done(RUNTIME_WITH_ACCOUNTS), timedOut: true },
      done('command not found: omni', 127),
      done('{"claude":{}}'),
      done('No owning Orca client is connected'),
      'throw' as const
    ]) {
      expect(await probeWorkflowFleetRuntime(host, { run: fakeRun({ mw0002: answer }) })).toBe(
        false
      )
    }
    expect(await probeWorkflowFleetRuntime({ ssh: null }, { run: fakeRun({}) })).toBe(false)
  })
})

describe('placing a Start', () => {
  it('runs here on request without reading anything', async () => {
    const run = fakeRun({})
    expect(await placeLocalWorkflow('local', { run, hostsFile: '/nowhere/hosts.json' })).toEqual({
      runsOn: 'local',
      mode: 'local'
    })
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a fleet run by name when no host verifies spare capacity, absent runsOn included', async () => {
    const hostsFilePath = await hostsFile(ESTATE)
    const run = fakeRun({
      mw0002: done('16\n{ 12.1 11.96 11.86 }\n'),
      mw0003: done('', 255)
    })
    await expect(
      placeLocalWorkflow(undefined, {
        run,
        hostsFile: hostsFilePath,
        local: { ...LOCAL, load1: 20 },
        now: () => NOW
      })
    ).rejects.toThrow(
      "No fleet host has verified spare capacity (mw0001: 0.83 load per core, mw0002: 0.76 load per core, demo-claude: unreachable, mw0003: unreachable). Choose 'this computer' to run here."
    )
    const missing = join(tmpdir(), 'omni-fleet-none', 'hosts.json')
    await expect(placeLocalWorkflow('fleet', { run, hostsFile: missing })).rejects.toThrow(
      `No fleet host has verified spare capacity (no fleet hosts in ${missing}). Choose 'this computer' to run here.`
    )
  })

  it('runs here when the fleet choice is this computer, and records the choice', async () => {
    const run = fakeRun({ mw0002: done('16\n{ 8.0 1 1 }\n') })
    expect(
      await placeLocalWorkflow('fleet', {
        run,
        hostsFile: await hostsFile(ESTATE),
        local: LOCAL,
        now: () => NOW
      })
    ).toEqual({
      runsOn: 'fleet',
      host: {
        name: 'mw0001',
        machine: 'macserver-0-01',
        cores: 24,
        loadPerCore: 0.25,
        readAt: NOW
      },
      mode: 'local'
    })
    expect(run.mock.calls.every(([spec]) => spec.args![5] === WORKFLOW_FLEET_LOAD_COMMAND)).toBe(
      true
    )
  })

  it('refuses remote-runtime by name and places dispatched-seats on another host', async () => {
    const hostsFilePath = await hostsFile(ESTATE)
    const busyHere = { ...LOCAL, load1: 20 }
    const withRuntime = fakeRun({
      mw0002: done('16\n{ 1.6 1 1 }\n'),
      'demo-claude': done('8\n4.0 1 1 1/1 1\n'),
      mw0003: done('', 255)
    })
    withRuntime.mockImplementationOnce(withRuntime.getMockImplementation()!)
    const alternative = await placeLocalWorkflow('fleet', {
      run: vi.fn(async (spec: ProcessSpec) =>
        spec.args![5] === WORKFLOW_FLEET_RUNTIME_PROBE_COMMAND
          ? spec.args![4] === 'mw0002'
            ? done(RUNTIME_WITH_ACCOUNTS)
            : done(RUNTIME_WITHOUT_ACCOUNTS, 1)
          : withRuntime(spec)
      ),
      hostsFile: hostsFilePath,
      local: busyHere,
      now: () => NOW
    })
    expect(alternative).toMatchObject({ mode: 'dispatched-seats', host: { name: 'demo-claude' } })
    await expect(
      placeLocalWorkflow('fleet', {
        run: vi.fn(async (spec: ProcessSpec) =>
          spec.args![5] === WORKFLOW_FLEET_RUNTIME_PROBE_COMMAND
            ? done(RUNTIME_WITH_ACCOUNTS)
            : withRuntime(spec)
        ),
        hostsFile: hostsFilePath,
        local: busyHere,
        now: () => NOW
      })
    ).rejects.toThrow('demo-claude runs an OmniConsole runtime')

    const noRuntime = fakeRun({
      mw0002: done('16\n{ 1.6 1 1 }\n'),
      'demo-claude': done('8\n4.0 1 1 1/1 1\n'),
      mw0003: done('', 255)
    })
    const placed = await placeLocalWorkflow('fleet', {
      run: vi.fn(async (spec: ProcessSpec) =>
        spec.args![5] === WORKFLOW_FLEET_RUNTIME_PROBE_COMMAND
          ? done(RUNTIME_WITHOUT_ACCOUNTS, 1)
          : noRuntime(spec)
      ),
      hostsFile: hostsFilePath,
      local: busyHere,
      now: () => NOW
    })
    // The alias is frozen with the host, so launches and replays never re-read the hosts file.
    expect(placed).toEqual({
      runsOn: 'fleet',
      host: {
        name: 'mw0002',
        machine: 'macserver-0-02',
        cores: 16,
        loadPerCore: 0.1,
        readAt: NOW,
        ssh: 'mw0002'
      },
      mode: 'dispatched-seats'
    })
  })
})
