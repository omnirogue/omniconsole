import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_RUN_QUEUE_QUIET_AFTER_MS } from '../../../../shared/orchestration-run-queue'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../omni-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { HEARTBEAT_PROTOCOL_SILENCE_MS } from '../../orchestration/worker-dispatch-stall-verdict'
import type { RpcContext } from '../core'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

type Queue = {
  taskCounts: Record<string, number>
  omitted: number
  rows: {
    taskId: string
    attention: string
    attempts: number
    dispatch: { id: string; status: string; stage: string; server: string | null } | null
    session: Record<string, unknown> | null
  }[]
}

const HANDLES = [
  'term_stalled',
  'term_working',
  'term_quiet',
  'term_gone',
  'term_remote',
  'term_ask'
]

/** Pane identity is matched by its leaf id, so every worker terminal needs its own. */
function paneKey(handle: string): string {
  const leaf = String(HANDLES.indexOf(handle) + 1).padStart(12, '0')
  return `tab_${handle}:11111111-1111-4111-8111-${leaf}`
}

describe('orchestration.runShow queue', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext
  let runId: string

  function setup(): void {
    const state = h.setup()
    ;({ db, runtime, ctx } = state)
    runId = state.activeRunId!
  }

  afterEach(() => {
    h.cleanup()
    vi.restoreAllMocks()
  })

  function startWorker(
    spec: string,
    handle: string,
    federation?: { environmentId: string; environmentName: string }
  ): { taskId: string; dispatchId: string } {
    const task = db.createTask({ spec, taskTitle: spec })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { agent: 'claude', timeoutMs: 60_000 },
      ...(federation
        ? { federation: { ...federation, peerFingerprint: 'peer', protocolVersion: 1 } }
        : {})
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle,
      paneKey: paneKey(handle),
      processIncarnation: `runtime_test:${handle}:1`,
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    db.markWorkerDispatchReady(started.dispatch.id)
    return { taskId: task.id, dispatchId: started.dispatch.id }
  }

  /** Every named terminal is a live pane of its own; anything else is not on this computer. */
  function liveTerminals(
    handles: Record<string, { lastOutputAt: number; agentWait?: unknown }>
  ): void {
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle in handles ? paneKey(handle) : null
    )
    vi.spyOn(runtime, 'showTerminal').mockImplementation(async (handle) => {
      const terminal = handles[handle]
      if (!terminal) {
        throw new Error('terminal_not_found')
      }
      return { handle, connected: true, agentWait: null, ...terminal } as never
    })
  }

  async function queue(limit?: number): Promise<Queue> {
    const result = (await h.call(
      'orchestration.runShow',
      { id: runId, queue: true, ...(limit ? { limit } : {}) },
      ctx
    )) as { queue: Queue }
    return result.queue
  }

  it('advertises the capability the CLI requires and keeps a plain show unchanged', async () => {
    setup()
    expect(RUNTIME_CAPABILITIES).toContain('orchestration.run-queue.v1')
    const plain = (await h.call('orchestration.runShow', { id: runId }, ctx)) as object
    expect(Object.keys(plain)).toEqual(['run'])
    // The view's quiet line is the watchdog's own tolerance, so the two cannot drift apart.
    expect(ORCHESTRATION_RUN_QUEUE_QUIET_AFTER_MS).toBe(HEARTBEAT_PROTOCOL_SILENCE_MS)
  })

  it('reports a watchdog-failed Dispatch and its live session as two separate facts', async () => {
    setup()
    const stalled = startWorker('Notifications lane', 'term_stalled')
    startWorker('Templates lane', 'term_working')
    db.createTask({ spec: 'Not started yet' })
    db.failReadyWorkerDispatch({
      dispatchId: stalled.dispatchId,
      stage: 'input_accepted_stalled',
      reason: 'no report within 60 s'
    })
    const before = db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get()
    liveTerminals({
      term_stalled: { lastOutputAt: Date.now() },
      term_working: { lastOutputAt: Date.now() }
    })
    vi.spyOn(runtime, 'getFreshAgentHookStatusForHandle').mockImplementation(
      (handle) => ({ state: handle === 'term_working' ? 'working' : 'done' }) as never
    )

    const summary = await queue()

    expect(summary.taskCounts).toEqual({ dispatched: 1, failed: 1, ready: 1 })
    expect(summary.rows.map((row) => row.attention)).toEqual([
      'working',
      'failed-session-live',
      'not-started'
    ])
    const failed = summary.rows[1]!
    expect(failed.dispatch).toMatchObject({ status: 'failed', stage: 'input_accepted_stalled' })
    expect(failed.session).toMatchObject({ status: 'live' })
    // Read-only: no Dispatch was created, retried or reconciled by looking.
    expect(db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get()).toEqual(before)
    expect(db.getTask(stalled.taskId)?.status).toBe('failed')
  })

  it('never turns a silent or unreachable worker into an exit', async () => {
    setup()
    const quiet = startWorker('Long test run', 'term_quiet')
    const gone = startWorker('Terminal not here', 'term_gone')
    const remote = startWorker('Remote worker', 'term_remote', {
      environmentId: 'env_macbook',
      environmentName: 'MacBook'
    })
    liveTerminals({ term_quiet: { lastOutputAt: Date.now() - 45 * 60_000 } })
    vi.spyOn(runtime, 'getFreshAgentHookStatusForHandle').mockReturnValue(null as never)
    const remoteCall = vi
      .spyOn(runtime, 'callOrchestrationWorkerServer')
      .mockRejectedValue(new Error('timed out'))
    db.db.prepare("UPDATE worker_dispatches SET updated_at = datetime('now', '-45 minutes')").run()

    const rows = (await queue()).rows
    const byTask = (taskId: string) => rows.find((row) => row.taskId === taskId)!

    expect(byTask(quiet.taskId)).toMatchObject({ attention: 'quiet', session: { status: 'live' } })
    expect(byTask(gone.taskId)).toMatchObject({
      attention: 'unverifiable',
      session: { status: 'missing' }
    })
    expect(byTask(remote.taskId)).toMatchObject({
      attention: 'unverifiable',
      dispatch: { server: 'MacBook' },
      session: { status: 'unverifiable', reason: 'MacBook did not answer: timed out' }
    })
    // The remote read is the read-only show, never the reconciling worker-show path.
    expect(remoteCall).toHaveBeenCalledWith(
      'env_macbook',
      'orchestration.federationShow',
      { dispatchId: remote.dispatchId },
      8_000
    )
    for (const row of rows) {
      expect(db.getTask(row.taskId)?.status).toBe('dispatched')
    }
  })

  it('reads a remote worker waiting on a person through its own server', async () => {
    setup()
    const remote = startWorker('Remote worker', 'term_remote', {
      environmentId: 'env_studio',
      environmentName: 'Mac Studio'
    })
    vi.spyOn(runtime, 'callOrchestrationWorkerServer').mockResolvedValue({
      terminal: { lastOutputAt: Date.now() },
      observation: { status: 'running', agentWait: { source: 'prompt-text', reason: 'permission' } }
    })

    const row = (await queue()).rows.find((entry) => entry.taskId === remote.taskId)!

    expect(row.attention).toBe('waiting-on-human')
    expect(row.session).toMatchObject({ status: 'live', agentWait: { reason: 'permission' } })
  })

  it('treats a remote reply as evidence: unknown shapes stay unverifiable, text is bounded', async () => {
    setup()
    const remote = startWorker('Remote worker', 'term_remote', {
      environmentId: 'env_studio',
      environmentName: 'Mac Studio'
    })
    const call = vi.spyOn(runtime, 'callOrchestrationWorkerServer')
    const session = async () =>
      (await queue()).rows.find((entry) => entry.taskId === remote.taskId)!.session

    call.mockResolvedValueOnce({ observation: { status: 'asleep' } })
    expect(await session()).toMatchObject({ status: 'unverifiable' })

    call.mockResolvedValueOnce('not an object')
    expect(await session()).toMatchObject({ status: 'unverifiable' })

    call.mockResolvedValueOnce({
      terminal: { lastOutputAt: 'yesterday' },
      observation: { status: 'live', reason: 'x'.repeat(5_000), agentWait: 'yes' }
    })
    const odd = (await session())!
    expect(odd.status).toBe('live')
    expect(String(odd.reason)).toHaveLength(200)
    // An unreadable wait and an unreadable time stay absent (unknown), never "not waiting" or 0.
    expect('agentWait' in odd).toBe(false)
    expect('lastOutputAt' in odd).toBe(false)
  })

  it('counts open questions and retries, and bounds the list', async () => {
    setup()
    const asked = startWorker('Asks a question', 'term_ask')
    db.createQuestion({
      runId,
      dispatchId: asked.dispatchId,
      askerHandle: 'term_ask',
      question: 'Which branch?'
    })
    for (let index = 0; index < 4; index += 1) {
      db.createTask({ spec: `Waiting ${index}` })
    }
    const done = db.createTask({ spec: 'Finished' })
    db.updateTaskStatus(done.id, 'completed')
    liveTerminals({ term_ask: { lastOutputAt: Date.now() } })
    vi.spyOn(runtime, 'getFreshAgentHookStatusForHandle').mockReturnValue(null as never)

    const summary = await queue(3)

    expect(summary.rows).toHaveLength(3)
    expect(summary.omitted).toBe(2)
    expect(summary.taskCounts).toEqual({ completed: 1, dispatched: 1, ready: 4 })
    expect(summary.rows[0]).toMatchObject({
      taskId: asked.taskId,
      attention: 'waiting-on-coordinator',
      attempts: 1
    })
    await expect(
      h.call('orchestration.runShow', { id: runId, queue: true, limit: 51 }, ctx)
    ).rejects.toThrow()
  })
})
