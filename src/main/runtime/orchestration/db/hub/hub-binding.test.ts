import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION } from '../contract-constants'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import { createHubTaskProjection } from '../tasks/task-store'

describe('durable omnios card binding', () => {
  const databases: OrchestrationDb[] = []
  const roots: string[] = []

  function open(path = ':memory:'): OrchestrationDb {
    const db = new OrchestrationDb(path)
    databases.push(db)
    return db
  }

  function createRun(db: OrchestrationDb, hubTaskId?: string) {
    return db.createRun({
      objective: 'Produce the requested content',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab:pane',
      hubTaskId,
      hubStateRevision: hubTaskId ? 4 : undefined
    })
  }

  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps local work unbound until explicit admission and inherits every later dispatch', () => {
    const db = open()
    const run = createRun(db)
    const task = db.createTask({ runId: run.id, spec: 'Render content' })
    expect(task.hub_task_id).toBeNull()
    db.bindRunToHub({ runId: run.id, hubTaskId: 'btk_content', hubStateRevision: 4 })
    expect(db.getTask(task.id)).toMatchObject({ hub_task_id: 'btk_content', hub_state_revision: 4 })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    expect(dispatch).toMatchObject({ hub_task_id: 'btk_content', hub_state_revision: 4 })
    expect(() => db.createTask({ runId: run.id, spec: 'Another business task' })).toThrow(
      'existing card projection'
    )
    expect(() => db.bindRunToHub({ runId: run.id, hubTaskId: 'btk_other' })).toThrow(
      'already bound'
    )
  })

  it('persists supervised dispatch identity through reopening and a successor retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'omni-hub-binding-'))
    roots.push(root)
    const path = join(root, 'orchestration.db')
    const db = open(path)
    const run = createRun(db, 'btk_content')
    const task = createHubTaskProjection(db, {
      runId: run.id,
      hubTaskId: 'btk_content',
      title: 'Render content'
    })
    const first = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 1
    })
    expect(first.worker).toMatchObject({ hub_task_id: 'btk_content', hub_state_revision: 4 })
    db.failWorkerStart(first.dispatch.id, 'launch', 'process exited')
    databases.splice(databases.indexOf(db), 1)
    db.close()
    const restored = open(path)
    expect(restored.getRun(run.id)?.hub_task_id).toBe('btk_content')
    expect(restored.getDispatchContextById(first.dispatch.id)?.hub_task_id).toBe('btk_content')
    const retry = restored.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      retryOf: first.dispatch.id,
      creator: { kind: 'system' },
      maxDepth: 1
    })
    expect(retry.dispatch.id).not.toBe(first.dispatch.id)
    expect(retry.worker).toMatchObject({ hub_task_id: 'btk_content', hub_state_revision: 4 })
  })

  it('refuses active local admission and immutable binding overrides without changing execution', () => {
    const db = open()
    const run = createRun(db)
    const task = db.createTask({ runId: run.id, spec: 'Still local' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    expect(() => db.bindRunToHub({ runId: run.id, hubTaskId: 'btk_content' })).toThrow(
      'Stop and confirm'
    )
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    const bound = createRun(db, 'btk_other')
    expect(() =>
      db.db.prepare('UPDATE runs SET hub_task_id = NULL WHERE id = ?').run(bound.id)
    ).toThrow('immutable')
  })

  it('rejects stale/conflicting projection snapshots while retaining execution status', () => {
    const db = open()
    const run = createRun(db, 'btk_content')
    const task = createHubTaskProjection(db, {
      runId: run.id,
      hubTaskId: 'btk_content',
      title: 'Render content'
    })
    db.refreshHubTaskProjection({
      taskId: task.id,
      hubTaskId: 'btk_content',
      hubStateRevision: 5,
      hubNextAction: 'Review content'
    })
    expect(() =>
      db.refreshHubTaskProjection({
        taskId: task.id,
        hubTaskId: 'btk_content',
        hubStateRevision: 4,
        hubNextAction: 'Publish'
      })
    ).toThrow('Stale')
    expect(() =>
      db.refreshHubTaskProjection({
        taskId: task.id,
        hubTaskId: 'btk_content',
        hubStateRevision: 5,
        hubNextAction: 'Publish'
      })
    ).toThrow('Conflicting')
    expect(() =>
      db.refreshHubTaskProjection({
        taskId: task.id,
        hubTaskId: 'btk_other',
        hubStateRevision: 6,
        hubNextAction: 'Publish'
      })
    ).toThrow('already be bound')
    expect(db.getTask(task.id)).toMatchObject({
      status: 'ready',
      hub_state_revision: 5,
      hub_next_action: 'Review content'
    })
    expect(db.getRun(run.id)?.hub_state_revision).toBe(5)
    expect(() =>
      db.bindRunToHub({
        runId: run.id,
        hubTaskId: 'btk_content',
        hubStateRevision: 5,
        hubNextAction: 'Publish'
      })
    ).toThrow('Conflicting')
    expect(() =>
      db.bindRunToHub({ runId: run.id, hubTaskId: 'btk_content', hubStateRevision: 4 })
    ).toThrow('Stale')
  })

  it('inherits nested worker run identity and refuses switching to an unbound run', () => {
    const db = open()
    const unbound = db.createRun({
      objective: 'Unrelated local',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab:other'
    })
    const run = createRun(db, 'btk_content')
    const task = createHubTaskProjection(db, {
      runId: run.id,
      hubTaskId: 'btk_content',
      title: 'Produce a content item'
    })
    createRootDispatch(db, task.id, 'term_worker', 'worker:pane')
    const nested = db.createRun({
      objective: 'Local execution step',
      coordinatorHandle: 'term_worker',
      coordinatorPaneKey: 'worker:pane'
    })
    expect(nested.hub_task_id).toBe('btk_content')
    expect(() =>
      db.createRun({
        objective: 'Cannot override',
        coordinatorHandle: 'term_worker',
        coordinatorPaneKey: 'worker:pane',
        hubTaskId: 'btk_other'
      })
    ).toThrow('inherit omnios card')
    expect(() =>
      db.bindRun({
        runId: unbound.id,
        coordinatorHandle: 'term_worker',
        coordinatorPaneKey: 'worker:pane'
      })
    ).toThrow('only resume work bound')
    expect(db.getCurrentRunForPane('worker:pane')?.id).toBe(nested.id)
  })

  it('keeps settled worker context bound when the same process starts a continuing run', () => {
    const db = open()
    const run = createRun(db, 'btk_content')
    const task = createHubTaskProjection(db, {
      runId: run.id,
      hubTaskId: 'btk_content',
      title: 'Produce a content item'
    })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker',
      'worker:pane',
      undefined,
      'epoch:worker:1'
    )
    db.completeDispatch(dispatch.id)
    const nested = db.createRun({
      objective: 'Continue the same work',
      coordinatorHandle: 'term_worker',
      coordinatorPaneKey: 'worker:pane',
      coordinatorProcessIncarnation: 'epoch:worker:1'
    })
    expect(nested.hub_task_id).toBe('btk_content')
  })

  it('upgrades v30 in-flight records without minting cards and reopens idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'omni-hub-upgrade-'))
    roots.push(root)
    const path = join(root, 'orchestration.db')
    const db = open(path)
    const run = createRun(db)
    const task = db.createTask({ runId: run.id, spec: 'Pre-upgrade work' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.db.exec('DROP TRIGGER trg_runs_origin_admission')
    db.db.exec('DROP TRIGGER trg_runs_origin_escalation_only')
    db.db.exec('ALTER TABLE runs DROP COLUMN origin')
    db.db.exec('DROP TRIGGER trg_tasks_inherit_hub_card')
    db.db.exec('DROP TRIGGER trg_runs_console_job_card')
    db.db.exec('DROP TRIGGER trg_runs_console_job_dispatch')
    for (const table of [
      'runs',
      'tasks',
      'dispatch_contexts',
      'worker_dispatches',
      'remote_dispatch_attachments'
    ]) {
      db.db.exec(`DROP TRIGGER trg_${table}_immutable_hub_task`)
      db.db.exec(`DROP INDEX idx_${table}_hub_task`)
      db.db.exec(`ALTER TABLE ${table} DROP COLUMN hub_task_id`)
      db.db.exec(`ALTER TABLE ${table} DROP COLUMN hub_state_revision`)
    }
    db.db.exec('ALTER TABLE tasks DROP COLUMN hub_next_action')
    db.db.exec('ALTER TABLE decision_gates DROP COLUMN decision_scope')
    db.db.pragma('user_version = 30')
    databases.splice(databases.indexOf(db), 1)
    db.close()
    const upgraded = open(path)
    expect(upgraded.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    expect(upgraded.getRun(run.id)?.hub_task_id).toBeNull()
    expect(upgraded.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'dispatched',
      hub_task_id: null
    })
    expect(upgraded.listTasks()).toHaveLength(1)
    expect(open(path).getTask(task.id)?.hub_task_id).toBeNull()
  })
})
