import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../omni-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import type { OrchestrationCaller } from '../build-review/build-review-rpc-call'
import { WorkflowCheckpointStore } from './workflow-checkpoint-store'
import { WorkflowScriptSlots } from './workflow-script-slots'
import { captureWorkingAgentDispatchArtifacts } from './workflow-working-agent-dispatch-artifacts'
import { acceptWorkingAgentResult } from './workflow-working-agent-calls'
import { getWorkingRun } from './workflow-working-run-binding'
import { admitWorkingAgentGitSource } from './workflow-working-source-admission'
import { WorkingWorkflowExecutionService } from './working-workflow-execution-service'
import type { LocalWorkflowHostSnapshot } from './local-workflow-host-snapshot'
import { projectWorkingLocalWorkflow } from './local-workflow-working-projection'

const roots: string[] = []
const opened: OrchestrationDb[] = []
afterEach(() => {
  opened.splice(0).forEach((db) => db.close())
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'working-service-'))
  roots.push(root)
  const source = join(root, 'project')
  execFileSync('git', ['init', '-q', source])
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim()
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.test')
  writeFileSync(join(source, 'index.html'), '<h1>Original</h1>')
  git('add', 'index.html')
  git('commit', '-qm', 'base')
  const workingSource = await admitWorkingAgentGitSource(source)
  const db = new OrchestrationDb(':memory:')
  opened.push(db)
  const store = new WorkflowCheckpointStore(db.db)
  const labels = ['Response C', 'Response A', 'Response B']
  const seats = (['claude', 'codex', 'grok'] as const).map((agent, index) => ({
    id: `seat-${index + 1}`,
    agent,
    accountId: `managed:${agent}`,
    model: `${agent}-model`,
    effort: null,
    lineage: (['anthropic', 'openai', 'xai'] as const)[index],
    policyRevision: 'test-v1'
  }))
  const snapshot: LocalWorkflowHostSnapshot = {
    version: 1,
    capability: { mode: 'working-agent', revision: 1 },
    councilProgramRevision: 5,
    councilBlindLabels: labels,
    limits: { concurrency: 3 },
    task: { prompt: 'Build a simple HTML page.', evidence: 'Inspect this Git project.' },
    seats,
    synthesizerId: 'seat-1',
    host: {
      workspaceId: `repo::${source}`,
      conversationId: 'conversation',
      requestDigest: 'request-digest',
      startedAt: Date.now(),
      concurrency: 3,
      sources: [],
      coverage: [],
      workingSource
    }
  }
  let coordinator = 0
  const runtime = {
    createTerminal: async () => ({ handle: `term_coord_${++coordinator}` }),
    getTerminalPaneKey: (handle: string) => `tab_coord:${handle}`
  } as unknown as OrcaRuntimeService
  const tasksByRequest = new Map<string, string>()
  const childByCall = new Map<string, string>()
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let childNumber = 0
  const callRpc: OrchestrationCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
    options?: { requestId?: string }
  ): Promise<T> => {
    calls.push({ method, params })
    if (method === 'orchestration.runCreate') {
      const run = db.createRun({
        objective: String(params.objective),
        coordinatorHandle: String(params.from),
        coordinatorPaneKey: `tab_coord:${String(params.from)}`
      })
      return { run } as T
    }
    if (method === 'orchestration.taskCreate') {
      const requestId = options?.requestId ?? ''
      let taskId = tasksByRequest.get(requestId)
      if (!taskId) {
        taskId = db.createTask({ runId: String(params.run), spec: String(params.spec) }).id
        tasksByRequest.set(requestId, taskId)
      }
      return { task: { id: taskId } } as T
    }
    if (method === 'orchestration.workerStart') {
      expect(params.worktree).toBe('new-child')
      expect(params.baseBranch).toBe(workingSource.sourceBase)
      expect(params.permissionMode).toBe('yolo')
      const taskId = String(params.task)
      const task = db.getTask(taskId)!
      const callId = task.spec.match(/Workflow call ([^.\s]+)/)?.[1]
      if (!callId) {
        throw new Error('Missing call identity')
      }
      const child = join(root, `child-${++childNumber}`)
      git('worktree', 'add', '-qb', `candidate-${childNumber}`, child)
      childByCall.set(callId, child)
      if (callId.startsWith('answers/')) {
        writeFileSync(join(child, 'index.html'), `<h1>Candidate ${childNumber}</h1>`)
      } else if (callId === 'synthesis/final') {
        writeFileSync(join(child, 'index.html'), '<h1>Final selected page</h1>')
      }
      const dispatch = createRootDispatch(db, taskId, `term_worker_${childNumber}`)
      db.createWorkerTerminalResourceStatement({
        dispatchId: dispatch.id,
        worktreeId: `repo::${child}`,
        terminalHandle: `term_worker_${childNumber}`,
        paneKey: null,
        processIncarnation: null,
        ownership: 'owned'
      })
      const seatIndex = Number(callId.split('/')[1].split('-')[1]) - 1
      const otherLabels = labels.filter((_, index) => index !== seatIndex)
      const value = callId.startsWith('answers/')
        ? { markdown: 'Built and checked a candidate page.', sources: [], uncertainties: [] }
        : callId.startsWith('peer/')
          ? {
              ranking: otherLabels,
              assessments: otherLabels.map((label) => ({
                label,
                strengths: 'Page renders',
                weaknesses: 'Further checks useful'
              }))
            }
          : { markdown: 'Final page built and checked.', sources: [], disagreements: [] }
      const artifacts = await captureWorkingAgentDispatchArtifacts(db, dispatch.id)
      expect(acceptWorkingAgentResult(db, dispatch.id, value, artifacts?.digest)).toEqual({
        accepted: true
      })
      db.db.prepare("UPDATE tasks SET status='completed' WHERE id=?").run(taskId)
      return { dispatchId: dispatch.id, state: 'ready' } as T
    }
    if (method === 'orchestration.workerRelease') {
      db.db
        .prepare(
          "UPDATE worker_terminal_resources SET release_state='released' WHERE owner_dispatch_id=?"
        )
        .run(String(params.dispatch))
      return { state: 'released' } as T
    }
    if (method === 'orchestration.runUse') {
      const run = db.getRun(String(params.id))!
      db.bindRun({
        runId: run.id,
        coordinatorHandle: String(params.from),
        coordinatorPaneKey: `tab_coord:${String(params.from)}`
      })
      return { run: db.getRun(run.id) } as T
    }
    throw new Error(`Unexpected RPC ${method}`)
  }
  const service = new WorkingWorkflowExecutionService({
    db,
    runtime,
    store,
    slots: new WorkflowScriptSlots(3),
    callRpc
  })
  return { db, store, root, source, snapshot, service, calls, childByCall }
}

