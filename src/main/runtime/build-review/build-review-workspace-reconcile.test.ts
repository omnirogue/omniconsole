import { describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { BuildReviewRpcError, type OrchestrationCaller } from './build-review-rpc-call'
import { readBuildReviewReservation } from './build-review-workspace-evidence'
import {
  buildReviewClaimOptions,
  buildReviewWorkspaceHold,
  reconcileBuildReviewDispatches,
  releaseSettledBuildReviewWorkspace,
  type BuildReviewReconcileDeps
} from './build-review-workspace-reconcile'
import {
  bindBuildReviewRun,
  buildReviewWorkspaceKey,
  claimBuildReviewWorkspace,
  markBuildReviewWorkerStart,
  recordBuildReviewWorkerStart
} from './build-review-workspace-reservation'

const WORKTREE = 'repo::/wt'
const KEY = buildReviewWorkspaceKey({ path: process.cwd() })
const DEAD_PID = 2_147_483_647

type DispatchSeed = {
  id: string
  dispatchStatus?: string
  workerState?: string
  handle: string
  /** A stalled prompt may have landed, so the worker kept its authority. */
  capabilityRetained?: boolean
  /** The terminal became an owned resource (else it is only a residual effect). */
  owned?: { incarnation: string; releaseState?: string; ownership?: string }
  /** The Task it ran; a retry of the same Task shares it. Defaults to one of its own. */
  task?: string
  /** It started in a terminal it did not create, so it left no residual of its own. */
  reusedTerminal?: boolean
}

function seed(
  db: OrchestrationDb,
  dispatches: DispatchSeed[],
  owner: { pipelineId?: string; epoch?: string; pid?: number; startInFlight?: boolean } = {}
): string {
  const pipelineId = owner.pipelineId ?? 'brp_old'
  const epoch = owner.epoch ?? 'epoch_old'
  const run = db.createRun({
    objective: 'Build',
    coordinatorHandle: `term_coord_${pipelineId}`,
    coordinatorPaneKey: `pane_coord_${pipelineId}`
  })
  claimBuildReviewWorkspace(db, KEY, WORKTREE, pipelineId, epoch, owner.pid ?? DEAD_PID)
  bindBuildReviewRun(db, KEY, pipelineId, epoch, run.id)
  for (const dispatch of dispatches) {
    markBuildReviewWorkerStart(db, KEY, pipelineId, epoch)
    const task = dispatch.task ?? `task_${dispatch.id}`
    db.db
      .prepare('INSERT OR IGNORE INTO tasks (id, run_id, spec, status) VALUES (?, ?, ?, ?)')
      .run(task, run.id, 'build', 'failed')
    db.db
      .prepare(
        'INSERT INTO dispatch_contexts (id, run_id, task_id, status, capability_revoked_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        dispatch.id,
        run.id,
        task,
        dispatch.dispatchStatus ?? 'failed',
        dispatch.capabilityRetained ? null : '2026-09-21 12:00:00'
      )
    db.db
      .prepare(
        'INSERT INTO worker_dispatches (dispatch_id, state, agent_terminal_handle, residual_resources) VALUES (?, ?, ?, ?)'
      )
      .run(
        dispatch.id,
        dispatch.workerState ?? 'failed',
        dispatch.handle,
        JSON.stringify(
          dispatch.reusedTerminal
            ? []
            : [{ kind: 'terminal', role: 'agent', action: 'created', id: dispatch.handle }]
        )
      )
    if (dispatch.owned) {
      db.db
        .prepare(
          'INSERT INTO worker_terminal_resources (id, origin_dispatch_id, owner_dispatch_id, worktree_id, terminal_handle, process_incarnation, ownership_state, release_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          `wtr_${dispatch.id}`,
          dispatch.id,
          dispatch.id,
          WORKTREE,
          dispatch.handle,
          dispatch.owned.incarnation,
          dispatch.owned.ownership ?? 'owned',
          dispatch.owned.releaseState ?? 'not_requested'
        )
    }
    recordBuildReviewWorkerStart(db, KEY, pipelineId, epoch, dispatch.id)
  }
  if (owner.startInFlight) {
    // A worker start that never reported back: the app died inside it.
    markBuildReviewWorkerStart(db, KEY, pipelineId, epoch)
  }
  return run.id
}

function harness(
  db: OrchestrationDb,
  options: {
    liveHandles?: string[]
    /** What `terminal.show` answers for a handle the runtime still knows (kept readable). */
    shown?: Record<string, Record<string, unknown>>
    exited?: string[]
    executing?: string[]
    epoch?: string
  } = {}
) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const call = (async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    if (method === 'terminal.show') {
      const shown = options.shown?.[params.terminal as string]
      if (shown) {
        return { terminal: { handle: params.terminal, ...shown } }
      }
      if (options.liveHandles?.includes(params.terminal as string)) {
        return { terminal: { handle: params.terminal } }
      }
      throw new BuildReviewRpcError(method, 'terminal_handle_stale', 'terminal_handle_stale')
    }
    return { state: 'retained', reason: 'no_owned_resource' }
  }) as OrchestrationCaller
  const processLiveness = vi.fn(async (incarnation: string) =>
    options.exited?.includes(incarnation) ? ('exited' as const) : ('live' as const)
  )
  const deps: BuildReviewReconcileDeps = {
    db,
    call,
    runtimeEpoch: options.epoch ?? 'epoch_now',
    processLiveness,
    isExecuting: (id) => options.executing?.includes(id) ?? false
  }
  return { deps, calls, processLiveness }
}

