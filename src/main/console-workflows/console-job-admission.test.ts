import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { OrcaRuntimeService } from '../runtime/omni-runtime'
import { consoleJobClaimFixture } from '../runtime/orchestration/console-job-test-fixture'
import { admitConsoleJobRun } from './console-job-admission'
import type { ConsoleLocalActivation, ConsoleLocalJob } from './console-local-execution-contract'

/**
 * Why this exists: the console job binding was previously stored with whatever
 * `consoleJobPrincipal` the caller sent -- any 64-hex string passed, and it was
 * never compared to the signed-in person. The principal is publication
 * provenance for work the Hub will attribute to a real person, so it is
 * re-read from the live session at the moment the binding is installed.
 */
describe('installing a console job binding on a Run', () => {
  const principal = 'a'.repeat(64)
  const paneKey = 'tab_console:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  const job = {
    id: consoleJobClaimFixture.jobId,
    taskId: consoleJobClaimFixture.taskId,
    workflowId: consoleJobClaimFixture.workflowId,
    digest: 'b'.repeat(64),
    state: 'ready',
    placement: 'local',
    provider: 'codex',
    model: 'gpt-6',
    title: 'Admitted job',
    repo: 'gitlab.example/team/project',
    baseBranch: 'main',
    prompt: 'p',
    brief: 'b',
    acceptance: 'a',
    acceptanceCommands: [],
    inputs: [],
    ownedPaths: null,
    readOnly: false
  } satisfies ConsoleLocalJob

  const activation: ConsoleLocalActivation = {
    job,
    binding: consoleJobClaimFixture,
    principal
  }

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_console' ? paneKey : null
    )
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime_test:console:1')
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  /** The migration seeds an adopted legacy Run; only rows this test created matter. */
  function createdRuns() {
    return db.listRuns().runs.filter((run) => run.id !== 'run_legacy_local')
  }

  function admit(livePrincipal: () => Promise<string | null>) {
    return admitConsoleJobRun({
      runtime,
      activation,
      coordinatorHandle: 'term_console',
      objective: job.title,
      livePrincipal
    })
  }

  it('admits the activation the signed-in person actually holds', async () => {
    const admitted = await admit(async () => principal)
    expect(admitted.run.origin).toBe('hub_dispatched')
    expect(admitted.projectionTaskId).toBeTruthy()
    expect(JSON.parse(admitted.run.console_job!)).toMatchObject({
      jobId: consoleJobClaimFixture.jobId,
      taskId: consoleJobClaimFixture.taskId
    })
    expect(admitted.run.console_job_principal).toBe(principal)
    expect(JSON.parse(admitted.run.console_job_activation!)).toEqual({
      jobId: consoleJobClaimFixture.jobId,
      activationId: consoleJobClaimFixture.claim!.attemptIntentId,
      jobDigest: job.digest
    })
  })

  it('refuses a principal that is not the live signed-in person, storing no run', async () => {
    for (const live of [async () => 'c'.repeat(64), async () => null]) {
      await expect(admit(live)).rejects.toThrow(/signed-in person/)
    }
    expect(createdRuns()).toHaveLength(0)
  })

  it('refuses an activation whose binding describes a different job or card', async () => {
    for (const binding of [
      { ...consoleJobClaimFixture, jobId: 'job_other' },
      { ...consoleJobClaimFixture, taskId: 'btk_other' }
    ]) {
      await expect(
        admitConsoleJobRun({
          runtime,
          activation: { ...activation, binding },
          coordinatorHandle: 'term_console',
          objective: job.title,
          livePrincipal: async () => principal
        })
      ).rejects.toThrow(/does not describe the activated job/)
    }
    expect(createdRuns()).toHaveLength(0)
  })
})
