import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'

const databases: OrchestrationDb[] = []
const directories: string[] = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createDatabase(path = ':memory:'): OrchestrationDb {
  const db = new OrchestrationDb(path)
  databases.push(db)
  return db
}

function bindTask(db: OrchestrationDb, taskId: string): void {
  db.db
    .prepare(
      'UPDATE tasks SET hub_task_id = ?, hub_state_revision = ?, hub_next_action = ? WHERE id = ?'
    )
    .run('btk_testauthority', 7, 'Await customer approval', taskId)
}

describe('hub-bound task business authority', () => {
  it('refuses direct local task creation after admission and leaves ad hoc execution usable', () => {
    const db = createDatabase()
    const run = db.createRun({
      objective: 'Admitted customer work',
      coordinatorHandle: 'term_admitted',
      coordinatorPaneKey: 'admitted:pane',
      hubTaskId: 'btk_admitted'
    })
    expect(() => db.createTask({ runId: run.id, spec: 'Invent local work' })).toThrowError(
      expect.objectContaining({ code: 'hub_task_read_only' })
    )
    expect(db.listTasks({ runId: run.id })).toEqual([])
    const local = db.createRun({
      objective: 'Ad hoc local execution',
      coordinatorHandle: 'term_local',
      coordinatorPaneKey: 'local:pane'
    })
    const first = db.createTask({ runId: local.id, spec: 'Prepare fixture' })
    const second = db.createTask({ runId: local.id, spec: 'Read fixture', deps: [first.id] })
    expect(second.status).toBe('pending')
    db.updateTaskStatus(first.id, 'completed')
    expect(db.getTask(second.id)?.status).toBe('ready')
  })

  it.each(['pending', 'ready', 'dispatched', 'blocked', 'completed', 'failed'] as const)(
    'refuses local %s and result changes without settling the executor',
    (status) => {
      const db = createDatabase()
      const task = db.createTask({ spec: 'Customer-approved order', taskTitle: 'Order supplies' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')
      bindTask(db, task.id)
      const before = db.getTask(task.id)

      expect(() => db.updateTaskStatus(task.id, status, 'local business outcome')).toThrowError(
        expect.objectContaining({
          code: 'hub_task_read_only',
          data: {
            taskId: task.id,
            hubTaskId: 'btk_testauthority',
            omniosUrl: 'https://console.example.com'
          }
        })
      )
      expect(db.getTask(task.id)).toEqual(before)
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    }
  )

  it('also refuses local mutations when only the enclosing run carries the binding', () => {
    const db = createDatabase()
    const task = db.createTask({ spec: 'Existing work admitted with its run' })
    db.db.prepare('UPDATE runs SET hub_task_id = ? WHERE id = ?').run('btk_admitted', task.run_id)

    expect(() => db.updateTaskStatus(task.id, 'completed')).toThrowError(
      expect.objectContaining({ code: 'hub_task_read_only' })
    )
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('advances execution dependencies without changing the canonical hub projection', () => {
    const db = createDatabase()
    const dependency = db.createTask({ spec: 'Local preparation' })
    const bound = db.createTask({ spec: 'Hub owns the next action', deps: [dependency.id] })
    const local = db.createTask({ spec: 'Local continuation', deps: [dependency.id] })
    bindTask(db, bound.id)
    const before = db.getTask(bound.id)

    db.updateTaskStatus(dependency.id, 'completed')

    expect(db.getTask(bound.id)).toEqual({ ...before, status: 'ready' })
    expect(db.getTask(local.id)?.status).toBe('ready')
  })
})

describe('hub-bound decision gates', () => {
  it.each([undefined, 'business'] as const)(
    'refuses a %s business gate before changing any runtime state',
    (decisionScope) => {
      const db = createDatabase()
      const task = db.createTask({ spec: 'Purchase waiting for approval' })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')
      bindTask(db, task.id)
      const before = db.getTask(task.id)

      expect(() =>
        db.createGate({ taskId: task.id, question: 'Authorize spend?', decisionScope })
      ).toThrowError(expect.objectContaining({ code: 'hub_task_read_only' }))
      expect(db.listGates()).toEqual([])
      expect(db.getTask(task.id)).toEqual(before)
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    }
  )

  it('keeps explicit execution gates durable without editing the hub projection', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omni-hub-gate-'))
    directories.push(directory)
    const path = join(directory, 'orchestration.db')
    const db = createDatabase(path)
    const run = db.createRun({
      objective: 'Bound rendering',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab:coordinator'
    })
    const task = db.createTask({ runId: run.id, spec: 'Render a content draft' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    bindTask(db, task.id)
    const before = db.getTask(task.id)

    const gate = db.createGate({
      taskId: task.id,
      question: 'Which local render engine is installed?',
      decisionScope: 'execution'
    })
    expect(db.getTask(task.id)).toEqual({ ...before, status: 'blocked' })
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')

    const reopened = createDatabase(path)
    expect(() => createRootDispatch(reopened, task.id, 'term_successor')).toThrow(/blocked/)
    expect(reopened.resolveGate(gate.id, 'Use the installed renderer')).toMatchObject({
      decision_scope: 'execution',
      status: 'resolved',
      resolution: 'Use the installed renderer'
    })
    expect(reopened.getTask(task.id)).toEqual({ ...before, status: 'ready' })
    expect(reopened.timeoutGate(gate.id)?.status).toBe('resolved')
    expect(createRootDispatch(reopened, task.id, 'term_successor')).toMatchObject({
      task_id: task.id,
      hub_task_id: 'btk_testauthority',
      status: 'dispatched'
    })
  })

  it('refuses resolving or timing out a legacy business gate after its work is admitted', () => {
    const db = createDatabase()
    const task = db.createTask({ spec: 'Legacy local task' })
    const gate = db.createGate({ taskId: task.id, question: 'Publish to customer?' })
    bindTask(db, task.id)
    const before = db.getTask(task.id)

    expect(() => db.resolveGate(gate.id, 'yes')).toThrowError(
      expect.objectContaining({ code: 'hub_task_read_only' })
    )
    expect(() => db.timeoutGate(gate.id)).toThrowError(
      expect.objectContaining({ code: 'hub_task_read_only' })
    )
    expect(db.getGate(gate.id)).toEqual(gate)
    expect(db.getTask(task.id)).toEqual(before)
  })

  it('times out an execution gate without changing the hub projection', () => {
    const db = createDatabase()
    const task = db.createTask({ spec: 'Bound execution timeout' })
    bindTask(db, task.id)
    const before = db.getTask(task.id)
    const gate = db.createGate({
      taskId: task.id,
      question: 'Select a local worker step',
      decisionScope: 'execution'
    })

    expect(db.timeoutGate(gate.id)?.status).toBe('timeout')
    expect(db.getTask(task.id)).toEqual({ ...before, status: 'blocked' })
  })
})
