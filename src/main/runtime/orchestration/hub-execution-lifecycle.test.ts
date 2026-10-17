import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../omni-runtime'
import { OrchestrationDb } from './db/orchestration-db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { createHubTaskProjection } from './db/tasks/task-store'
import { ORCHESTRATION_METHODS } from '../rpc/methods/orchestration'

const TAB = '11111111-1111-4111-8111-111111111111'
const PANE = '22222222-2222-4222-8222-222222222222'
const HANDLE = 'term_worker'
const PTY = 'pty_observation'
const INCARNATION = 'observation-incarnation'
const WORKSPACE = 'repo::/tmp/observation'

describe('committed runtime lifecycle progress projection', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  const reporter = vi.fn(async () => ({ ok: true as const, noteId: 'note_committed' }))

  beforeEach(() => {
    reporter.mockClear()
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    runtime.setOrchestrationObservationReporter(reporter)
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  async function call(name: string, params: Record<string, unknown>) {
    const method = ORCHESTRATION_METHODS.find((candidate) => candidate.name === name)!
    return method.handler(method.params!.parse(params), { runtime })
  }

  function createRun() {
    return db.createRun({
      objective: 'Reply to customer',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      hubTaskId: 'btk_content'
    })
  }

  function registerProcess() {
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty(PTY, WORKSPACE, null, {
      tabId: TAB,
      leafId: PANE,
      incarnationId: INCARNATION
    })
    runtime.registerPreAllocatedHandleForPty(PTY, HANDLE)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        { tabId: TAB, worktreeId: WORKSPACE, title: 'Agent', activeLeafId: PANE, layout: null }
      ],
      leaves: [{ tabId: TAB, worktreeId: WORKSPACE, leafId: PANE, paneRuntimeId: 1, ptyId: PTY }]
    })
  }

  function createSupervisedWorker() {
    const run = createRun()
    const task = createHubTaskProjection(db, {
      runId: run.id,
      hubTaskId: 'btk_content',
      title: 'Draft reply'
    })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 1,
      taskId: task.id,
      startOptions: {},
      runtimeEpoch: runtime.getRuntimeId()
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: HANDLE,
      paneKey: `${TAB}:${PANE}`,
      processIncarnation: `${PTY}:${INCARNATION}`,
      worktreeId: WORKSPACE,
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: HANDLE }],
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { run, dispatch: started.dispatch }
  }

  it('records run_started only after a bound run is durably created', async () => {
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(`${TAB}:${PANE}`)
    const created = (await call('orchestration.runCreate', {
      objective: 'Content',
      from: 'term_coord',
      hubTaskId: 'btk_content'
    })) as { run: { id: string } }
    expect(db.getRun(created.run.id)?.hub_task_id).toBe('btk_content')
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({
        hubTaskId: 'btk_content',
        runId: created.run.id,
        event: 'run_started',
        journalCursor: expect.stringContaining(`orchestration:${created.run.id}:messages:`)
      })
    )
    runtime.recordOrchestrationExecutionObservation({ runId: created.run.id, event: 'run_started' })
    expect(reporter).toHaveBeenCalledTimes(1)
  })

  it('retains the local receipt after an ambiguous publication failure without retrying it', async () => {
    const run = createRun()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    reporter.mockRejectedValueOnce(new Error('connection lost after request body sent'))
    runtime.recordOrchestrationExecutionObservation({ runId: run.id, event: 'run_started' })
    await Promise.resolve()
    await Promise.resolve()
    runtime.recordOrchestrationExecutionObservation({ runId: run.id, event: 'run_started' })
    expect(reporter).toHaveBeenCalledTimes(1)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    expect(warning).toHaveBeenCalledWith(
      '[omnios] execution progress projection failed',
      expect.any(Error)
    )
  })

  it('reports a confirmed supervised stop after its durable stopped state', async () => {
    registerProcess()
    const { run, dispatch } = createSupervisedWorker()
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      connected: true,
      status: 'running'
    } as never)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: [PTY]
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: HANDLE,
      tabId: TAB,
      ptyKilled: true
    })
    expect(await call('orchestration.workerStop', { dispatch: dispatch.id })).toMatchObject({
      state: 'stopped'
    })
    expect(db.getWorkerDispatch(dispatch.id)?.state).toBe('stopped')
    expect(reporter).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.id,
        workerDispatchId: dispatch.id,
        event: 'stop_confirmed'
      })
    )
  })

  it('keeps unverifiable stops local without projecting stop confirmation', async () => {
    registerProcess()
    const { dispatch } = createSupervisedWorker()
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      connected: false,
      status: 'exited'
    } as never)
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'unverifiable',
      reason: 'link lost'
    })
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: HANDLE,
      tabId: TAB,
      ptyKilled: false
    })
    expect(await call('orchestration.workerStop', { dispatch: dispatch.id })).toMatchObject({
      state: 'stop_unknown'
    })
    expect(reporter).not.toHaveBeenCalled()
  })

  it.each([
    { exitCode: 0, options: undefined, reports: true },
    { exitCode: -1, options: undefined, reports: false },
    { exitCode: -1, options: { providerExitObserved: true }, reports: true }
  ])(
    'projects an already completed worker only with actual host exit evidence: $exitCode/$reports',
    ({ exitCode, options, reports }) => {
      registerProcess()
      const run = createRun()
      const task = createHubTaskProjection(db, {
        runId: run.id,
        hubTaskId: 'btk_content',
        title: 'Draft reply'
      })
      const dispatch = createRootDispatch(
        db,
        task.id,
        HANDLE,
        `${TAB}:${PANE}`,
        undefined,
        `${PTY}:${INCARNATION}`
      )
      db.completeDispatch(dispatch.id)
      runtime.onPtyExit(PTY, exitCode, INCARNATION, options)
      expect(reporter).toHaveBeenCalledTimes(reports ? 1 : 0)
      if (reports) {
        expect(reporter).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: run.id,
            workerDispatchId: dispatch.id,
            event: 'worker_exit'
          })
        )
      }
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    }
  )
})