describe('Build + Review workspace reconciliation', () => {
  it('counts out a closed leftover terminal, keeps an open one, and closes nothing', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const runId = seed(db, [
        { id: 'ctx_closed', handle: 'term_closed' },
        { id: 'ctx_open', handle: 'term_open' }
      ])
      const { deps, calls } = harness(db, { liveHandles: ['term_open'] })
      const { resolved, open } = await reconcileBuildReviewDispatches(deps, runId)
      expect([...resolved]).toEqual(['ctx_closed'])
      expect(open.map(({ id }) => id)).toEqual(['ctx_open'])
      expect(calls.map(({ method }) => method)).toEqual(['terminal.show', 'terminal.show'])
    } finally {
      db.close()
    }
  })

  it('counts out a closed terminal the runtime still shows, reading its current liveness', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const runId = seed(db, [
        { id: 'ctx_closed', handle: 'term_closed' },
        { id: 'ctx_listed_gone', handle: 'term_listed_gone' },
        { id: 'ctx_listed_live', handle: 'term_listed_live' },
        { id: 'ctx_unexplained', handle: 'term_unexplained' },
        { id: 'ctx_open', handle: 'term_open' }
      ])
      const local = { executionHostId: 'local' }
      const { deps, processLiveness } = harness(db, {
        shown: {
          // "Stop and Close": the runtime keeps the exited terminal readable, with its exit.
          term_closed: { connected: false, exitCause: { kind: 'operator_close' }, ...local },
          // No exit recorded yet: the host's own process list decides.
          term_listed_gone: { connected: false, ptyId: 'pty_a', incarnationId: 'inc_a', ...local },
          term_listed_live: { connected: false, ptyId: 'pty_b', incarnationId: 'inc_b', ...local },
          // A disconnect nothing explains is no proof the process is gone.
          term_unexplained: { connected: false, exitCause: { kind: 'unknown' } },
          term_open: { connected: true, ptyId: 'pty_c', incarnationId: 'inc_c', ...local }
        },
        exited: ['pty_a:inc_a']
      })
      const { resolved, open } = await reconcileBuildReviewDispatches(deps, runId)
      expect([...resolved].sort()).toEqual(['ctx_closed', 'ctx_listed_gone'])
      expect(open.map(({ id }) => id)).toEqual(['ctx_listed_live', 'ctx_open', 'ctx_unexplained'])
      expect([...processLiveness.mock.calls].sort()).toEqual([
        ['pty_a:inc_a', JSON.stringify({ kind: 'local', hostId: 'local' })],
        ['pty_b:inc_b', JSON.stringify({ kind: 'local', hostId: 'local' })]
      ])
    } finally {
      db.close()
    }
  })

  it('frees the workspace on Release once its terminal was closed, without an app restart', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      seed(db, [{ id: 'ctx_blocked', handle: 'term_blocked' }])
      const open = harness(db, { liveHandles: ['term_blocked'] })
      await expect(
        releaseSettledBuildReviewWorkspace(open.deps, KEY, 'release')
      ).resolves.toMatchObject({ open: [{ id: 'ctx_blocked' }] })
      const closed = harness(db, {
        shown: { term_blocked: { connected: false, exitCause: { kind: 'operator_close' } } }
      })
      await expect(releaseSettledBuildReviewWorkspace(closed.deps, KEY, 'release')).resolves.toBe(
        null
      )
      expect(readBuildReviewReservation(db, KEY)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('marks as releasable only a terminal the run still owns and nothing may be working in', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      seed(db, [
        { id: 'ctx_owned', handle: 'term_owned', owned: { incarnation: 'inc_owned' } },
        { id: 'ctx_left', handle: 'term_left' },
        {
          id: 'ctx_maybe',
          handle: 'term_maybe',
          capabilityRetained: true,
          owned: { incarnation: 'inc_maybe' }
        }
      ])
      const { deps } = harness(db, { liveHandles: ['term_left'] })
      const held = await releaseSettledBuildReviewWorkspace(deps, KEY, 'observe')
      expect(
        buildReviewWorkspaceHold(held!, () => 'builder').items.map(({ dispatchId, releasable }) => [
          dispatchId,
          releasable ?? false
        ])
      ).toEqual([
        ['ctx_left', false],
        ['ctx_maybe', false],
        ['ctx_owned', true]
      ])
    } finally {
      db.close()
    }
  })

  it('trusts only the host saying an owned terminal process exited', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const runId = seed(db, [
        { id: 'ctx_exited', handle: 'term_a', owned: { incarnation: 'inc_exited' } },
        { id: 'ctx_live', handle: 'term_b', owned: { incarnation: 'inc_live' } },
        {
          id: 'ctx_released',
          handle: 'term_c',
          capabilityRetained: true,
          owned: { incarnation: 'inc_released', releaseState: 'released' }
        }
      ])
      const { deps, calls, processLiveness } = harness(db, { exited: ['inc_exited'] })
      const { resolved, open } = await reconcileBuildReviewDispatches(deps, runId)
      // A released terminal needs no second look, even though its worker kept its authority.
      expect([...resolved].sort()).toEqual(['ctx_exited', 'ctx_released'])
      expect(open.map(({ id }) => id)).toEqual(['ctx_live'])
      expect(processLiveness).toHaveBeenCalledTimes(2)
      // A stale handle is no proof for an owned terminal: it is never asked.
      expect(calls).toEqual([])
    } finally {
      db.close()
    }
  })

  it('runs the ordinary worker release first when a person asks, and never for a live worker', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const runId = seed(db, [
        { id: 'ctx_settled', handle: 'term_settled' },
        {
          id: 'ctx_running',
          handle: 'term_running',
          dispatchStatus: 'dispatched',
          workerState: 'ready'
        }
      ])
      const { deps, calls } = harness(db, { liveHandles: ['term_settled', 'term_running'] })
      const { open } = await reconcileBuildReviewDispatches(deps, runId, { release: true })
      expect(calls.filter(({ method }) => method === 'orchestration.workerRelease')).toEqual([
        { method: 'orchestration.workerRelease', params: { dispatch: 'ctx_settled' } }
      ])
      expect(open.map(({ id, kind }) => [id, kind])).toEqual([
        ['ctx_running', 'worker-active'],
        ['ctx_settled', 'terminal-open']
      ])
    } finally {
      db.close()
    }
  })

  it('never closes the terminal of an agent whose task may have landed, until it is gone', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const runId = seed(db, [
        {
          id: 'ctx_stalled',
          handle: 'term_stalled',
          capabilityRetained: true,
          owned: { incarnation: 'inc_stalled' }
        }
      ])
      const live = harness(db)
      const { open } = await reconcileBuildReviewDispatches(live.deps, runId, { release: true })
      expect(live.calls.some(({ method }) => method === 'orchestration.workerRelease')).toBe(false)
      expect(open).toMatchObject([{ id: 'ctx_stalled', mayBeWorking: true }])
      const held = await releaseSettledBuildReviewWorkspace(live.deps, KEY, 'release')
      expect(buildReviewWorkspaceHold(held!, () => 'builder').items).toEqual([
        {
          kind: 'maybe-working',
          role: 'builder',
          dispatchId: 'ctx_stalled',
          terminalHandle: 'term_stalled'
        }
      ])
      // Once the person closes it (its process exits), Release frees the workspace.
      const closed = harness(db, { exited: ['inc_stalled'] })
      await expect(releaseSettledBuildReviewWorkspace(closed.deps, KEY, 'release')).resolves.toBe(
        null
      )
    } finally {
      db.close()
    }
  })

  it('frees the workspace once the start retried in the terminal its person answered in succeeds', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      // The first start stopped on Claude's trust question before its prompt, so it owns no
      // terminal; the retry ran the same Task in that terminal, which the person keeps.
      seed(db, [
        { id: 'ctx_asked', handle: 'term_person', task: 'task_build' },
        {
          id: 'ctx_answered',
          handle: 'term_person',
          task: 'task_build',
          dispatchStatus: 'completed',
          workerState: 'succeeded',
          reusedTerminal: true,
          owned: { incarnation: 'inc_person', ownership: 'external' }
        }
      ])
      const { deps } = harness(db, { liveHandles: ['term_person'] })
      await expect(releaseSettledBuildReviewWorkspace(deps, KEY, 'observe')).resolves.toBe(null)
      expect(readBuildReviewReservation(db, KEY)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('keeps that terminal holding when the retry there did not succeed, or came before it', async () => {
    const failedRetry = new OrchestrationDb(':memory:')
    const earlierSuccess = new OrchestrationDb(':memory:')
    try {
      const failedRun = seed(failedRetry, [
        { id: 'ctx_asked', handle: 'term_person', task: 'task_build' },
        {
          id: 'ctx_retry',
          handle: 'term_person',
          task: 'task_build',
          reusedTerminal: true,
          owned: { incarnation: 'inc_person', ownership: 'external' }
        }
      ])
      const failed = harness(failedRetry, { liveHandles: ['term_person'] })
      const { open } = await reconcileBuildReviewDispatches(failed.deps, failedRun)
      expect(open.map(({ id }) => id)).toEqual(['ctx_asked'])
      // A later start that may be working there is never counted out by an earlier success.
      const earlierRun = seed(earlierSuccess, [
        {
          id: 'ctx_done',
          handle: 'term_person',
          task: 'task_build',
          dispatchStatus: 'completed',
          workerState: 'succeeded',
          owned: { incarnation: 'inc_person', ownership: 'user_owned' }
        },
        { id: 'ctx_again', handle: 'term_person', task: 'task_build', capabilityRetained: true }
      ])
      const earlier = harness(earlierSuccess, { liveHandles: ['term_person'] })
      const held = await reconcileBuildReviewDispatches(earlier.deps, earlierRun)
      expect(held.open.map(({ id, mayBeWorking }) => [id, mayBeWorking])).toEqual([
        ['ctx_again', true],
        ['ctx_done', false]
      ])
    } finally {
      failedRetry.close()
      earlierSuccess.close()
    }
  })

  it('clears a worker start the previous app died inside when it started nothing', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      seed(db, [{ id: 'ctx_done', handle: 'term_done' }], { startInFlight: true })
      const { deps } = harness(db)
      await expect(releaseSettledBuildReviewWorkspace(deps, KEY, 'observe')).resolves.toBe(null)
      expect(readBuildReviewReservation(db, KEY)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('keeps an unreported start of this app reserved: it may still land', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      seed(db, [], { epoch: 'epoch_now', pid: process.pid, startInFlight: true })
      const { deps } = harness(db)
      await expect(releaseSettledBuildReviewWorkspace(deps, KEY, 'release')).resolves.toMatchObject(
        { missingEvidence: true }
      )
      expect(readBuildReviewReservation(db, KEY)?.worker_start_in_flight).toBe(1)
    } finally {
      db.close()
    }
  })

  it('frees the workspace once what held it is gone, and says what still holds it otherwise', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      seed(db, [{ id: 'ctx_blocked', handle: 'term_blocked' }])
      const open = harness(db, { liveHandles: ['term_blocked'] })
      const held = await releaseSettledBuildReviewWorkspace(open.deps, KEY, 'observe')
      expect(held).toMatchObject({ owner: null, missingEvidence: false })
      expect(
        buildReviewWorkspaceHold(held!, (id) => (id === 'ctx_blocked' ? 'builder' : null))
      ).toEqual({
        pipelineId: 'brp_old',
        runId: expect.any(String),
        items: [
          {
            kind: 'terminal-open',
            role: 'builder',
            dispatchId: 'ctx_blocked',
            terminalHandle: 'term_blocked'
          }
        ]
      })
      expect(readBuildReviewReservation(db, KEY)).toBeDefined()

      const closed = harness(db)
      await expect(releaseSettledBuildReviewWorkspace(closed.deps, KEY, 'observe')).resolves.toBe(
        null
      )
      expect(readBuildReviewReservation(db, KEY)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('leaves a run that is still going, or another live app, alone', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      seed(db, [], { pipelineId: 'brp_going', epoch: 'epoch_now', pid: process.pid })
      const going = harness(db, { executing: ['brp_going'] })
      await expect(
        releaseSettledBuildReviewWorkspace(going.deps, KEY, 'release')
      ).resolves.toMatchObject({ owner: 'run-active' })
      const elsewhere = harness(db, { epoch: 'epoch_other_app' })
      await expect(
        releaseSettledBuildReviewWorkspace(elsewhere.deps, KEY, 'release')
      ).resolves.toMatchObject({ owner: 'other-window' })
      expect(readBuildReviewReservation(db, KEY)).toBeDefined()
    } finally {
      db.close()
    }
  })

  it('tells a claim that a settled run of this runtime no longer holds the workspace', async () => {
    const db = new OrchestrationDb(':memory:')
    try {
      seed(db, [{ id: 'ctx_gone', handle: 'term_gone' }], {
        pipelineId: 'brp_settled',
        epoch: 'epoch_now',
        pid: process.pid
      })
      const { deps } = harness(db)
      const options = await buildReviewClaimOptions(deps, KEY)
      expect(options.ownerSettled).toBe(true)
      expect([...(options.resolved ?? [])]).toEqual(['ctx_gone'])
      expect(() =>
        claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_next', 'epoch_now', process.pid, options)
      ).not.toThrow()
      const executing = harness(db, { executing: ['brp_next'] })
      await expect(buildReviewClaimOptions(executing.deps, KEY)).resolves.toMatchObject({
        ownerSettled: false
      })
    } finally {
      db.close()
    }
  })
})
