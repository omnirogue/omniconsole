import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import { BuildReviewService } from './build-review-service'
import { createFakeRuntime, createScriptedCaller } from './build-review-service-fixture'
import type { BuildReviewWorkspaceHeldError } from './build-review-workspace-evidence'
import {
  WORKFLOW_FLEET_LOAD_COMMAND,
  WORKFLOW_FLEET_RUNTIME_PROBE_COMMAND
} from '../workflow-script/local-workflow-fleet-hosts'

vi.mock('./build-review-workspace-reservation', () => ({
  buildReviewWorkspaceKey: () => 'local-workspace',
  claimBuildReviewWorkspace: vi.fn(),
  bindBuildReviewRun: vi.fn(),
  markBuildReviewWorkerStart: vi.fn(),
  recordBuildReviewWorkerStart: vi.fn(),
  clearRejectedBuildReviewWorkerStart: vi.fn(),
  releaseBuildReviewWorkspace: vi.fn(() => true),
  ownerDefinitelyGone: vi.fn(() => true)
}))

type HoldFactsFixture = { reservation: { pipeline_id: string; run_id: string | null } }
const reconcile = vi.hoisted(() => ({
  claimOptions: vi.fn(async () => ({})),
  releaseSettled: vi.fn(
    async (_deps: unknown, _key: string, _mode: 'observe' | 'release'): Promise<unknown> => null
  )
}))
vi.mock('./build-review-workspace-reconcile', () => ({
  buildReviewClaimOptions: reconcile.claimOptions,
  releaseSettledBuildReviewWorkspace: reconcile.releaseSettled,
  heldErrorFacts: (error: BuildReviewWorkspaceHeldError) => ({
    reservation: error.reservation,
    open: [],
    missingEvidence: false,
    owner: null
  }),
  buildReviewWorkspaceHold: (facts: HoldFactsFixture) => ({
    pipelineId: facts.reservation.pipeline_id,
    runId: facts.reservation.run_id,
    items: []
  })
}))

const NOW = 1_800_000_000_000
const LOCAL = { hostname: 'macserver-0-01.local', cores: 24, load1: 6 }
const THIS_COMPUTER = {
  name: 'mw0001',
  machine: 'macserver-0-01',
  hostname: 'macserver-0-01',
  ssh: 'mw0001',
  role: 'worker',
  heavy_ok: true
}
const REMOTE = {
  name: 'mw0002',
  machine: 'macserver-0-02',
  hostname: 'macserver-0-02',
  ssh: 'mw0002',
  role: 'worker',
  heavy_ok: true
}

const done = (stdout: string, code = 0): ProcessResult => ({
  code,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false
})

/** ssh answers by the command sent: the load reading, then the runtime probe. */
function sshAnswering(load: ProcessResult, probe: ProcessResult) {
  return async (spec: ProcessSpec): Promise<ProcessResult> => {
    const command = spec.args?.at(-1)
    if (command === WORKFLOW_FLEET_LOAD_COMMAND) {
      return load
    }
    if (command === WORKFLOW_FLEET_RUNTIME_PROBE_COMMAND) {
      return probe
    }
    throw new Error(`unexpected ssh command ${String(command)}`)
  }
}

async function settle(service: BuildReviewService, id: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    const stage = service.show(id).stage
    if (stage === 'completed' || stage === 'failed' || stage === 'cancelled') {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('pipeline never settled')
}

const dirs: string[] = []
async function hostsFile(hosts: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'build-review-placement-'))
  dirs.push(dir)
  const path = join(dir, 'hosts.json')
  await writeFile(path, JSON.stringify({ hosts }))
  return path
}

