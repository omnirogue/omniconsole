import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'

describe('orchestration worker terminal backfill', () => {
  let db: OrchestrationDb
  let dbOpen = false
  let activeRunId: string

  const coordinatorPaneKey = 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const workerPaneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

  function setup(): void {
    db = new OrchestrationDb(':memory:')
    dbOpen = true
    activeRunId = db.createRun({
      objective: 'Terminal backfill test Run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey
    }).id
  }

  afterEach(() => {
    if (dbOpen) {
      dbOpen = false
      db.close()
    }
  })

  it('backfills legacy terminal resources as retained external evidence', () => {
    setup()
    const insertLegacy = (dispatchId: string, handle: string, paneKey: string | null): void => {
      const task = db.createTask({ spec: `legacy ${dispatchId}`, runId: activeRunId })
      const raw = (
        db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
      ).db
      raw
        .prepare(
          `INSERT INTO dispatch_contexts (id, run_id, task_id, contract_version, assignee_pane_key, process_incarnation, status)
           VALUES (?, ?, ?, 2, ?, ?, 'completed')`
        )
        .run(dispatchId, activeRunId, task.id, paneKey, paneKey ? `inc:${dispatchId}` : null)
      raw
        .prepare(
          `INSERT INTO worker_dispatches (dispatch_id, state, stage, agent_terminal_handle, residual_resources)
           VALUES (?, 'succeeded', 'settled', ?, ?)`
        )
        .run(
          dispatchId,
          handle,
          JSON.stringify([{ kind: 'terminal', role: 'agent', action: 'created', id: handle }])
        )
    }
    insertLegacy('ctx_unique', 'term_unique', 'tab_u:leaf_u')
    insertLegacy('ctx_shared_a', 'term_shared', 'tab_s:leaf_s')
    insertLegacy('ctx_shared_b', 'term_shared', 'tab_s:leaf_s')
    insertLegacy('ctx_no_identity', 'term_bare', null)
    ;(
      db as unknown as { backfillWorkerTerminalResources: () => void }
    ).backfillWorkerTerminalResources()

    for (const ambiguous of ['ctx_unique', 'ctx_shared_a', 'ctx_shared_b', 'ctx_no_identity']) {
      expect(db.getWorkerTerminalResourceByOwner(ambiguous)).toMatchObject({
        ownership_state: 'external',
        release_state: 'retained',
        retained_reason: 'legacy_ambiguous'
      })
    }
  })

  it('backfills a legacy creator plus explicit reuser as ambiguous', () => {
    setup()
    const insertLegacy = (dispatchId: string, action: 'created' | 'reused'): void => {
      const task = db.createTask({ spec: dispatchId, runId: activeRunId })
      const raw = (
        db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
      ).db
      raw
        .prepare(
          `INSERT INTO dispatch_contexts (id, run_id, task_id, contract_version, assignee_pane_key, process_incarnation, status)
           VALUES (?, ?, ?, 2, ?, ?, ?)`
        )
        .run(
          dispatchId,
          activeRunId,
          task.id,
          workerPaneKey,
          'runtime_test:term_worker:1',
          action === 'created' ? 'completed' : 'dispatched'
        )
      raw
        .prepare(
          `INSERT INTO worker_dispatches (dispatch_id, state, stage, agent_terminal_handle, residual_resources)
           VALUES (?, ?, 'legacy', 'term_worker', ?)`
        )
        .run(
          dispatchId,
          action === 'created' ? 'succeeded' : 'ready',
          JSON.stringify([{ kind: 'terminal', role: 'agent', action, id: 'term_worker' }])
        )
    }
    insertLegacy('ctx_creator', 'created')
    insertLegacy('ctx_reuser', 'reused')
    ;(
      db as unknown as { backfillWorkerTerminalResources: () => void }
    ).backfillWorkerTerminalResources()

    for (const dispatchId of ['ctx_creator', 'ctx_reuser']) {
      expect(db.getWorkerTerminalResourceByOwner(dispatchId)).toMatchObject({
        ownership_state: 'external',
        release_state: 'retained',
        retained_reason: 'legacy_ambiguous'
      })
    }
  })
})
