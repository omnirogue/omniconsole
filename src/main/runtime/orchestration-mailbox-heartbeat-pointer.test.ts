import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from './orchestration/db'
import type { MessageType } from './orchestration/types'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  pointerCount,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

function insertRunMessage(db: OrchestrationDb, runId: string, type: MessageType) {
  return db.insertMessage({
    from: 'term_worker',
    to: `run:${runId}`,
    subject: type,
    type,
    runId,
    deliveryContract: 'current_delivery'
  })
}

describe('orchestration heartbeat pointers', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('lets heartbeats ride along with the next actionable message instead of waking the coordinator', async () => {
    vi.useFakeTimers()
    const db = createDatabase('omni-mailbox-heartbeat-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Heartbeat Run')
    const heartbeat = insertRunMessage(db, run.id, 'heartbeat')

    await driveToLiveIdle(harness.runtime)
    expect(pointerCount(harness.write)).toBe(0)
    expect(db.getMessageById(heartbeat.id)).toMatchObject({ read: 0, delivered_at: null })

    insertRunMessage(db, run.id, 'escalation')
    harness.runtime.notifyMessageArrived(`run:${run.id}`, 'escalation')
    await vi.advanceTimersByTimeAsync(0)

    expect(pointerCount(harness.write)).toBe(1)
    expect(harness.write).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('You have 2 orchestration messages')
    )
    expect(await checkBoundMailbox(harness.runtime)).toMatchObject({ runId: run.id, count: 2 })
    db.close()
  })

  it('still wakes the coordinator when a full page of heartbeats precedes actionable mail', async () => {
    vi.useFakeTimers()
    const db = createDatabase('omni-mailbox-heartbeat-page-')
    const harness = createRuntime(db)
    const run = createBoundRun(db, 'Heartbeat backlog Run')
    for (let index = 0; index < 50; index++) {
      insertRunMessage(db, run.id, 'heartbeat')
    }
    insertRunMessage(db, run.id, 'worker_done')

    await driveToLiveIdle(harness.runtime)

    expect(pointerCount(harness.write)).toBe(1)
    db.close()
  })
})
