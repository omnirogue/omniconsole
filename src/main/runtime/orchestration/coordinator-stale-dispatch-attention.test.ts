import { afterEach, describe, expect, it } from 'vitest'
import { warnStaleDispatches, type StaleDispatchAttention } from './coordinator-task-dispatch'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

const databases: OrchestrationDb[] = []
afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close()
  }
})

const NOW = Date.parse('2026-09-15T12:00:00.000Z')

function staleDispatch(heartbeat: string) {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const task = db.createTask({ spec: 'work', taskTitle: 'Render trailer' })
  const dispatch = createRootDispatch(db, task.id, 'term_stale')
  setTimes(db, dispatch.id, heartbeat)
  return { db, task, dispatch }
}

function setTimes(db: OrchestrationDb, dispatchId: string, heartbeat: string): void {
  const sqlite = (
    db as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }
  ).db
  sqlite
    .prepare('UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?')
    .run('2026-09-15 11:00:00', heartbeat, dispatchId)
}

describe('stale dispatch attention', () => {
  it('signals a silent worker once with its task title and minutes silent, without failing it', () => {
    const { db, task, dispatch } = staleDispatch('2026-09-15 11:30:00')
    const signals: StaleDispatchAttention[] = []
    const logs: string[] = []

    for (let tick = 0; tick < 3; tick++) {
      warnStaleDispatches(db, (line) => logs.push(line), {
        now: NOW,
        onAttention: (signal) => signals.push(signal)
      })
    }

    expect(signals).toEqual([
      {
        dispatchId: dispatch.id,
        taskId: task.id,
        taskTitle: 'Render trailer',
        minutesSilent: 30,
        message:
          '"Render trailer" has been silent for 30 min. Check its terminal: it may be waiting on a prompt.'
      }
    ])
    expect(logs).toHaveLength(1)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
  })

  it('signals again after a heartbeat is followed by another silence', () => {
    const { db, dispatch } = staleDispatch('2026-09-15 11:30:00')
    const signals: StaleDispatchAttention[] = []
    const onAttention = (signal: StaleDispatchAttention) => signals.push(signal)
    warnStaleDispatches(db, () => {}, { now: NOW, onAttention })

    setTimes(db, dispatch.id, '2026-09-15T11:45:00.000Z')
    warnStaleDispatches(db, () => {}, { now: NOW, onAttention })

    expect(signals.map((signal) => signal.minutesSilent)).toEqual([30, 15])
  })

  it('still raises the attention signal after a log-only scan saw the same silence', () => {
    const { db, task } = staleDispatch('2026-09-15 11:30:00')
    const signals: StaleDispatchAttention[] = []
    const logs: string[] = []

    // The coordinator's own tick scans log-only; a run-scoped scan follows it.
    warnStaleDispatches(db, (line) => logs.push(line), { now: NOW })
    warnStaleDispatches(db, (line) => logs.push(line), {
      now: NOW,
      runId: task.run_id,
      onAttention: (signal) => signals.push(signal)
    })

    expect(signals.map((signal) => signal.message)).toEqual([
      '"Render trailer" has been silent for 30 min. Check its terminal: it may be waiting on a prompt.'
    ])
    // The log half stays deduped across both scans.
    expect(logs).toHaveLength(1)
  })

  it('ignores dispatches of other runs', () => {
    const { db } = staleDispatch('2026-09-15 11:30:00')
    const signals: StaleDispatchAttention[] = []

    warnStaleDispatches(db, () => {}, {
      now: NOW,
      runId: 'run_someone_else',
      onAttention: (signal) => signals.push(signal)
    })

    expect(signals).toEqual([])
  })
})
