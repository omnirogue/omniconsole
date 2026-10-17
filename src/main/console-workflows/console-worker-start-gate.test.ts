import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { bindConsoleJobDispatch } from '../runtime/orchestration/console-job-binding'
import { readConsoleJobProcessHandshake } from '../runtime/orchestration/console-job-process-handshake'
import type { PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import { createHubTaskProjection } from '../runtime/orchestration/db/tasks/task-store'
import {
  consoleJobClaimFixture,
  consoleJobDigestFixture,
  consoleJobPrincipalFixture,
  createConsoleJobRun
} from '../runtime/orchestration/console-job-test-fixture'
import {
  hasConsoleLaunchAuthority,
  revalidateConsoleLaunchAuthority
} from '../pty/console-launch-authority'
import type { ConsoleLocalExecutionPort, ConsoleLocalJob } from './console-local-execution-contract'
import {
  prepareConsoleWorkerLaunchGate,
  registerConsoleWorkerStartPort,
  startConsoleWorkerProcess
} from './console-worker-start-gate'

describe('Console activation grants a native process gate', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let dispose: () => void
  let runId: string
  let dispatchId: string
  let principal: string | null
  const startProcess = vi.fn()
  const readPrincipal = vi.fn(async () => principal)
  const binding = {
    ...consoleJobClaimFixture,
    taskId: 'btk_gatefixture',
    workflowId: 'wf_gatefixture',
    jobId: 'job_gate1234'
  }
  const job: ConsoleLocalJob = {
    id: binding.jobId,
    taskId: binding.taskId,
    workflowId: binding.workflowId,
    digest: consoleJobDigestFixture,
    state: 'ready',
    placement: 'local',
    provider: 'codex',
    model: 'gpt-6',
    title: 'Admitted task',
    repo: 'example/project',
    baseBranch: 'main',
    prompt: 'Execute the approved task.',
    brief: 'Preserve the task binding.',
    acceptance: 'Native process receipt.',
    acceptanceCommands: [],
    inputs: [],
    ownedPaths: [],
    readOnly: true
  }
  const attempt = {
    job,
    worktreeId: 'worktree-console',
    worktreePath: '/tmp/worktree-console',
    attemptStartSha: 'b'.repeat(40),
    branch: 'omni/job'
  }
  const env = { OMNI_TASK_ID: job.taskId }
  const gateReceipt = (launchId: string): PtyLaunchGateReceipt => ({
    version: 1,
    state: 'closed',
    launchId,
    gateId: randomUUID(),
    ptyId: 'pty-fixture',
    incarnationId: randomUUID(),
    pid: 42,
    processStartTimeMs: 1_780_000_000_000,
    processKind: 'pty-shell',
    ptyRootPid: 41,
    ptyRootProcessStartTimeMs: 1_780_000_000_000,
    exitObserver: 'macos-kqueue',
    reportsChildExitStatus: true,
    startupCommandMode: 'exec'
  })

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = {
      getOrchestrationDb: () => db,
      releaseTerminalLaunchGate: vi.fn()
    } as unknown as OrcaRuntimeService
    principal = consoleJobPrincipalFixture
    readPrincipal.mockReset().mockImplementation(async () => principal)
    const run = createConsoleJobRun(db, binding)
    runId = run.id
    const task = createHubTaskProjection(db, { runId, hubTaskId: job.taskId })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: { consoleExecution: attempt },
      creator: { kind: 'system' },
      maxDepth: 10
    })
    dispatchId = started.dispatch.id
    bindConsoleJobDispatch(db, {
      runId,
      dispatchId,
      principal: consoleJobPrincipalFixture,
      binding
    })
    db.recordWorkerStage({ dispatchId, stage: 'terminal_creating', worktreeId: attempt.worktreeId })
    dispose = registerConsoleWorkerStartPort(runtime, {
      captureLaunchAuthority: async () => ({
        principal: consoleJobPrincipalFixture,
        isCurrent: () => principal === consoleJobPrincipalFixture
      }),
      principal: readPrincipal,
      startProcess,
      sanitize: (value: string) => value
    } as unknown as ConsoleLocalExecutionPort)
    startProcess.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    dispose()
    db.close()
  })

  it('issues one private gate for the persisted claim and refuses concurrent preparation', async () => {
    const results = await Promise.allSettled([
      prepareConsoleWorkerLaunchGate(runtime, dispatchId),
      prepareConsoleWorkerLaunchGate(runtime, dispatchId)
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const gate = results.find((result) => result.status === 'fulfilled')!.value
    expect(hasConsoleLaunchAuthority(gate)).toBe(true)
    await expect(
      revalidateConsoleLaunchAuthority(gate, attempt.worktreeId, attempt.worktreePath, env)
    ).resolves.toBeUndefined()
    expect(startProcess).not.toHaveBeenCalled()
  })

  it.each([
    { change: 'missing', message: 'persisted console activation claim' },
    { change: 'other-intent', message: 'persisted console activation claim' },
    { change: 'other-digest', message: 'unchanged, unstarted activation and workspace' },
    { change: 'local-bound', message: 'persisted console activation claim' }
  ])(
    'refuses $change activation evidence before creating authority',
    async ({ change, message }) => {
      const readRun = db.getRun.bind(db)
      const storedRun = readRun(runId)!
      const activation = JSON.parse(storedRun.console_job_activation!)
      if (change === 'other-intent') {
        activation.activationId = 'another-intent'
      }
      if (change === 'other-digest') {
        activation.jobDigest = 'e'.repeat(64)
      }
      // Exercise a corrupt read without bypassing the database's immutable evidence triggers.
      vi.spyOn(db, 'getRun').mockImplementation((id) =>
        id === runId
          ? {
              ...storedRun,
              console_job_activation: change === 'missing' ? null : JSON.stringify(activation),
              origin: change === 'local-bound' ? 'local_bound' : storedRun.origin
            }
          : readRun(id)
      )
      await expect(prepareConsoleWorkerLaunchGate(runtime, dispatchId)).rejects.toThrow(message)
      expect(startProcess).not.toHaveBeenCalled()
    }
  )

  it('rechecks principal and persisted attempt immediately before native spawn', async () => {
    const gate = await prepareConsoleWorkerLaunchGate(runtime, dispatchId)
    principal = null
    await expect(
      revalidateConsoleLaunchAuthority(gate, attempt.worktreeId, attempt.worktreePath, env)
    ).rejects.toThrow('signed-in person changed')
    principal = consoleJobPrincipalFixture
    const readWorker = db.getWorkerDispatch.bind(db)
    const storedWorker = readWorker(dispatchId)!
    vi.spyOn(db, 'getWorkerDispatch').mockImplementation((id) =>
      id === dispatchId
        ? {
            ...storedWorker,
            start_options: JSON.stringify({
              consoleExecution: { ...attempt, job: { ...job, model: 'other-model' } }
            })
          }
        : readWorker(id)
    )
    await expect(
      revalidateConsoleLaunchAuthority(gate, attempt.worktreeId, attempt.worktreePath, env)
    ).rejects.toThrow('activation changed')
  })

  it('refuses a syntactic receipt that names another launch before server start', async () => {
    await prepareConsoleWorkerLaunchGate(runtime, dispatchId)
    await expect(
      startConsoleWorkerProcess({
        runtime,
        dispatchId,
        terminalHandle: 'term-spoof',
        attempt,
        gate: gateReceipt(randomUUID())
      })
    ).rejects.toThrow('closed process gate receipt')
    expect(startProcess).not.toHaveBeenCalled()
  })

  it('retains the server start acknowledgement but refuses release when the original person lease changes', async () => {
    const gate = await prepareConsoleWorkerLaunchGate(runtime, dispatchId)
    startProcess.mockImplementation(async (input) => {
      // This lookup returns the old principal, then account mutation wins the await boundary.
      readPrincipal.mockImplementationOnce(async () => {
        const current = principal
        queueMicrotask(() => {
          principal = null
        })
        return current
      })
      return {
        ok: true,
        data: {
          ...input.binding,
          sessionId: 'ses_server',
          attemptId: 'attempt_server',
          inputDigest: input.inputDigest
        }
      }
    })

    await expect(
      startConsoleWorkerProcess({
        runtime,
        dispatchId,
        terminalHandle: 'term-fixture',
        attempt,
        gate: gateReceipt(gate.launchId)
      })
    ).rejects.toThrow('signed-in person changed')

    expect(startProcess).toHaveBeenCalledOnce()
    expect(runtime.releaseTerminalLaunchGate).not.toHaveBeenCalled()
    expect(JSON.parse(db.getRun(runId)!.console_job_start_receipt!)).toMatchObject({
      sessionId: 'ses_server',
      attemptId: 'attempt_server'
    })
    const handshake = readConsoleJobProcessHandshake(db, {
      runId,
      dispatchId,
      principal: consoleJobPrincipalFixture,
      binding
    })!
    expect(handshake.startAcknowledged).toBeDefined()
    expect(handshake.releaseIntent).toBeUndefined()
    expect(handshake.released).toBeUndefined()
  })
})
