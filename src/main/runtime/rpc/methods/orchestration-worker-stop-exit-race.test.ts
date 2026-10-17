import { afterEach, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../omni-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ORCHESTRATION_METHODS } from './orchestration'

const TAB = '11111111-1111-4111-8111-111111111111'
const LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = `${TAB}:${LEAF}`
const PTY = 'pty-stop-exit-race'
const HANDLE = 'term_stop_exit_race'
const WORKTREE = 'repo-audit::/tmp/stop-exit-race'
const databases: OrchestrationDb[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function createWorker() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const runtime = new OrcaRuntimeService(null)
  runtime.setOrchestrationDb(db)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.registerPty(PTY, WORKTREE, null, {
    tabId: TAB,
    leafId: LEAF,
    incarnationId: 'stop-exit-race-incarnation'
  })
  runtime.registerPreAllocatedHandleForPty(PTY, HANDLE)
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [{ tabId: TAB, worktreeId: WORKTREE, title: 'Audit', activeLeafId: LEAF, layout: null }],
    leaves: [{ tabId: TAB, worktreeId: WORKTREE, leafId: LEAF, paneRuntimeId: 1, ptyId: PTY }]
  })
  const run = db.createRun({
    objective: 'Owned stop receipt',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: '99999999-9999-4999-8999-999999999999:88888888-8888-4888-8888-888888888888'
  })
  const task = db.createTask({ spec: 'Stop the exact owned worker', runId: run.id })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {},
    runtimeEpoch: runtime.getRuntimeId()
  })
  const capability = db.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: HANDLE,
    paneKey: PANE,
    processIncarnation: runtime.getTerminalProcessIncarnation(HANDLE)!,
    worktreeId: WORKTREE,
    setupState: 'not_applicable',
    effects: [{ kind: 'terminal', action: 'created', id: HANDLE }],
    terminalOwnership: 'created'
  })
  db.markWorkerDispatchReady(started.dispatch.id)
  return { db, runtime, task, dispatch: started.dispatch, capability }
}

async function stopWorker(runtime: OrcaRuntimeService, dispatchId: string) {
  const method = ORCHESTRATION_METHODS.find(
    (candidate) => candidate.name === 'orchestration.workerStop'
  )!
  return method.handler(method.params!.parse({ dispatch: dispatchId }), { runtime })
}

it('returns a confirmed stop when the owned process exit arrives before close returns', async () => {
  const { db, runtime, task, dispatch, capability } = createWorker()
  const incarnation = runtime.getTerminalProcessIncarnation(HANDLE)!
  const notify = vi.spyOn(runtime, 'notifyMessageArrived')
  const exit = runtime.waitForTerminal(HANDLE, { condition: 'exit', timeoutMs: 1000 })
  const close = vi.spyOn(runtime, 'closeTerminal').mockImplementation(async (handle) => {
    runtime.markPtyStopRequested(PTY)
    runtime.onPtyExit(PTY, 0, 'stop-exit-race-incarnation', {
      providerExitObserved: true,
      cause: { kind: 'operator_close' }
    })
    return { handle, tabId: TAB, ptyKilled: true }
  })

  await expect(stopWorker(runtime, dispatch.id)).resolves.toMatchObject({
    dispatchId: dispatch.id,
    state: 'stopped',
    processAction: 'closed_agent_terminal'
  })
  expect(close).toHaveBeenCalledExactlyOnceWith(HANDLE)
  expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
    state: 'stopped',
    stage: 'process_stopped'
  })
  expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
    status: 'failed',
    last_failure: 'stopped',
    failure_count: 0
  })
  expect(db.getTask(task.id)?.status).toBe('blocked')
  expect(
    db.verifyDispatchCapability({
      dispatchId: dispatch.id,
      capability,
      paneKey: PANE,
      processIncarnation: incarnation
    }).valid
  ).toBe(false)
  expect(notify).not.toHaveBeenCalledWith(expect.anything(), 'escalation')
  expect(db.getUnreadMessages(`run:${dispatch.run_id}`, ['escalation'])).toHaveLength(0)
  await expect(exit).resolves.toMatchObject({
    satisfied: true,
    exitCause: { kind: 'operator_close' }
  })
})

it('preserves a committed stop if publishing its observation fails', async () => {
  const { db, runtime, dispatch } = createWorker()
  vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
    handle: HANDLE,
    tabId: TAB,
    ptyKilled: true
  })
  vi.spyOn(runtime, 'recordOrchestrationExecutionObservation').mockImplementation(() => {
    throw new Error('Observation publication unavailable')
  })

  await expect(stopWorker(runtime, dispatch.id)).resolves.toMatchObject({
    dispatchId: dispatch.id,
    state: 'stopped'
  })
  expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('stopped')
})

it('reports the original close uncertainty without claiming a stopped process', async () => {
  const { db, runtime, dispatch } = createWorker()
  vi.spyOn(runtime, 'closeTerminal').mockRejectedValue(new Error('Owning host stop reply lost'))

  await expect(stopWorker(runtime, dispatch.id)).resolves.toMatchObject({
    state: 'stop_unknown',
    processAction: 'unknown',
    lastError: 'Owning host stop reply lost'
  })
  expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('stop_unknown')
  expect(runtime.getTerminalLivenessVerdict(HANDLE)?.status).not.toBe('exited')
})

it('preserves the original close error if recording uncertainty also fails', async () => {
  const { db, runtime, dispatch } = createWorker()
  const original = new Error('Owning host stop reply lost')
  vi.spyOn(runtime, 'closeTerminal').mockRejectedValue(original)
  vi.spyOn(db, 'markWorkerStopUnknown').mockImplementation(() => {
    throw new Error('Could not record uncertainty')
  })

  await expect(stopWorker(runtime, dispatch.id)).rejects.toBe(original)
  expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('stopping')
})

it('returns the failed winner if the process exits while stop inspects its terminal', async () => {
  const { db, runtime, dispatch } = createWorker()
  const beforeExit = await runtime.showTerminal(HANDLE)
  vi.spyOn(runtime, 'showTerminal').mockImplementationOnce(async () => {
    runtime.onPtyExit(PTY, 17, 'stop-exit-race-incarnation', {
      providerExitObserved: true,
      cause: { kind: 'exited', exitCode: 17 }
    })
    return beforeExit
  })
  const close = vi.spyOn(runtime, 'closeTerminal')

  await expect(stopWorker(runtime, dispatch.id)).resolves.toMatchObject({
    state: 'failed',
    alreadySettled: true,
    processAction: 'none'
  })
  expect(close).not.toHaveBeenCalled()
  expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('failed')
  expect(db.getUnreadMessages(`run:${dispatch.run_id}`, ['escalation'])).toHaveLength(1)
})