describe('working workflow service', () => {
  it('builds three private candidates, takes three blind ballots, and writes final HTML in chair child', async () => {
    const f = await fixture()
    const id = f.service.start({
      conversationId: 'conversation',
      requestId: 'request',
      snapshot: f.snapshot,
      preset: 'council',
      fence: 1,
      attemptLimit: 1,
      callLimit: 7,
      budgetLimit: 7,
      workspaceId: f.snapshot.host.workspaceId,
      ...f.snapshot.host.workingSource
    })
    const outcome = await Promise.race([
      f.service.wait(id),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          f.service.control(id, 1, 'stop')
          reject(
            new Error(
              `Synthetic service timed out: ${JSON.stringify(f.calls.map((entry) => entry.method))}`
            )
          )
        }, 3000)
      )
    ])
    expect(outcome.state).toBe('completed')
    expect(f.calls.filter((call) => call.method === 'orchestration.workerStart')).toHaveLength(7)
    expect([...f.childByCall.keys()].filter((id) => id.startsWith('answers/'))).toHaveLength(3)
    expect([...f.childByCall.keys()].filter((id) => id.startsWith('peer/'))).toHaveLength(3)
    expect(readFileSync(join(f.source, 'index.html'), 'utf8')).toBe('<h1>Original</h1>')
    expect(readFileSync(join(f.childByCall.get('synthesis/final')!, 'index.html'), 'utf8')).toBe(
      '<h1>Final selected page</h1>'
    )
    expect(getWorkingRun(f.db, id)?.state).toBe('completed')
    expect(await f.service.recoverCompleted(id, 1)).toEqual(outcome)
    // Details opens a worker's real terminal only while it stays open.
    const view = () =>
      projectWorkingLocalWorkflow({ db: f.db.db, store: f.store, executionId: id, active: false })
    const released = view().calls
    expect(released).toHaveLength(7)
    expect(released.filter((call) => call.terminalHandle !== undefined)).toEqual([])
    const { dispatch_id: dispatch } = f.db.db
      .prepare(
        "SELECT dispatch_id FROM local_workflow_worker_calls WHERE execution_id=? AND call_id='answers/seat-1'"
      )
      .get(id) as { dispatch_id: string }
    const handleWhile = (releaseState: string) => {
      f.db.db
        .prepare('UPDATE worker_terminal_resources SET release_state=? WHERE owner_dispatch_id=?')
        .run(releaseState, dispatch)
      return view().calls.find((call) => call.id === 'answers/seat-1')?.terminalHandle
    }
    expect(handleWhile('retained')).toMatch(/^term_worker_\d+$/)
    expect(handleWhile('not_requested')).toMatch(/^term_worker_\d+$/)
    // A release under way, or one whose outcome is unknown, may already have closed it.
    for (const releaseState of ['requested', 'releasing', 'unknown']) {
      expect(handleWhile(releaseState)).toBeUndefined()
    }
  })
})
