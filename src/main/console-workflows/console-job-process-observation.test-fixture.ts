import { vi } from 'vitest'
import type { PtyLaunchGateObservation, PtyLaunchGateReceipt } from '../../shared/pty-launch-gate'
import { OrcaRuntimeService } from '../runtime/omni-runtime'
import { createOrchestrationCaller } from '../runtime/build-review/build-review-rpc-call'
import { bindConsoleJobDispatch } from '../runtime/orchestration/console-job-binding'
import {
  readConsoleJobProcessHandshake,
  recordConsoleJobProcessHandshake,
  type ConsoleJobProcessIdentity
} from '../runtime/orchestration/console-job-process-handshake'
import { recordReleasedConsoleJobProcess } from '../runtime/orchestration/console-job-process-test-fixture'
import {
  consoleJobClaimFixture,
  consoleJobPrincipalFixture,
  createConsoleJobRun
} from '../runtime/orchestration/console-job-test-fixture'
import { OrchestrationDb } from '../runtime/orchestration/db'
import { createHubTaskProjection } from '../runtime/orchestration/db/tasks/task-store'
import type {
  ConsoleLocalExecutionPort,
  ConsoleLocalJob,
  ConsoleLocalResult
} from './console-local-execution-contract'
import type { ConsoleLocalAttempt } from './console-local-execution-schema'
import {
  listConsoleLocalExecutions,
  type ConsoleLocalExecutionRecord
} from './console-local-execution-state'
import { ConsoleJobResultGate } from './console-job-result-gate'
import type { ConsoleResultJournal, ConsoleJobMonitorContext } from './console-job-monitor'

type ConsoleProcessObservationFixture = {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  identity: ConsoleJobProcessIdentity
  gate: PtyLaunchGateReceipt
  state: { observation: PtyLaunchGateObservation }
  exit: (code?: number | null, signal?: number | null) => void
  ctx: ConsoleJobMonitorContext
  record: () => ConsoleLocalExecutionRecord
  settle: (outcome?: 'succeeded' | 'failed') => ReturnType<OrchestrationDb['settleWorkerReport']>
  fields: Pick<
    PtyLaunchGateObservation,
    'gateId' | 'ptyId' | 'incarnationId' | 'pid' | 'processStartTimeMs' | 'startAcknowledgement'
  >
}

