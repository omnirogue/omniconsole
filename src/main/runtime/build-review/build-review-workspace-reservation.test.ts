import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration/db/orchestration-db'
import { buildReviewReservationWorkerHooks } from './build-review-reservation-worker-hooks'
import { BuildReviewRpcError } from './build-review-rpc-call'
import {
  BuildReviewWorkspaceHeldError,
  unresolvedBuildReviewDispatches
} from './build-review-workspace-evidence'
import {
  bindBuildReviewRun,
  buildReviewWorkspaceKey,
  claimBuildReviewWorkspace,
  clearRejectedBuildReviewWorkerStart,
  markBuildReviewWorkerStart,
  recordBuildReviewWorkerStart,
  releaseBuildReviewWorkspace
} from './build-review-workspace-reservation'

const WORKTREE = 'repo::/wt'
const KEY = buildReviewWorkspaceKey({ path: process.cwd() })
const DEAD_PID = 2_147_483_647

describe('Build + Review workspace reservation', () => {
  it('uses the physical local path across workspace aliases and scopes remote hosts', () => {
    expect(buildReviewWorkspaceKey({ path: process.cwd(), hostId: 'local' })).toBe(
      buildReviewWorkspaceKey({ path: `${process.cwd()}/.`, hostId: 'local' })
    )
    expect(buildReviewWorkspaceKey({ path: process.cwd(), hostId: 'ssh:one' })).not.toBe(
      buildReviewWorkspaceKey({ path: process.cwd(), hostId: 'ssh:two' })
    )
    expect(buildReviewWorkspaceKey({ path: 'C:\\Repo\\X', hostId: 'ssh:windows' })).toBe(
      buildReviewWorkspaceKey({ path: 'c:/repo/x', hostId: 'ssh:windows' })
    )
    const db = new OrchestrationDb(':memory:')
    try {
      claimBuildReviewWorkspace(db, KEY, 'folder:alias-one', 'brp_first', 'epoch_1')
      expect(() =>
        claimBuildReviewWorkspace(db, KEY, 'folder:alias-two', 'brp_second', 'epoch_2')
      ).toThrow(/brp_first still owns/)
    } finally {
      db.close()
    }
  })

  it('excludes a concurrent pipeline in the same runtime, including between workers', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_first', 'epoch_1')
      expect(() => claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_second', 'epoch_1')).toThrow(
        /brp_first still owns/
      )
      expect(() => claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_second', 'epoch_2')).toThrow(
        /brp_first still owns/
      )
      expect(releaseBuildReviewWorkspace(db, KEY, 'brp_first', 'epoch_1')).toBe(true)
      expect(() =>
        claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_second', 'epoch_1')
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('does not let the same pipeline identity reclaim its active reservation', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Build',
        coordinatorHandle: 'term_same_identity',
        coordinatorPaneKey: 'pane_same_identity'
      })
      claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_first', 'epoch_1')
      bindBuildReviewRun(db, KEY, 'brp_first', 'epoch_1', run.id)
      markBuildReviewWorkerStart(db, KEY, 'brp_first', 'epoch_1')
      expect(() => claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_first', 'epoch_1')).toThrow(
        /brp_first still owns/
      )
      expect(releaseBuildReviewWorkspace(db, KEY, 'brp_first', 'epoch_1')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('reclaims an interrupted start only when it never reached a worker', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_interrupted', 'epoch_1', DEAD_PID)
      expect(() => claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_new', 'epoch_2')).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('reclaims a bound Run before its first worker, but not after missing Dispatch evidence', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Build',
        coordinatorHandle: 'term_before_worker',
        coordinatorPaneKey: 'pane_before_worker'
      })
      claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_before_worker', 'epoch_1', DEAD_PID)
      bindBuildReviewRun(db, KEY, 'brp_before_worker', 'epoch_1', run.id)
      expect(() =>
        claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_after_restart', 'epoch_2')
      ).not.toThrow()
      bindBuildReviewRun(db, KEY, 'brp_after_restart', 'epoch_2', run.id)
      markBuildReviewWorkerStart(db, KEY, 'brp_after_restart', 'epoch_2')
      expect(releaseBuildReviewWorkspace(db, KEY, 'brp_after_restart', 'epoch_2')).toBe(false)
      db.db.prepare('DELETE FROM runs WHERE id = ?').run(run.id)
      expect(releaseBuildReviewWorkspace(db, KEY, 'brp_after_restart', 'epoch_2')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('clears an in-process pre-accept failure only when no new Dispatch was accepted', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Build',
        coordinatorHandle: 'term_preflight',
        coordinatorPaneKey: 'pane_preflight'
      })
      claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_preflight', 'epoch_1')
      bindBuildReviewRun(db, KEY, 'brp_preflight', 'epoch_1', run.id)
      markBuildReviewWorkerStart(db, KEY, 'brp_preflight', 'epoch_1')
      clearRejectedBuildReviewWorkerStart(db, KEY, 'brp_preflight', 'epoch_1')
      expect(releaseBuildReviewWorkspace(db, KEY, 'brp_preflight', 'epoch_1')).toBe(true)

      claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_unknown', 'epoch_1')
      bindBuildReviewRun(db, KEY, 'brp_unknown', 'epoch_1', run.id)
      markBuildReviewWorkerStart(db, KEY, 'brp_unknown', 'epoch_1')
      db.db
        .prepare(
          "INSERT INTO tasks (id, run_id, spec, status) VALUES ('task_unknown', ?, 'build', 'dispatched')"
        )
        .run(run.id)
      db.db
        .prepare(
          "INSERT INTO dispatch_contexts (id, run_id, task_id, status) VALUES ('ctx_unknown', ?, 'task_unknown', 'pending')"
        )
        .run(run.id)
      clearRejectedBuildReviewWorkerStart(db, KEY, 'brp_unknown', 'epoch_1')
      expect(releaseBuildReviewWorkspace(db, KEY, 'brp_unknown', 'epoch_1')).toBe(false)
    } finally {
      db.close()
    }
  })

  it('keeps the in-flight fence for an ambiguous or accepted RPC error', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Build',
        coordinatorHandle: 'term_error',
        coordinatorPaneKey: 'pane_error'
      })
      const pipelineId = 'brp_error'
      const epoch = 'epoch_1'
      claimBuildReviewWorkspace(db, KEY, WORKTREE, pipelineId, epoch)
      bindBuildReviewRun(db, KEY, pipelineId, epoch, run.id)
      const hooks = buildReviewReservationWorkerHooks(
        { getOrchestrationDb: () => db, getRuntimeId: () => epoch } as never,
        { id: pipelineId } as never,
        { reservationKey: KEY } as never
      )
      hooks.beforeWorkerStart?.()
      hooks.workerStartRejected?.(
        new BuildReviewRpcError('orchestration.workerStart', 'runtime_timeout', 'timed out')
      )
      expect(releaseBuildReviewWorkspace(db, KEY, pipelineId, epoch)).toBe(false)

      db.db
        .prepare(
          "INSERT INTO tasks (id, run_id, spec, status) VALUES ('task_error', ?, 'build', 'dispatched')"
        )
        .run(run.id)
      db.db
        .prepare(
          "INSERT INTO dispatch_contexts (id, run_id, task_id, status) VALUES ('ctx_error', ?, 'task_error', 'pending')"
        )
        .run(run.id)
      hooks.workerStartRejected?.(
        new BuildReviewRpcError(
          'orchestration.workerStart',
          'invalid_argument',
          'failed after accept'
        )
      )
      expect(releaseBuildReviewWorkspace(db, KEY, pipelineId, epoch)).toBe(false)
    } finally {
      db.close()
    }
  })

  it('detects an erased earlier Dispatch even when a later Dispatch still exists', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Build',
        coordinatorHandle: 'term_rounds',
        coordinatorPaneKey: 'pane_rounds'
      })
      claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_rounds', 'epoch_1', DEAD_PID)
      bindBuildReviewRun(db, KEY, 'brp_rounds', 'epoch_1', run.id)
      for (const suffix of ['one', 'two']) {
        markBuildReviewWorkerStart(db, KEY, 'brp_rounds', 'epoch_1')
        db.db
          .prepare('INSERT INTO tasks (id, run_id, spec, status) VALUES (?, ?, ?, ?)')
          .run(`task_${suffix}`, run.id, 'build', 'completed')
        db.db
          .prepare(
            "INSERT INTO dispatch_contexts (id, run_id, task_id, status, capability_revoked_at) VALUES (?, ?, ?, ?, datetime('now'))"
          )
          .run(`ctx_${suffix}`, run.id, `task_${suffix}`, 'completed')
        db.db
          .prepare('INSERT INTO worker_dispatches (dispatch_id, state) VALUES (?, ?)')
          .run(`ctx_${suffix}`, 'succeeded')
        recordBuildReviewWorkerStart(db, KEY, 'brp_rounds', 'epoch_1', `ctx_${suffix}`)
      }
      db.db.prepare("DELETE FROM dispatch_contexts WHERE id='ctx_one'").run()
      expect(() => claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_new', 'epoch_2')).toThrow(
        /evidence is missing/
      )
    } finally {
      db.close()
    }
  })

  it('blocks a restarted runtime until the old dispatch and owned terminal settle', () => {
    const directory = mkdtempSync(join(tmpdir(), 'build-review-reservation-'))
    const path = join(directory, 'orchestration.sqlite')
    let db = new OrchestrationDb(path)
    try {
      const run = db.createRun({
        objective: 'Review the change',
        coordinatorHandle: 'term_coordinator',
        coordinatorPaneKey: 'pane_coordinator'
      })
      claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_old', 'epoch_1', DEAD_PID)
      bindBuildReviewRun(db, KEY, 'brp_old', 'epoch_1', run.id)
      markBuildReviewWorkerStart(db, KEY, 'brp_old', 'epoch_1')
      db.db
        .prepare(
          "INSERT INTO tasks (id, run_id, spec, status) VALUES ('task_old', ?, 'build', 'dispatched')"
        )
        .run(run.id)
      db.db
        .prepare(
          "INSERT INTO dispatch_contexts (id, run_id, task_id, status) VALUES ('ctx_old', ?, 'task_old', 'dispatched')"
        )
        .run(run.id)
      db.db
        .prepare(
          "INSERT INTO worker_dispatches (dispatch_id, state, worktree_id) VALUES ('ctx_old', 'ready', ?)"
        )
        .run(WORKTREE)
      db.db
        .prepare(
          "INSERT INTO worker_terminal_resources (id, origin_dispatch_id, owner_dispatch_id, worktree_id, terminal_handle) VALUES ('wtr_old', 'ctx_old', 'ctx_old', ?, 'term_worker')"
        )
        .run(WORKTREE)
      recordBuildReviewWorkerStart(db, KEY, 'brp_old', 'epoch_1', 'ctx_old')
      db.close()
      db = new OrchestrationDb(path)

      expect(() => claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_new', 'epoch_2')).toThrow(
        new RegExp(`Run ${run.id}.*ctx_old`)
      )
      db.db
        .prepare(
          "UPDATE dispatch_contexts SET status='completed', capability_revoked_at=datetime('now') WHERE id='ctx_old'"
        )
        .run()
      db.db
        .prepare("UPDATE worker_dispatches SET state='succeeded' WHERE dispatch_id='ctx_old'")
        .run()
      expect(() => claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_new', 'epoch_2')).toThrow(
        /ctx_old/
      )
      db.resetTasks()
      expect(() => claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_new', 'epoch_2')).toThrow(
        /evidence is missing/
      )
      db.db
        .prepare(
          "INSERT INTO tasks (id, run_id, spec, status) VALUES ('task_old', ?, 'build', 'completed')"
        )
        .run(run.id)
      db.db
        .prepare(
          "INSERT INTO dispatch_contexts (id, run_id, task_id, status, capability_revoked_at) VALUES ('ctx_old', ?, 'task_old', 'completed', datetime('now'))"
        )
        .run(run.id)
      db.db
        .prepare(
          "INSERT INTO worker_dispatches (dispatch_id, state, worktree_id) VALUES ('ctx_old', 'succeeded', ?)"
        )
        .run(WORKTREE)
      db.db
        .prepare(
          "INSERT INTO worker_terminal_resources (id, origin_dispatch_id, owner_dispatch_id, worktree_id, terminal_handle) VALUES ('wtr_old', 'ctx_old', 'ctx_old', ?, 'term_worker')"
        )
        .run(WORKTREE)
      db.db
        .prepare(
          "UPDATE worker_terminal_resources SET release_state='released' WHERE owner_dispatch_id='ctx_old'"
        )
        .run()
      db.db
        .prepare('UPDATE worker_dispatches SET residual_resources=? WHERE dispatch_id=?')
        .run(JSON.stringify([{ kind: 'worktree', id: 'unresolved' }]), 'ctx_old')
      expect(() => claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_new', 'epoch_2')).toThrow(
        /ctx_old/
      )
      db.db
        .prepare('UPDATE worker_dispatches SET residual_resources=? WHERE dispatch_id=?')
        .run(JSON.stringify([{ kind: 'terminal', role: 'agent', id: 'term_worker' }]), 'ctx_old')
      expect(() => claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_new', 'epoch_2')).not.toThrow()
      expect(
        db.db
          .prepare(
            'SELECT pipeline_id, runtime_epoch FROM build_review_workspace_reservations WHERE workspace_key=?'
          )
          .get(KEY)
      ).toEqual({ pipeline_id: 'brp_new', runtime_epoch: 'epoch_2' })
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it('lets a settled pipeline of this runtime give way, since its live process proves nothing', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_first', 'epoch_1')
      expect(() => claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_second', 'epoch_1')).toThrow(
        /brp_first still owns/
      )
      expect(() =>
        claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_second', 'epoch_1', process.pid, {
          ownerSettled: true
        })
      ).not.toThrow()
    } finally {
      db.close()
    }
  })

  it('names each Dispatch that still holds the workspace and counts out the ones proven gone', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Build',
        coordinatorHandle: 'term_blocked_coordinator',
        coordinatorPaneKey: 'pane_blocked_coordinator'
      })
      claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_blocked', 'epoch_1', DEAD_PID)
      bindBuildReviewRun(db, KEY, 'brp_blocked', 'epoch_1', run.id)
      markBuildReviewWorkerStart(db, KEY, 'brp_blocked', 'epoch_1')
      db.db
        .prepare(
          "INSERT INTO tasks (id, run_id, spec, status) VALUES ('task_blocked', ?, 'build', 'failed')"
        )
        .run(run.id)
      // A start that stopped at a startup prompt: failed, authority revoked, and the terminal it
      // opened never became an owned resource.
      db.db
        .prepare(
          "INSERT INTO dispatch_contexts (id, run_id, task_id, status, capability_revoked_at) VALUES ('ctx_blocked', ?, 'task_blocked', 'failed', datetime('now'))"
        )
        .run(run.id)
      db.db
        .prepare(
          'INSERT INTO worker_dispatches (dispatch_id, state, agent_terminal_handle, residual_resources) VALUES (?, ?, ?, ?)'
        )
        .run(
          'ctx_blocked',
          'failed',
          'term_blocked',
          JSON.stringify([
            { kind: 'terminal', role: 'agent', action: 'created', id: 'term_blocked' }
          ])
        )
      recordBuildReviewWorkerStart(db, KEY, 'brp_blocked', 'epoch_1', 'ctx_blocked')

      expect(unresolvedBuildReviewDispatches(db, run.id)).toEqual([
        {
          id: 'ctx_blocked',
          kind: 'terminal-open',
          terminalHandle: 'term_blocked',
          processIncarnation: null,
          hostScope: null,
          terminalReleased: false,
          mayBeWorking: false,
          // It never became an owned resource, so Release could not close it.
          releasable: false
        }
      ])
      let refusal: unknown
      try {
        claimBuildReviewWorkspace(db, KEY, WORKTREE, 'brp_next', 'epoch_2')
      } catch (error) {
        refusal = error
      }
      expect(refusal).toBeInstanceOf(BuildReviewWorkspaceHeldError)
      expect(refusal).toMatchObject({
        reservation: { pipeline_id: 'brp_blocked', run_id: run.id },
        missingEvidence: false,
        ownerLive: false
      })
      expect((refusal as BuildReviewWorkspaceHeldError).unresolved.map(({ id }) => id)).toEqual([
        'ctx_blocked'
      ])
      expect(releaseBuildReviewWorkspace(db, KEY, 'brp_blocked', 'epoch_1')).toBe(false)
      expect(
        releaseBuildReviewWorkspace(db, KEY, 'brp_blocked', 'epoch_1', new Set(['ctx_blocked']))
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('never counts a worker that has not settled as resolvable', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Build',
        coordinatorHandle: 'term_live_coordinator',
        coordinatorPaneKey: 'pane_live_coordinator'
      })
      db.db
        .prepare(
          "INSERT INTO tasks (id, run_id, spec, status) VALUES ('task_live', ?, 'build', 'dispatched')"
        )
        .run(run.id)
      db.db
        .prepare(
          "INSERT INTO dispatch_contexts (id, run_id, task_id, status) VALUES ('ctx_live', ?, 'task_live', 'dispatched')"
        )
        .run(run.id)
      db.db
        .prepare("INSERT INTO worker_dispatches (dispatch_id, state) VALUES ('ctx_live', 'ready')")
        .run()
      expect(unresolvedBuildReviewDispatches(db, run.id)).toMatchObject([
        { id: 'ctx_live', kind: 'worker-active' }
      ])
    } finally {
      db.close()
    }
  })
})
