import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db/orchestration-db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { createHubTaskProjection } from './db/tasks/task-store'
import { recordHubExecutionObservation } from './hub-execution-observation'
import { getHubWorkerExitObservations } from './hub-worker-exit-observation'

describe('hub execution observations in the durable message journal', () => {
  const databases: OrchestrationDb[] = []
  const directories: string[] = []

  function open(path = ':memory:') {
    const db = new OrchestrationDb(path)
    databases.push(db)
    return db
  }

  function createRun(db: OrchestrationDb, hubTaskId: string | undefined = 'btk_content') {
    return db.createRun({
      objective: 'Create content',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:pane_coord',
      hubTaskId
    })
  }

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not publish or mint work for an unbound or unknown run', () => {
    const db = open()
    const run = db.createRun({
      objective: 'Ad hoc work',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:pane_coord'
    })
    expect(recordHubExecutionObservation(db, { runId: run.id, event: 'run_started' })).toBeNull()
    expect(recordHubExecutionObservation(db, { runId: 'missing', event: 'run_started' })).toBeNull()
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(db.getRun(run.id)?.hub_task_id).toBeNull()
  })

  it('persists one stable audit cursor across restarts without entering an agent inbox', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omni-observation-'))
    directories.push(directory)
    const path = join(directory, 'orchestration.db')
    const db = open(path)
    const run = createRun(db)
    const first = recordHubExecutionObservation(db, { runId: run.id, event: 'run_started' })!
    expect(first.fresh).toBe(true)
    const rows = db.db.prepare('SELECT sequence, delivery_contract FROM messages').all()
    expect(rows).toEqual([{ sequence: expect.any(Number), delivery_contract: 'audit_only' }])
    expect(first.observation.journalCursor).toBe(
      `orchestration:${run.id}:messages:${(rows[0] as { sequence: number }).sequence}`
    )
    expect(db.getUnreadMessages(`run:${run.id}`, ['status'])).toEqual([])
    databases.splice(databases.indexOf(db), 1)
    db.close()
    const restored = open(path)
    expect(
      recordHubExecutionObservation(restored, { runId: run.id, event: 'run_started' })
    ).toEqual({
      fresh: false,
      observation: first.observation
    })
    expect(restored.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({
      count: 1
    })
  })

  it('requires a checkpoint receipt and preserves distinct committed checkpoints', () => {
    const db = open()
    const run = createRun(db)
    expect(() =>
      recordHubExecutionObservation(db, {
        runId: run.id,
        event: 'checkpoint_written'
      })
    ).toThrow('committed checkpoint')
    const first = recordHubExecutionObservation(db, {
      runId: run.id,
      event: 'checkpoint_written',
      checkpointCursor: 'session:epoch:10'
    })!
    const second = recordHubExecutionObservation(db, {
      runId: run.id,
      event: 'checkpoint_written',
      checkpointCursor: 'session:epoch:11'
    })!
    expect(second.observation.journalCursor).not.toBe(first.observation.journalCursor)
    expect(
      recordHubExecutionObservation(db, {
        runId: run.id,
        event: 'checkpoint_written',
        checkpointCursor: 'session:epoch:10'
      })?.fresh
    ).toBe(false)
  })

  it('rejects cross-run dispatches and does not call an assignment-only stop a process stop', () => {
    const db = open()
    const run = createRun(db)
    const task = createHubTaskProjection(db, {
      runId: run.id,
      hubTaskId: 'btk_content',
      title: 'Compose reply'
    })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    const other = db.createRun({
      objective: 'Independent work',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:pane_other',
      hubTaskId: 'btk_other'
    })
    expect(() =>
      recordHubExecutionObservation(db, {
        runId: other.id,
        workerDispatchId: dispatch.id,
        event: 'worker_exit'
      })
    ).toThrow('binding differs')
    db.beginWorkerStop(dispatch.id, 'runtime')
    expect(() =>
      recordHubExecutionObservation(db, {
        runId: run.id,
        workerDispatchId: dispatch.id,
        event: 'stop_confirmed'
      })
    ).toThrow('not confirmed')
    expect(() =>
      recordHubExecutionObservation(db, {
        runId: run.id,
        event: 'worker_exit'
      })
    ).toThrow('exact worker dispatch')
  })

  it('selects completed workers by the exact exited process without changing business state', () => {
    const db = open()
    const run = createRun(db)
    const task = createHubTaskProjection(db, {
      runId: run.id,
      hubTaskId: 'btk_content',
      title: 'Compose reply'
    })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker',
      'tab:pane',
      undefined,
      'pty:old'
    )
    db.completeDispatch(dispatch.id)
    const before = db.getTask(task.id)
    expect(getHubWorkerExitObservations(db, 'pty:replacement', 'Process exited')).toEqual([])
    const observations = getHubWorkerExitObservations(db, 'pty:old', 'Process exited')
    expect(observations).toEqual([
      {
        runId: run.id,
        workerDispatchId: dispatch.id,
        event: 'worker_exit',
        detail: 'Process exited'
      }
    ])
    expect(recordHubExecutionObservation(db, observations[0])?.fresh).toBe(true)
    expect(db.getTask(task.id)).toEqual(before)
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
  })
})
