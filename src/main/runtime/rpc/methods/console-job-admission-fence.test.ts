import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'
import { assertUnboundLocalWorkerStart } from './orchestration-worker-start-validation'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../omni-runtime'
import { createHubTaskProjection } from '../../orchestration/db/tasks/task-store'
import {
  consoleJobClaimFixture,
  consoleJobDigestFixture,
  consoleJobPrincipalFixture
} from '../../orchestration/console-job-test-fixture'
import { consoleJobActivationReceipt } from '../../orchestration/console-job-activation-receipt'
import type { ConsoleJobBinding } from '../../../../shared/console-workflow-types'

/**
 * Why this exists: the Class A review of the console execution lane found that
 * `orchestration.runCreate` accepted `consoleJob`/`consoleJobPrincipal` from any
 * caller and validated only their shape. A caller holding a hub card id could
 * fabricate a binding with `placement: 'local'` and any 64-hex principal, get
 * `origin = 'hub_dispatched'`, and pass the console carve-out in
 * `isConsoleAdmittedLocalStart` -- starting a local worker on a Hub-bound card
 * with none of the checks `workerPrepare`/`workerExecute` apply. These tests pin
 * the two halves of the fix: the public surface refuses the parameters, and the
 * carve-out reads the stored server activation receipt rather than any input.
 */
describe('console job admission is unreachable from the public run-create surface', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  const targetCard = 'btk_target'
  const forged: ConsoleJobBinding = {
    taskId: targetCard,
    workflowId: 'wf_forged',
    jobId: 'job_forged01',
    attempt: 1,
    leaseGeneration: 1,
    claim: {
      host: 'attacker-host',
      claimedAt: '2026-09-10T00:00:00.000000+00:00',
      runnerInstance: 'orca_worker_forged',
      claimRequestId: 'orca_dispatch_forged',
      attemptIntentId: 'att_intent_forged',
      dispatchKey: 'server:dispatch:forged'
    }
  }

  afterEach(() => {
    h.cleanup()
  })

  function setup(): void {
    ;({ db, runtime, ctx } = h.setup(false))
    void runtime
  }

  /** The migration seeds an adopted legacy Run; only rows this test created matter. */
  function createdRuns() {
    return db.listRuns().runs.filter((run) => run.id !== 'run_legacy_local')
  }

  function localAttempt(binding: ConsoleJobBinding): WorkerStartInput['consoleExecution'] {
    return {
      job: {
        id: binding.jobId,
        taskId: binding.taskId,
        workflowId: binding.workflowId,
        placement: 'local',
        provider: 'codex',
        model: 'gpt-6'
      },
      attemptStartSha: 'f'.repeat(40),
      worktreeId: 'wt_forged',
      worktreePath: '/tmp/wt_forged',
      branch: 'omni/forged'
    } as unknown as WorkerStartInput['consoleExecution']
  }

  it('refuses a fabricated console job binding on orchestration.runCreate', async () => {
    setup()
    await expect(
      h.call(
        'orchestration.runCreate',
        {
          from: 'term_coord',
          objective: 'bypass',
          hubTaskId: targetCard,
          consoleJob: forged,
          consoleJobPrincipal: 'a'.repeat(64)
        },
        ctx
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(createdRuns()).toHaveLength(0)
  })

  it('refuses a publication principal even without a binding, and a binding without one', async () => {
    setup()
    for (const params of [
      { consoleJobPrincipal: 'a'.repeat(64) },
      { consoleJob: forged },
      { consoleJob: null },
      { consoleJobPrincipal: '' }
    ]) {
      await expect(
        h.call(
          'orchestration.runCreate',
          { from: 'term_coord', objective: 'bypass', hubTaskId: targetCard, ...params },
          ctx
        )
      ).rejects.toMatchObject({ code: 'invalid_argument' })
    }
    expect(createdRuns()).toHaveLength(0)
  })

  it('leaves every publicly created card-bound run locally started, never Hub-dispatched', async () => {
    setup()
    await h.call(
      'orchestration.runCreate',
      { from: 'term_coord', objective: 'ordinary card work', hubTaskId: targetCard },
      ctx
    )
    const runs = createdRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0].origin).toBe('local_bound')
    for (const run of runs) {
      expect(run.console_job ?? null).toBeNull()
      expect(run.console_job_principal ?? null).toBeNull()
      expect(run.console_job_activation ?? null).toBeNull()
      expect(run.origin).not.toBe('hub_dispatched')
    }
  })

  it('refuses the console carve-out for an admission with no stored server activation receipt', () => {
    setup()
    // A Run whose binding was installed without the BFF activation response --
    // exactly what a forged admission would look like if one ever reached the DB.
    const run = db.createRun({
      objective: 'Console job',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: h.coordinatorPaneKey,
      hubTaskId: consoleJobClaimFixture.taskId,
      consoleJob: consoleJobClaimFixture,
      consoleJobPrincipal: consoleJobPrincipalFixture
    })
    expect(run.origin).toBe('hub_dispatched')
    const task = createHubTaskProjection(db, {
      runId: run.id,
      hubTaskId: consoleJobClaimFixture.taskId
    })
    expect(() =>
      assertUnboundLocalWorkerStart(db, task.id, {
        runId: run.id,
        attempt: localAttempt(consoleJobClaimFixture)
      })
    ).toThrow(/requires Hub admission/)
  })

  it('admits the launch path that stored the server activation receipt', () => {
    setup()
    const run = db.createRun({
      objective: 'Console job',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: h.coordinatorPaneKey,
      hubTaskId: consoleJobClaimFixture.taskId,
      consoleJob: consoleJobClaimFixture,
      consoleJobPrincipal: consoleJobPrincipalFixture,
      consoleJobActivation: consoleJobActivationReceipt(
        consoleJobClaimFixture,
        consoleJobDigestFixture
      )
    })
    expect(run.origin).toBe('hub_dispatched')
    const task = createHubTaskProjection(db, {
      runId: run.id,
      hubTaskId: consoleJobClaimFixture.taskId
    })
    expect(() =>
      assertUnboundLocalWorkerStart(db, task.id, {
        runId: run.id,
        attempt: localAttempt(consoleJobClaimFixture)
      })
    ).not.toThrow()
  })

  it('keeps the activation receipt insert-only and tied to its own admitted job', () => {
    setup()
    const run = db.createRun({
      objective: 'Console job',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: h.coordinatorPaneKey,
      hubTaskId: consoleJobClaimFixture.taskId,
      consoleJob: consoleJobClaimFixture,
      consoleJobPrincipal: consoleJobPrincipalFixture,
      consoleJobActivation: consoleJobActivationReceipt(
        consoleJobClaimFixture,
        consoleJobDigestFixture
      )
    })
    expect(() =>
      db.db
        .prepare('UPDATE runs SET console_job_activation = ? WHERE id = ?')
        .run(
          JSON.stringify({
            jobId: consoleJobClaimFixture.jobId,
            activationId: 'att_intent_swapped',
            jobDigest: consoleJobDigestFixture
          }),
          run.id
        )
    ).toThrow(/committed at run creation/)
    expect(() =>
      db.createRun({
        objective: 'Mismatched receipt',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: h.coordinatorPaneKey,
        hubTaskId: consoleJobClaimFixture.taskId,
        consoleJob: consoleJobClaimFixture,
        consoleJobPrincipal: consoleJobPrincipalFixture,
        consoleJobActivation: {
          jobId: 'job_other',
          activationId: 'att_intent_1',
          jobDigest: consoleJobDigestFixture
        }
      })
    ).toThrow(/its own admitted job/)
  })
})
