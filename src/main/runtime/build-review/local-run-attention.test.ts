import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalRunSnapshot } from '../../../shared/local-run-types'
import type { OrcaRuntimeService } from '../omni-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { createRootDispatch } from '../orchestration/db/root-dispatch-test-fixture'
import { setRuntimeDesktopSurface, type RuntimeDesktopSurface } from '../runtime-desktop-surface'
import {
  localRunStrandedSuffix,
  localRunStuckMessage,
  startLocalRunStaleWatch
} from './local-run-attention'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function snapshotWith(nodes: { id: string; state: string; taskId?: string }[], runId: string) {
  return { runId, nodes, events: [], updatedAt: 0 } as unknown as LocalRunSnapshot
}

describe('local run stale watch', () => {
  it('names the silent node once on the card and in one desktop notification', () => {
    const db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work', taskTitle: 'Cut trailer' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    ;(db as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db
      .prepare('UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?')
      .run('2000-01-01 00:00:00', '2000-01-01 00:00:00', dispatch.id)
    const showNotification = vi.fn(() => true)
    setRuntimeDesktopSurface({ showNotification } as unknown as RuntimeDesktopSurface)
    const changed = vi.fn()
    const snapshot = snapshotWith([{ id: 'cut', state: 'running', taskId: task.id }], task.run_id)
    const watch = startLocalRunStaleWatch(
      { runtime: { getOrchestrationDb: () => db } as unknown as OrcaRuntimeService, changed },
      snapshot
    )
    cleanups.push(() => {
      watch.stop()
      setRuntimeDesktopSurface(null)
      db.close()
    })

    watch.scan()
    watch.scan()

    expect(snapshot.events).toEqual([
      expect.objectContaining({
        kind: 'error',
        node: 'cut',
        text: expect.stringMatching(/^"Cut trailer" has been silent for \d+ min\./)
      })
    ])
    expect(showNotification).toHaveBeenCalledTimes(1)
    expect(showNotification).toHaveBeenCalledWith({
      title: 'An agent may be stuck',
      body: snapshot.events[0]!.text
    })
    expect(changed).toHaveBeenCalledTimes(1)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
  })
})

describe('local run stranded wording', () => {
  it('names the nodes that never started', () => {
    const snapshot = snapshotWith(
      [
        { id: 'broken', state: 'failed' },
        { id: 'later', state: 'waiting' },
        { id: 'queued', state: 'queued' },
        { id: 'done', state: 'completed' }
      ],
      'run'
    )
    expect(localRunStrandedSuffix(snapshot)).toBe(
      '. Not started because a dependency failed: later, queued'
    )
    expect(localRunStuckMessage(snapshot)).toBe(
      'The run cannot continue: later, queued depend on work that failed.'
    )
    expect(localRunStrandedSuffix(snapshotWith([], 'run'))).toBe('')
  })
})
