import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const paneKey = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function fixture() {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'Durable close phase',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  })
  const task = db.createTask({ spec: 'Finish work', runId: run.id })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: { agent: 'codex' }
  })
  db.prepareStartingWorkerAuthority({
    dispatchId: dispatch.id,
    handle: 'term_worker',
    paneKey,
    processIncarnation: 'runtime:pty:1',
    worktreeId: 'folder:workspace',
    setupState: 'not_applicable',
    effects: [],
    terminalOwnership: 'created',
    hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
  })
  db.markWorkerDispatchReady(dispatch.id)
  db.settleWorkerReport({
    taskId: task.id,
    dispatchId: dispatch.id,
    outcome: 'succeeded',
    result: 'done'
  })
  const resource = db.requestWorkerTerminalRelease(dispatch.id).resource!
  const commit = (content = JSON.stringify({ lines: ['saved'] })) =>
    db.commitWorkerTerminalArchiveForRelease({
      dispatchId: dispatch.id,
      resourceId: resource.id,
      kind: 'terminal_tail',
      content,
      archiveSource: 'terminal',
      archiveStatus: 'captured'
    })
  return { db, dispatchId: dispatch.id, resource, commit }
}

describe('durable worker close phase', () => {
  let db: OrchestrationDb | undefined
  afterEach(() => db?.close())

  it('allows Keep before close and refuses close issuance after Keep wins', () => {
    const f = fixture()
    db = f.db
    f.commit()
    expect(db.getWorkerTerminalReleaseClosePhase(f.dispatchId, f.resource.id)).toBe('prepared')
    expect(db.retainWorkerTerminalResource(f.dispatchId, true).disposition).toBe('retained')
    expect(db.markWorkerTerminalReleaseCloseIssued(f.dispatchId, f.resource.id)).toBe(false)
  })

  it('refuses close issuance when user takeover wins after archive preparation', () => {
    const f = fixture()
    db = f.db
    f.commit()
    expect(db.markWorkerTerminalUserOwned(paneKey)).toBe(1)
    expect(db.markWorkerTerminalReleaseCloseIssued(f.dispatchId, f.resource.id)).toBe(false)
    expect(db.getWorkerTerminalResource(f.resource.id)).toMatchObject({
      ownership_state: 'user_owned',
      release_state: 'retained'
    })
  })

  it('preserves issued through retry and rejects Keep or takeover after a runtime restart', () => {
    const f = fixture()
    db = f.db
    f.commit()
    expect(db.markWorkerTerminalReleaseCloseIssued(f.dispatchId, f.resource.id)).toBe(true)
    // A fresh runtime has no in-memory close marker; only this database proves issuance.
    expect(db.retainWorkerTerminalResource(f.dispatchId, true).disposition).toBe(
      'release_committed'
    )
    expect(db.markWorkerTerminalUserOwned(paneKey)).toBe(0)
    f.commit(JSON.stringify({ lines: ['retry capture'] }))
    expect(db.getWorkerTerminalReleaseClosePhase(f.dispatchId, f.resource.id)).toBe('issued')
    db.markWorkerTerminalReleaseUnknown(f.resource.id, 'close result was unverified')
    db.requestWorkerTerminalRelease(f.dispatchId)
    expect(db.retainWorkerTerminalResource(f.dispatchId, true).disposition).toBe(
      'release_committed'
    )
    expect(db.markWorkerTerminalUserOwned(paneKey)).toBe(0)
  })

  it('rewinds an issued phase to prepared only before any close went out', () => {
    const f = fixture()
    db = f.db
    f.commit()
    // Nothing to rewind while the phase is still prepared.
    expect(db.rewindWorkerTerminalReleaseCloseToPrepared(f.dispatchId, f.resource.id)).toBe(false)
    expect(db.markWorkerTerminalReleaseCloseIssued(f.dispatchId, f.resource.id)).toBe(true)
    expect(db.rewindWorkerTerminalReleaseCloseToPrepared(f.dispatchId, f.resource.id)).toBe(true)
    expect(db.getWorkerTerminalReleaseClosePhase(f.dispatchId, f.resource.id)).toBe('prepared')
    // Keep is possible again: the late review hold found no close had been sent.
    expect(db.retainWorkerTerminalResource(f.dispatchId, true).disposition).toBe('retained')
    expect(db.rewindWorkerTerminalReleaseCloseToPrepared(f.dispatchId, f.resource.id)).toBe(false)
  })

  it('never rewinds an unknown close result or a changed identity', () => {
    const f = fixture()
    db = f.db
    f.commit()
    expect(db.markWorkerTerminalReleaseCloseIssued(f.dispatchId, f.resource.id)).toBe(true)
    db.markWorkerTerminalReleaseUnknown(f.resource.id, 'close result was unverified')
    expect(db.rewindWorkerTerminalReleaseCloseToPrepared(f.dispatchId, f.resource.id)).toBe(false)
    db.requestWorkerTerminalRelease(f.dispatchId)
    db.db
      .prepare('UPDATE worker_terminal_resources SET process_incarnation = ? WHERE id = ?')
      .run('runtime:pty:2', f.resource.id)
    expect(db.rewindWorkerTerminalReleaseCloseToPrepared(f.dispatchId, f.resource.id)).toBe(false)
  })

  it('keeps legacy and mismatched phases unknown without granting retention', () => {
    const f = fixture()
    db = f.db
    db.storeWorkerTerminalArchive({
      dispatchId: f.dispatchId,
      resourceId: f.resource.id,
      kind: 'terminal_tail',
      content: JSON.stringify({ lines: ['legacy'] })
    })
    f.commit()
    expect(db.getWorkerTerminalReleaseClosePhase(f.dispatchId, f.resource.id)).toBe('unknown')
    expect(db.retainWorkerTerminalResource(f.dispatchId, true).disposition).toBe(
      'release_committed'
    )
    expect(db.markWorkerTerminalReleaseCloseIssued(f.dispatchId, f.resource.id)).toBe(true)
    db.db
      .prepare('UPDATE worker_terminal_resources SET process_incarnation = ? WHERE id = ?')
      .run('runtime:pty:2', f.resource.id)
    f.commit(JSON.stringify({ lines: ['changed identity retry'] }))
    expect(db.getWorkerTerminalReleaseClosePhase(f.dispatchId, f.resource.id)).toBe('unknown')
    expect(db.markWorkerTerminalReleaseCloseIssued(f.dispatchId, f.resource.id)).toBe(false)
  })
})