export function createConsoleProcessObservationFixture(
  path = ':memory:',
  released = true
): ConsoleProcessObservationFixture {
  const db = new OrchestrationDb(path)
  const runtime = new OrcaRuntimeService(null)
  runtime.setOrchestrationDb(db)
  const binding = { ...consoleJobClaimFixture, jobId: 'job_physical', workflowId: 'wf_physical' }
  const principal = consoleJobPrincipalFixture
  const run = createConsoleJobRun(db, binding)
  const task = createHubTaskProjection(db, { runId: run.id, hubTaskId: binding.taskId })
  const job: ConsoleLocalJob = {
    id: binding.jobId,
    taskId: binding.taskId,
    workflowId: binding.workflowId,
    digest: 'b'.repeat(64),
    state: 'running',
    placement: 'local',
    provider: 'claude',
    model: 'sonnet',
    title: 'Physical observation',
    repo: 'gitlab.example/team/project',
    baseBranch: 'main',
    prompt: 'Stored prompt',
    brief: 'Stored brief',
    acceptance: 'Pass acceptance',
    acceptanceCommands: [],
    inputs: [],
    ownedPaths: null,
    readOnly: true
  }
  const attempt: ConsoleLocalAttempt = {
    job,
    attemptStartSha: 'c'.repeat(40),
    worktreeId: 'folder-workspace',
    worktreePath: '/fixture',
    branch: 'main'
  }
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 1,
    taskId: task.id,
    startOptions: { agent: 'claude', consoleExecution: attempt },
    runtimeEpoch: runtime.getRuntimeId()
  })
  const identity = { runId: run.id, dispatchId: started.dispatch.id, principal, binding }
  bindConsoleJobDispatch(db, identity)
  const gate: PtyLaunchGateReceipt = {
    version: 1,
    state: 'closed',
    launchId: 'launch-process',
    gateId: 'gate-process',
    ptyId: 'pty-process',
    incarnationId: 'inc-process',
    pid: 42,
    processStartTimeMs: 1_780_000_000_000,
    processKind: 'pty-shell',
    ptyRootPid: 41,
    ptyRootProcessStartTimeMs: 1_779_999_999_000,
    reportsChildExitStatus: true,
    startupCommandMode: 'exec',
    exitObserver: 'macos-kqueue'
  }
  if (released) {
    recordReleasedConsoleJobProcess(db, identity, gate)
  } else {
    recordConsoleJobProcessHandshake(db, identity, { phase: 'prepared', gate })
  }
  const hostScope = { kind: 'local', hostId: 'local' } as const
  const handle = 'term_process'
  const paneKey = 'tab_process:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const processIncarnation = `${gate.ptyId}:${gate.incarnationId}`
  db.prepareStartingWorkerAuthority({
    dispatchId: identity.dispatchId,
    handle,
    paneKey,
    processIncarnation,
    worktreeId: attempt.worktreeId,
    effects: [],
    setupState: 'not_applicable',
    hostScope: JSON.stringify(hostScope),
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(identity.dispatchId)
  const fields = {
    gateId: gate.gateId,
    ptyId: gate.ptyId,
    incarnationId: gate.incarnationId,
    pid: gate.pid,
    processStartTimeMs: gate.processStartTimeMs,
    startAcknowledgement: readConsoleJobProcessHandshake(db, identity)?.startAcknowledgement ?? null
  }
  const state: { observation: PtyLaunchGateObservation } = {
    observation: { ...fields, state: 'live', source: 'macos-kqueue' }
  }
  const exit = (code: number | null = 0, signal: number | null = null) => {
    state.observation = {
      ...fields,
      state: 'exited',
      source: 'macos-kqueue',
      exitCode: code,
      signal,
      waitStatus: signal ?? code! * 256,
      observedAtMs: gate.processStartTimeMs + 1000
    }
  }
  vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(paneKey)
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(processIncarnation)
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation(() =>
    state.observation.state === 'exited'
      ? null
      : ({
          terminalHandle: handle,
          paneKey,
          processIncarnation,
          hostScope
        } as never)
  )
  vi.spyOn(runtime, 'readTerminalLaunchGateObservation').mockImplementation(
    async () => state.observation
  )
  vi.spyOn(runtime, 'showTerminal').mockImplementation(
    async () =>
      ({
        handle,
        worktreeId: attempt.worktreeId,
        connected: state.observation.state !== 'exited',
        status: state.observation.state === 'exited' ? 'exited' : 'running'
      }) as never
  )
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: attempt.worktreeId,
    hostId: 'local',
    git: { path: attempt.worktreePath }
  } as never)
  vi.spyOn(runtime, 'sendTerminal').mockImplementation(async (_handle, _action, options) => {
    await options?.beforeWrite?.(gate.ptyId)
    options?.reserveWrite?.(gate.ptyId)
    return { handle, accepted: true, bytesWritten: 6 }
  })
  vi.spyOn(runtime, 'waitForTerminal').mockImplementation(async (_handle, options) => {
    if (options?.condition === 'exit') {
      exit(37)
    }
    return {
      handle,
      condition: options?.condition ?? 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }
  })
  vi.spyOn(runtime, 'closeTerminal').mockImplementation(async () => {
    exit(null, 15)
    return { handle, tabId: 'tab_process', ptyKilled: true }
  })
  vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
  vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
    handle,
    status: 'exited',
    tail: ['worker output'],
    truncated: false,
    nextCursor: '1'
  })
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  const port: ConsoleLocalExecutionPort = {
    principal: vi.fn(async () => principal),
    sanitize: (text) => text,
    getReadyJob: vi.fn(),
    activate: vi.fn(),
    result: vi.fn(),
    cancelled: vi.fn(),
    inspect: vi.fn(async () => ({ ok: true as const, data: { cancelled: false } }))
  }
  const results = new Map<string, ConsoleLocalResult>()
  const journal: ConsoleResultJournal = {
    read: (dispatch) => results.get(dispatch) ?? null,
    record: vi.fn((record, result) => {
      results.set(record.worker.dispatch_id, result)
    }),
    flush: vi.fn(async () => {})
  }
  const ctx = {
    runtime,
    call: createOrchestrationCaller(runtime),
    port,
    results: journal,
    resultGate: new ConsoleJobResultGate(),
    cancel: vi.fn()
  }
  const record = () => listConsoleLocalExecutions(db, principal)[0]
  const settle = (outcome: 'succeeded' | 'failed' = 'succeeded') =>
    db.settleWorkerReport({
      taskId: task.id,
      dispatchId: identity.dispatchId,
      outcome,
      result: `worker ${outcome}`
    })
  return { db, runtime, identity, gate, state, exit, ctx, record, settle, fields }
}
