import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db'
import type { WorkerReportSettlement } from '../orchestration/types'
import { WorkerUnitRegistry, type WorkerUnitLike } from './build-review-worker-registry'
import type {
  ActiveRun,
  WorkerHostContext,
  WorkerLifecycleContext
} from './build-review-worker-lifecycle'
import { LocalRunIdleSettler, type IdleSettleNode } from './local-run-idle-settle'
import { RunMailboxPump } from './local-run-mailbox-pump'
import { localRunNodeOutputDir, localRunNodeReportPath } from './local-run-placement'

const RUN_ID = 'run_1'
const TASK_ID = 'task_a'
const DISPATCH_ID = 'ctx_a'

type Logged = { kind: string; role: string; text: string }

function unit(dispatchId: string): WorkerUnitLike {
  return {
    role: 'assemble',
    choice: { agent: 'codex' },
    status: 'running',
    taskId: TASK_ID,
    dispatchId,
    terminalHandle: 'term_worker_2',
    report: null,
    error: null
  }
}

function activeRun(): ActiveRun {
  return {
    abort: new AbortController(),
    pendingAck: null,
    seenMessageIds: new Set(),
    execution: null
  }
}

describe('settling a local run node from the report its idle worker left on disk', () => {
  const workspaces: string[] = []

  afterEach(() => {
    for (const path of workspaces.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  /** A workspace with the node's dictated report and deliverables already written. */
  function workspace(options: { report?: string } = {}): string {
    const path = mkdtempSync(join(tmpdir(), 'idle-settle-'))
    workspaces.push(path)
    const outputDir = localRunNodeOutputDir(path, RUN_ID, TASK_ID)
    mkdirSync(outputDir, { recursive: true })
    if (options.report !== undefined) {
      writeFileSync(join(outputDir, 'manifest.md'), '- assembled.md: the deliverable')
      writeFileSync(join(outputDir, 'assembled.md'), 'the assembled cut')
      writeFileSync(localRunNodeReportPath(path, RUN_ID, TASK_ID), options.report)
    }
    return path
  }

  function harness(options: {
    workspacePath: string
    agentStatus: 'idle' | 'working'
    dispatchId?: string
    node?: Partial<IdleSettleNode>
    settlement?: WorkerReportSettlement
    settleWorkerReport?: (args: {
      taskId: string
      dispatchId: string
      outcome: 'succeeded' | 'failed'
      result: string
    }) => WorkerReportSettlement
  }) {
    const registry = new WorkerUnitRegistry()
    const dispatchId = options.dispatchId ?? DISPATCH_ID
    const worker = unit(dispatchId)
    registry.bind(worker, dispatchId)
    const events: Logged[] = []
    const settled: Record<string, unknown>[] = []
    const host: WorkerHostContext = {
      coordinatorTerminalHandle: 'term_coord',
      runId: RUN_ID,
      log: (kind, role, text) => events.push({ kind, role, text }),
      changed: () => {}
    }
    const call = vi.fn(async (method: string) => {
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { isRunningAgent: true, status: options.agentStatus } }
      }
      return {}
    })
    const ctx = { call, changed: () => {} } as unknown as WorkerLifecycleContext
    const settler = new LocalRunIdleSettler({
      ctx,
      host,
      registry,
      workspacePath: options.workspacePath,
      nodeFor: () => ({
        taskId: TASK_ID,
        reportPath: localRunNodeReportPath(options.workspacePath, RUN_ID, TASK_ID),
        hasOpenQuestion: false,
        ...options.node
      }),
      settleWorkerReport: (args) => {
        settled.push(args)
        return (
          options.settleWorkerReport?.(args) ??
          options.settlement ?? { action: 'settled', outcome: args.outcome, duplicate: false }
        )
      }
    })
    return { registry, worker, events, settled, settler, ctx, host, call }
  }

  it('settles the node on the second empty window, exactly as a worker_done would', async () => {
    const workspacePath = workspace({ report: '# assemble\n\nOutcome: succeeded\n' })
    const { worker, events, settled, settler } = harness({ workspacePath, agentStatus: 'idle' })

    await settler.onEmptyWindow()
    expect(worker.status).toBe('running')
    expect(settled).toHaveLength(0)

    await settler.onEmptyWindow()
    expect(settled).toEqual([
      {
        taskId: TASK_ID,
        dispatchId: DISPATCH_ID,
        outcome: 'succeeded',
        result: expect.stringContaining('report_file_settlement')
      }
    ])
    expect(worker.status).toBe('succeeded')
    expect(worker.report?.outcome).toBe('succeeded')
    expect(worker.report?.reportPath).toBe(localRunNodeReportPath(workspacePath, RUN_ID, TASK_ID))
    // The next node is handed what this one produced, not an empty list.
    expect(worker.report?.filesModified).toEqual([
      join(localRunNodeOutputDir(workspacePath, RUN_ID, TASK_ID), 'assembled.md'),
      join(localRunNodeOutputDir(workspacePath, RUN_ID, TASK_ID), 'manifest.md')
    ])
    expect(events.map((event) => event.text)).toContainEqual(
      expect.stringContaining('went idle without sending worker_done')
    )
    expect(events.every((event) => !event.text.includes('worktree'))).toBe(true)
  })

  it('fails the node when the report declares a failed outcome', async () => {
    const workspacePath = workspace({ report: '**Outcome:** failed\n\nThe build never ran.\n' })
    const { worker, settled, settler } = harness({ workspacePath, agentStatus: 'idle' })

    await settler.onEmptyWindow()
    await settler.onEmptyWindow()
    expect(settled[0]?.outcome).toBe('failed')
    expect(worker.status).toBe('failed')
    expect(worker.report?.outcome).toBe('failed')
  })

  it('leaves an idle worker that wrote no report alone', async () => {
    const workspacePath = workspace()
    const { worker, settled, settler } = harness({ workspacePath, agentStatus: 'idle' })

    await settler.onEmptyWindow()
    await settler.onEmptyWindow()
    await settler.onEmptyWindow()
    expect(settled).toHaveLength(0)
    expect(worker.status).toBe('running')
  })

  it('never settles a worker that is still working, however complete its report looks', async () => {
    const workspacePath = workspace({ report: 'Outcome: succeeded\n' })
    const { worker, settled, settler } = harness({ workspacePath, agentStatus: 'working' })

    await settler.onEmptyWindow()
    await settler.onEmptyWindow()
    expect(settled).toHaveLength(0)
    expect(worker.status).toBe('running')
  })

  it('never settles a node that still owes a person an answer', async () => {
    const workspacePath = workspace({ report: 'Outcome: succeeded\n' })
    const { worker, settled, settler } = harness({
      workspacePath,
      agentStatus: 'idle',
      node: { hasOpenQuestion: true }
    })

    await settler.onEmptyWindow()
    await settler.onEmptyWindow()
    expect(settled).toHaveLength(0)
    expect(worker.status).toBe('running')
  })

  it('never settles a worker whose question is open on the Run mailbox', async () => {
    const workspacePath = workspace({ report: 'Outcome: succeeded\n' })
    const { registry, worker, settled, settler } = harness({ workspacePath, agentStatus: 'idle' })
    registry.setPendingQuestion(worker, {
      messageId: 'msg_1',
      role: worker.role,
      question: 'Cut b or cut c?',
      options: ['b', 'c'],
      askedAt: new Date().toISOString()
    })

    await settler.onEmptyWindow()
    await settler.onEmptyWindow()
    expect(settled).toHaveLength(0)
    expect(worker.status).toBe('running')
  })

  it('needs the two windows to be CONSECUTIVE: anything the worker says starts them again', async () => {
    const workspacePath = workspace({ report: 'Outcome: succeeded\n' })
    const { worker, settled, settler } = harness({ workspacePath, agentStatus: 'idle' })

    await settler.onEmptyWindow()
    settler.onMessages()
    await settler.onEmptyWindow()
    expect(settled).toHaveLength(0)
    expect(worker.status).toBe('running')
    await settler.onEmptyWindow()
    expect(worker.status).toBe('succeeded')
  })

  it('says so and leaves the worker running when the store refuses the settlement', async () => {
    const workspacePath = workspace({ report: 'Outcome: succeeded\n' })
    const { worker, events, settler } = harness({
      workspacePath,
      agentStatus: 'idle',
      settlement: { action: 'rejected', code: 'inactive_dispatch', reason: 'already settled' }
    })

    await settler.onEmptyWindow()
    await settler.onEmptyWindow()
    expect(worker.status).toBe('running')
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'error', text: expect.stringContaining('already settled') })
    )
  })

  it('settles the real worker_dispatches row the same way a worker_done does', async () => {
    const workspacePath = workspace({ report: 'Outcome: succeeded\n' })
    const db = new OrchestrationDb(':memory:')
    try {
      const task = db.createTask({ spec: 'assemble the three cuts' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: { topology: 'current', agent: 'codex' }
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_worker_2',
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'runtime:pty:1',
        worktreeId: 'repo::workspace',
        setupState: 'not_applicable',
        effects: []
      })
      db.markWorkerDispatchReady(started.dispatch.id)
      // The node's real Dispatch, exactly as worker-start bound it.
      const { worker, settler } = harness({
        workspacePath,
        agentStatus: 'idle',
        dispatchId: started.dispatch.id,
        node: { taskId: task.id },
        settleWorkerReport: (args) => db.settleWorkerReport(args)
      })

      await settler.onEmptyWindow()
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')

      await settler.onEmptyWindow()
      expect(db.getWorkerDispatch(started.dispatch.id)).toMatchObject({
        state: 'succeeded',
        stage: 'settled'
      })
      expect(db.getTask(task.id)?.status).toBe('completed')
      expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('completed')
      expect(worker.status).toBe('succeeded')
    } finally {
      db.close()
    }
  })

  it('does not count a replayed Delivery as an empty window', async () => {
    const workspacePath = workspace({ report: 'Outcome: succeeded\n' })
    const {
      registry,
      worker,
      settler,
      host,
      call: statusCall
    } = harness({ workspacePath, agentStatus: 'idle' })
    const run = activeRun()
    // The same Delivery replays forever and every message in it has already been seen.
    const seen = {
      id: 'm1',
      from_handle: 'agent',
      type: 'heartbeat',
      subject: 'alive',
      payload: JSON.stringify({ dispatchId: DISPATCH_ID })
    }
    run.seenMessageIds.add('m1')
    let checks = 0
    const call = vi.fn(async (method: string) => {
      if (method === 'orchestration.workerShow') {
        return { worker: { state: 'dispatched', agent_terminal_handle: worker.terminalHandle } }
      }
      checks += 1
      if (checks > 2) {
        run.abort.abort()
      }
      return { deliveryId: 'del_1', messages: [seen] }
    })
    const ctx = { call, changed: () => {} } as unknown as WorkerLifecycleContext
    const pump = new RunMailboxPump(ctx, host, run, registry, settler)
    pump.ensure()
    await pump.idle()
    expect(statusCall.mock.calls).toHaveLength(0)
    expect(worker.status).toBe('running')
  })

  it('is driven by the mailbox pump empty wait window', async () => {
    const workspacePath = workspace({ report: 'Outcome: succeeded\n' })
    const {
      registry,
      worker,
      settler,
      host,
      call: statusCall
    } = harness({ workspacePath, agentStatus: 'idle' })
    const call = vi.fn(async (method: string) => {
      if (method === 'terminal.agentStatus') {
        return { agentStatus: { isRunningAgent: true, status: 'idle' } }
      }
      if (method === 'orchestration.workerShow') {
        return { worker: { state: 'dispatched', agent_terminal_handle: worker.terminalHandle } }
      }
      return { deliveryId: null, messages: [] }
    })
    const ctx = { call, changed: () => {} } as unknown as WorkerLifecycleContext
    const pump = new RunMailboxPump(ctx, host, activeRun(), registry, settler)
    const wait = registry.waitFor(worker)
    pump.ensure()
    await wait
    await pump.idle()
    expect(worker.status).toBe('succeeded')
    // The settler read the worker's own terminal once per empty window, and nothing
    // else was said on the mailbox.
    expect(statusCall.mock.calls).toHaveLength(2)
    expect(call.mock.calls.every(([method]) => method !== 'terminal.agentStatus')).toBe(true)
  })
})
