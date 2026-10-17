import { afterEach, describe, expect, it } from 'vitest'
import { evaluateDagConvergence } from './coordinator-dag-convergence'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { DEPENDENCY_FAILED_REASON_PREFIX } from './db/tasks/task-dependency-stranding'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

function createDb(): OrchestrationDb {
  const database = new OrchestrationDb(':memory:')
  databases.push(database)
  return database
}

function graph(db: OrchestrationDb) {
  const root = db.createTask({ spec: 'root', taskTitle: 'Root build' })
  const child = db.createTask({ spec: 'child', deps: [root.id] })
  const grandchild = db.createTask({ spec: 'grandchild', deps: [child.id] })
  const sibling = db.createTask({ spec: 'independent' })
  return { root, child, grandchild, sibling }
}

describe('failed dependency propagation', () => {
  it('strands every transitive dependent in the failing transaction and names the failed task', () => {
    const db = createDb()
    const { root, child, grandchild, sibling } = graph(db)

    db.updateTaskStatus(root.id, 'failed')

    for (const id of [child.id, grandchild.id]) {
      const task = db.getTask(id)!
      expect(task.status).toBe('blocked')
      expect(task.result).toBe(
        `${DEPENDENCY_FAILED_REASON_PREFIX} "Root build" failed. Retry it to continue.`
      )
    }
    expect(db.getTask(sibling.id)?.status).toBe('ready')
  })

  it('strands dependents when a circuit break fails the dependency', () => {
    const db = createDb()
    const { root, child } = graph(db)
    for (let attempt = 0; attempt < 3; attempt++) {
      const dispatch = createRootDispatch(db, root.id, 'term_a')
      db.failDispatch(dispatch.id, 'timeout')
    }

    expect(db.getTask(root.id)?.status).toBe('failed')
    expect(db.getTask(child.id)?.status).toBe('blocked')
  })

  it('strands dependents when the stall watchdog fails a silent worker', () => {
    const db = createDb()
    const { root, child } = graph(db)
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: root.id,
      startOptions: { agent: 'codex', timeoutMs: 1 }
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: 'term_worker' }]
    })
    db.markWorkerDispatchReady(started.dispatch.id)

    db.failReadyWorkerDispatch({
      dispatchId: started.dispatch.id,
      stage: 'activity_timeout',
      reason: 'stalled'
    })

    expect(db.getTask(root.id)?.status).toBe('failed')
    expect(db.getTask(child.id)).toMatchObject({
      status: 'blocked',
      result: `${DEPENDENCY_FAILED_REASON_PREFIX} "Root build" failed. Retry it to continue.`
    })
  })

  it('strands dependents when a worker reports failure', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'reported' })
    const dependent = db.createTask({ spec: 'after report', deps: [task.id] })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    db.updateTaskStatus(task.id, 'dispatched')

    db.settleWorkerReport({
      taskId: task.id,
      dispatchId: dispatch.id,
      outcome: 'failed',
      result: 'tests failed'
    })

    expect(db.getTask(task.id)?.status).toBe('failed')
    expect(db.getTask(dependent.id)?.status).toBe('blocked')
  })

  it('returns stranded dependents to pending when the failed task is reset for another attempt', () => {
    const db = createDb()
    const { root, child } = graph(db)
    db.updateTaskStatus(root.id, 'failed')

    db.updateTaskStatus(root.id, 'ready')

    expect(db.getTask(child.id)).toMatchObject({ status: 'pending', result: null })
  })

  it('restores stranded dependents to pending, then ready, when the failed task is retried', () => {
    const db = createDb()
    const { root, child, grandchild } = graph(db)
    db.updateTaskStatus(root.id, 'failed')

    db.updateTaskStatus(root.id, 'completed')

    expect(db.getTask(child.id)).toMatchObject({ status: 'ready', result: null })
    expect(db.getTask(grandchild.id)).toMatchObject({ status: 'pending', result: null })
  })

  it('leaves a gate-blocked dependent to its gate', () => {
    const db = createDb()
    const { root, child } = graph(db)
    db.updateTaskStatus(child.id, 'blocked')

    db.updateTaskStatus(root.id, 'failed')

    expect(db.getTask(child.id)).toMatchObject({ status: 'blocked', result: null })
  })
})

describe('DAG convergence with failed dependencies', () => {
  it('reports a run stuck once only stranded work remains', () => {
    const db = createDb()
    const { root, sibling } = graph(db)
    const logs: string[] = []
    db.updateTaskStatus(root.id, 'failed')
    expect(evaluateDagConvergence(db, (line) => logs.push(line))).toBe('active')

    db.updateTaskStatus(sibling.id, 'completed')

    expect(evaluateDagConvergence(db, (line) => logs.push(line))).toBe('stuck')
    expect(logs.at(-1)).toMatch(/2 task\(s\) can never start because a dependency failed/)
  })

  it('treats a pending dependent of a failure written elsewhere as stranded', () => {
    const db = createDb()
    const { root, child } = graph(db)
    const sqlite = (
      db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }
    ).db
    sqlite.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(root.id)
    sqlite
      .prepare("UPDATE tasks SET status = 'completed' WHERE id NOT IN (?, ?, ?)")
      .run(root.id, child.id, db.listTasks().find((task) => task.spec === 'grandchild')!.id)

    expect(evaluateDagConvergence(db, () => {})).toBe('stuck')
  })

  it('keeps a run waiting on a person active', () => {
    const db = createDb()
    const task = db.createTask({ spec: 'gated' })
    db.updateTaskStatus(task.id, 'blocked')
    const logs: string[] = []

    expect(evaluateDagConvergence(db, (line) => logs.push(line))).toBe('active')
    expect(logs.at(-1)).toMatch(/Resolve decision gates/)
  })
})