beforeEach(() => {
  reconcile.claimOptions.mockResolvedValue({})
  reconcile.releaseSettled.mockReset()
  reconcile.releaseSettled.mockResolvedValue(null)
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('Build + Review placement', () => {
  it('forgets the previous placement when a Retry finds the host busy', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'failed' })
    const local = { ...LOCAL }
    const service = new BuildReviewService(runtime, caller, undefined, {
      placement: { hostsFile: await hostsFile([THIS_COMPUTER]), local, now: () => NOW }
    })
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Review the queue' })
    await settle(service, started.id)
    expect(service.show(started.id).placement?.host?.loadPerCore).toBe(0.25)
    // The same host, still registered, now over the 60 percent bound: 20 / 24 cores.
    local.load1 = 20
    const startsBefore = calls.filter((call) => call.method === 'orchestration.workerStart').length
    await service.retry(started.id)
    await settle(service, started.id)
    const shown = service.show(started.id)
    expect(shown.stage).toBe('failed')
    expect(shown.error).toBe(
      "No fleet host has verified spare capacity (mw0001: 0.83 load per core). Choose 'this computer' to run here."
    )
    expect(shown.placement).toBeUndefined()
    expect(calls.filter((call) => call.method === 'orchestration.workerStart').length).toBe(
      startsBefore
    )
  })

  it('forgets the previous placement when a Retry is refused', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'failed' })
    const hosts = await hostsFile([THIS_COMPUTER])
    const service = new BuildReviewService(runtime, caller, undefined, {
      placement: { hostsFile: hosts, local: LOCAL, now: () => NOW }
    })
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Review the queue' })
    await settle(service, started.id)
    expect(service.show(started.id).stage).toBe('failed')
    expect(service.show(started.id).placement?.host?.name).toBe('mw0001')
    // Capacity is gone before the Retry: the fleet has no host now.
    await writeFile(hosts, JSON.stringify({ hosts: [] }))
    const startsBefore = calls.filter((call) => call.method === 'orchestration.workerStart').length
    await service.retry(started.id)
    await settle(service, started.id)
    const shown = service.show(started.id)
    expect(shown.stage).toBe('failed')
    expect(shown.error).toMatch(/^No fleet host has verified spare capacity/)
    expect(shown.placement).toBeUndefined()
    expect(calls.filter((call) => call.method === 'orchestration.workerStart').length).toBe(
      startsBefore
    )
  })

  it('refuses the default (fleet) run by name before any worker when no fleet host is registered', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const missing = join(tmpdir(), `no-hosts-${process.pid}-${Date.now()}.json`)
    const service = new BuildReviewService(runtime, caller, undefined, {
      placement: { hostsFile: missing, local: LOCAL, now: () => NOW }
    })
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Review the queue' })
    expect(started.runsOn).toBe('fleet')
    await settle(service, started.id)
    const shown = service.show(started.id)
    expect(shown.stage).toBe('failed')
    expect(shown.error).toMatch(/^No fleet host has verified spare capacity \(no fleet hosts in /)
    expect(shown.error).toMatch(/Choose 'this computer' to run here\.$/)
    expect(shown.placement).toBeUndefined()
    expect(shown.events.at(-1)?.text).toBe(shown.error)
    // Nothing was dispatched, not even the Run the coordinator would create.
    expect(calls.map((call) => call.method)).not.toContain('orchestration.workerStart')
    expect(calls.map((call) => call.method)).not.toContain('orchestration.runCreate')
  })

  it('refuses a verified remote host by name in this build, still before any worker', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller, undefined, {
      placement: {
        hostsFile: await hostsFile([REMOTE]),
        run: sshAnswering(done('16\n{ 1.60 2.00 2.10 }\n'), done('', 127)),
        local: LOCAL,
        now: () => NOW
      }
    })
    const started = service.start({
      worktree: 'id:repo::/wt',
      objective: 'Review the queue',
      runsOn: 'fleet'
    })
    await settle(service, started.id)
    const shown = service.show(started.id)
    expect(shown.stage).toBe('failed')
    expect(shown.error).toBe(
      "Build + Review workers edit this workspace's files, so they cannot run as dispatched seats on mw0002 in this build. Choose 'this computer' to run here."
    )
    expect(calls.map((call) => call.method)).not.toContain('orchestration.workerStart')
  })

  it('runs on the host a person named, recording the pick, and refuses a busy one by name', async () => {
    const { runtime } = createFakeRuntime()
    const { caller } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller, undefined, {
      placement: {
        hostsFile: await hostsFile([THIS_COMPUTER, REMOTE]),
        local: LOCAL,
        now: () => NOW
      }
    })
    const named = service.start({
      worktree: 'id:repo::/wt',
      objective: 'Build the page',
      runsOnHost: 'mw0001',
      runsOnHostId: 'local',
      requestedBy: 'Sal',
      request: 'build it on the fleet'
    })
    await settle(service, named.id)
    const shown = service.show(named.id)
    expect(shown.stage).toBe('completed')
    expect(shown.placement).toMatchObject({ mode: 'local', choice: 'named', hostId: 'local' })
    expect(shown).toMatchObject({ requestedBy: 'Sal', request: 'build it on the fleet' })
    const busy = new BuildReviewService(runtime, caller, undefined, {
      placement: {
        hostsFile: await hostsFile([THIS_COMPUTER]),
        local: { ...LOCAL, load1: 22 },
        now: () => NOW
      }
    })
    const refused = busy.start({
      worktree: 'id:repo::/wt2',
      objective: 'Build',
      runsOnHost: 'mw0001'
    })
    await settle(busy, refused.id)
    expect(busy.show(refused.id).error).toBe(
      'mw0001 is too busy for this run (0.92 load per core, over 0.8). Choose another host, or force it with a reason.'
    )
  })

  it('runs here when the fleet choice is this computer, recording the reading it was chosen on', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const service = new BuildReviewService(runtime, caller, undefined, {
      placement: { hostsFile: await hostsFile([THIS_COMPUTER]), local: LOCAL, now: () => NOW }
    })
    const started = service.start({ worktree: 'id:repo::/wt', objective: 'Review the queue' })
    await settle(service, started.id)
    const shown = service.show(started.id)
    expect(shown.stage).toBe('completed')
    expect(shown.placement).toEqual({
      runsOn: 'fleet',
      mode: 'local',
      host: { name: 'mw0001', machine: 'macserver-0-01', cores: 24, loadPerCore: 0.25, readAt: NOW }
    })
    expect(shown.events.map((event) => event.text)).toContain(
      'Workers run on this computer, the fleet host with the most verified spare capacity (mw0001: 0.25 load per core, 24 cores)'
    )
    expect(calls.map((call) => call.method)).toContain('orchestration.workerStart')
  })

  it('runs here without a reading when this computer was chosen explicitly', async () => {
    const { runtime } = createFakeRuntime()
    const { caller, calls } = createScriptedCaller({ builderOutcome: 'succeeded' })
    const missing = join(tmpdir(), `no-hosts-${process.pid}-${Date.now()}-local.json`)
    const service = new BuildReviewService(runtime, caller, undefined, {
      placement: { hostsFile: missing, local: LOCAL, now: () => NOW }
    })
    const started = service.start({
      worktree: 'id:repo::/wt',
      objective: 'Review the queue',
      runsOn: 'local'
    })
    expect(started.runsOn).toBe('local')
    await settle(service, started.id)
    const shown = service.show(started.id)
    expect(shown.stage).toBe('completed')
    expect(shown.placement).toEqual({ runsOn: 'local', mode: 'local' })
    expect(shown.events.map((event) => event.text)).toContain(
      'Workers run on this computer (chosen explicitly)'
    )
    expect(calls.map((call) => call.method)).toContain('orchestration.workerStart')
  })
})
