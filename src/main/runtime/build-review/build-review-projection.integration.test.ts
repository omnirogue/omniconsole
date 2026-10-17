import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../omni-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { ORCHESTRATION_METHODS } from '../rpc/methods/orchestration'
import { BuildReviewService } from './build-review-service'

// Placement has its own tests (build-review-fleet-placement.test.ts); here this computer is
// the verified host so the projection under test is reached.
vi.mock(import('../workflow-script/local-workflow-fleet-placement'), async (importOriginal) => ({
  ...(await importOriginal()),
  placeLocalWorkflow: vi.fn(async (runsOn: 'fleet' | 'local' | undefined) => ({
    runsOn: runsOn ?? 'fleet',
    mode: 'local' as const
  }))
}))

describe('Build + Review with the real projection, RPC and execution journal', () => {
  let db: OrchestrationDb
  const reports: Promise<unknown>[] = []

  afterEach(async () => {
    await Promise.all(reports.splice(0))
    db?.close()
    vi.restoreAllMocks()
  })

  function setup() {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    let terminals = 0
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation(
      (handle) => `${handle}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
    )
    vi.spyOn(runtime, 'getLiveTerminalPaneKey').mockImplementation((handle) =>
      runtime.getTerminalPaneKey(handle)
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => `fixture:${handle}:1`
    )
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'folder:projection',
      path: process.cwd()
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockImplementation(
      async () =>
        ({
          handle: terminals++ === 0 ? 'term_coord' : `term_worker_${terminals}`
        }) as never
    )
    vi.spyOn(runtime, 'showTerminal').mockImplementation(
      async (handle) =>
        ({
          handle,
          worktreeId: 'folder:projection',
          status: 'running',
          connected: true
        }) as never
    )
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({ ptyKilled: true } as never)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('omni')
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    } as never)
    const prompts: string[] = []
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle, prompt) => {
      prompts.push(prompt)
      reports.push(
        new Promise((resolve, reject) => {
          setTimeout(() => {
            const dispatch = db.db
              .prepare('SELECT id, task_id FROM dispatch_contexts WHERE assignee_handle = ?')
              .get(handle) as { id: string; task_id: string }
            const method = ORCHESTRATION_METHODS.find(
              (entry) => entry.name === 'orchestration.send'
            )!
            const params = method.params!.parse({
              from: handle,
              type: 'worker_done',
              subject: 'Execution evidence',
              body: prompts.length === 1 ? 'Built the badge.' : 'VERDICT: APPROVE',
              payload: JSON.stringify({
                taskId: dispatch.task_id,
                dispatchId: dispatch.id,
                outcome: 'succeeded',
                filesModified: 'src/badge.ts'
              })
            })
            Promise.resolve(
              method.handler(params, {
                runtime,
                orchestrationCapability: prompt.match(/--dispatch-capability (\S+)/)?.[1]
              })
            ).then(resolve, reject)
          }, 0)
        })
      )
      return { handle, accepted: true, bytesWritten: prompt.length }
    })
    const service = new BuildReviewService(runtime, undefined, async () => ({
      ok: true,
      noteId: 'fixture-note'
    }))
    return { service, runtime, prompts }
  }

  it('starts and settles builder and reviewer on one immutable card projection', async () => {
    const { service, runtime, prompts } = setup()
    const started = service.start({
      worktree: 'folder:projection',
      objective: 'Add the accessible badge',
      hubTaskId: 'btk_projection'
    })
    await vi.waitFor(() => {
      expect(['completed', 'failed']).toContain(service.show(started.id).stage)
    })
    const result = service.show(started.id)
    expect(result.error).toBeNull()
    expect(result.stage).toBe('completed')
    expect(result.builder.taskId).toBe(result.projectionTaskId)
    expect(result.reviewer.taskId).toBe(result.projectionTaskId)
    expect(result.builder.dispatchId).not.toBe(result.reviewer.dispatchId)
    expect(db.listTasks({ runId: result.runId! })).toHaveLength(1)
    expect(db.getTask(result.projectionTaskId!)).toMatchObject({
      hub_task_id: 'btk_projection',
      spec: 'btk_projection',
      deps: '[]',
      hub_state_revision: null
    })
    expect(() => db.createTask({ runId: result.runId!, spec: 'New business task' })).toThrow(
      /read.only|hub|omnios/i
    )
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('Add the accessible badge')
    expect(prompts[1]).toContain('src/badge.ts')
    expect(prompts[1]).toContain('VERDICT:')
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:folder:projection',
      expect.objectContaining({ startupAgent: 'codex', hubTaskId: 'btk_projection' })
    )
    const stored = db.getWorkerDispatch(result.reviewer.dispatchId!)!
    expect(JSON.parse(stored.start_options).executionBrief).toContain('src/badge.ts')
    expect(() =>
      db.createStartingWorkerDispatch({
        taskId: result.projectionTaskId!,
        continueFrom: result.builder.dispatchId!,
        startOptions: {},
        creator: { kind: 'system' },
        maxDepth: 1
      })
    ).toThrow('latest settled execution')
  })
})
