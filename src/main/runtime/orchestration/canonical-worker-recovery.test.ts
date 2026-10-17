import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setAppEnvironment } from '../../../shared/app-environment'
import { runProcess } from '../../../shared/child-process/run-process'
import { forceTerminatePosixProcessGroup } from '../../../shared/child-process/process-tree-termination'
import {
  writeTerminalHistoryExactExit,
  type TerminalHistoryExactExit
} from '../../daemon/terminal-history-exact-exit'
import { OrchestrationDb } from './db'
import { createHubTaskProjection } from './db/tasks/task-store'
import { observeCanonicalWorker } from './canonical-worker-observation'
import { readCanonicalWorkerOutput } from './canonical-worker-output'
import { createBoundedTerminalStream } from '../../../shared/terminal-stream'
import { createWorkerOutputSourceIdentity, encodeWorkerOutputCursor } from './worker-output-cursor'
import {
  readCanonicalWorkerRecord,
  updateCanonicalWorkerRecord,
  type CanonicalWorkerRecord
} from './canonical-worker-record'

vi.mock('../../../shared/child-process/run-process', () => ({ runProcess: vi.fn() }))
vi.mock('../../../shared/child-process/process-tree-termination', () => ({
  forceTerminatePosixProcessGroup: vi.fn()
}))

describe.skipIf(process.platform === 'win32')('canonical worker journal recovery', () => {
  const identity = {
    pid: 424242,
    started_at: 'Wed Sep 9 12:00:00 2026',
    runner_instance: 'runner_recovery'
  }
  const sessionId = 'pty_recovery'
  const incarnationId = 'recovery_incarnation'
  const observedAt = '2026-09-09T12:10:00.000Z'
  let directory: string
  let dbPath: string
  let db: OrchestrationDb
  let dispatchId: string
  let taskId: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'canonical-worker-recovery-'))
    dbPath = join(directory, 'orchestration.db')
    setAppEnvironment({
      getPath: () => directory,
      getAppPath: () => process.cwd(),
      getVersion: () => '0.0.0-test',
      isPackaged: () => false,
      onWillQuit: () => {},
      exit: () => {},
      getAppMetrics: () => []
    })
    vi.mocked(runProcess).mockReset().mockResolvedValue({
      code: 1,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    vi.mocked(forceTerminatePosixProcessGroup).mockReset().mockResolvedValue(true)
    db = new OrchestrationDb(dbPath)
    const run = db.createRun({
      objective: 'Recover canonical execution evidence',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey: 'tab_coordinator:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    db.bindRunToHub({ runId: run.id, hubTaskId: 'btk_recovery', hubStateRevision: 1 })
    taskId = createHubTaskProjection(db, {
      runId: run.id,
      hubTaskId: 'btk_recovery',
      title: 'Recover exact process evidence'
    }).id
    const canonical: CanonicalWorkerRecord = {
      binding: { job_id: 'job_recovery', task_id: 'btk_recovery', attempt: 1 },
      bindingHash: 'binding_hash',
      launchDigest: 'launch_digest',
      gateDirectory: join(directory, 'gate'),
      gateNonce: 'gate_nonce',
      runGeneration: run.consumer_generation,
      processIdentity: identity,
      phase: 'released',
      terminalProof: null
    }
    dispatchId = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 3,
      taskId,
      runtimeEpoch: 'runtime_before_disconnect',
      startOptions: { canonical }
    }).dispatch.id
    db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: 'term_recovery',
      paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: `${sessionId}:${incarnationId}`,
      worktreeId: 'folder:recovery',
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(dispatchId)
  })

  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  function writeExit(changes: Partial<TerminalHistoryExactExit> = {}): void {
    expect(
      writeTerminalHistoryExactExit(join(directory, 'terminal-history'), {
        version: 1,
        sessionId,
        incarnationId,
        pid: identity.pid,
        observedAt,
        exitCode: 0,
        exitCause: { kind: 'exited', exitCode: 0 },
        ...changes
      })
    ).toBe(true)
  }

  function reopen(): void {
    db.close()
    db = new OrchestrationDb(dbPath)
  }

  function outputCursor(position: number, sourceIdentity?: string): string {
    return encodeWorkerOutputCursor(
      dispatchId,
      'terminal',
      sourceIdentity ??
        createWorkerOutputSourceIdentity([
          'terminal',
          `${sessionId}:${incarnationId}`,
          'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        ]),
      position
    )
  }

  function readOutput(cursor?: string | number) {
    return readCanonicalWorkerOutput({
      db,
      dispatchId,
      terminalHandle: 'term_recovery',
      workerState: 'ready',
      source: 'terminal',
      cursor
    })
  }

  it('recovers final unterminated output at the same live cursor after runtime database restart', () => {
    const stream = createBoundedTerminalStream()
    stream.append('progress\n{"verification":"accepted"}')
    stream.finish()
    writeExit({ terminalStream: stream.snapshot() })
    const cursor = outputCursor(1)
    reopen()
    const page = readOutput(cursor)!
    expect(page.terminal.tail).toEqual(['{"verification":"accepted"}'])
    expect(page.terminal).toMatchObject({ oldestCursor: '0', nextCursor: '2', latestCursor: '2' })
    expect(page.cursor).toBe(outputCursor(2))
    expect(readOutput(page.cursor!)?.terminal.tail).toEqual([])
    expect(readOutput(page.cursor!)?.cursor).toBe(page.cursor)
    // Reading execution evidence neither runs a provider nor accepts the Hub task.
    expect(db.getTask(taskId)?.status).toBe('dispatched')
    expect(readCanonicalWorkerRecord(db, dispatchId)?.terminalProof).toBeNull()
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('reports bounded retained history without changing the absolute cursor', () => {
    writeExit({
      terminalStream: {
        version: 1,
        lines: ['four', 'five'],
        previewLines: ['four', 'five'],
        partialLine: '',
        completedLineCount: 6,
        truncated: true
      }
    })
    const page = readOutput(outputCursor(1))!
    expect(page.terminal).toMatchObject({
      tail: ['four', 'five'],
      truncated: true,
      oldestCursor: '4',
      nextCursor: '6',
      latestCursor: '6'
    })
    expect(page.cursor).toBe(outputCursor(6))
  })

  it.each(['wrong-source', 'future-position', 'wrong-dispatch'])(
    'rejects %s instead of resetting a stream cursor',
    (kind) => {
      writeExit({
        terminalStream: {
          version: 1,
          lines: ['one'],
          previewLines: ['one'],
          partialLine: '',
          completedLineCount: 1,
          truncated: false
        }
      })
      const cursor =
        kind === 'wrong-source'
          ? outputCursor(0, 'another-incarnation')
          : kind === 'future-position'
            ? outputCursor(2)
            : encodeWorkerOutputCursor('another-dispatch', 'terminal', 'another-source', 0)
      expect(() => readOutput(cursor)).toThrow()
    }
  )

  it('refuses output journal evidence with another process PID', () => {
    writeExit({
      pid: identity.pid + 1,
      terminalStream: {
        version: 1,
        lines: ['one'],
        previewLines: ['one'],
        partialLine: '',
        completedLineCount: 1,
        truncated: false
      }
    })
    expect(() => readOutput()).toThrow('another process')
  })

  it('does not invent output for an older exact-exit receipt without a stream', () => {
    writeExit()
    expect(readOutput()).toBeNull()
  })

  async function expectUnproven(): Promise<void> {
    expect(await observeCanonicalWorker(db, dispatchId)).toMatchObject({
      phase: 'released',
      terminalProof: null
    })
    expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit).toBeUndefined()
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
    expect(db.getTask(taskId)?.status).toBe('dispatched')
    expect(runProcess).not.toHaveBeenCalled()
    expect(forceTerminatePosixProcessGroup).not.toHaveBeenCalled()
  }

  it('recovers the committed exact exit after reopening the execution database', async () => {
    writeExit()
    reopen()
    expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit).toBeUndefined()
    expect(await observeCanonicalWorker(db, dispatchId)).toMatchObject({
      binding: { job_id: 'job_recovery', task_id: 'btk_recovery', attempt: 1 },
      processIdentity: identity,
      phase: 'exited',
      terminalProof: {
        kind: 'exited',
        process_identity: identity,
        process_exited: true,
        exit_code: 0,
        process_exit_code: 0,
        exit_cause: { kind: 'exited', exit_code: 0 }
      }
    })
    expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit).toEqual({
      exitCode: 0,
      exitCause: { kind: 'exited', exitCode: 0 },
      observedAt
    })
    expect(forceTerminatePosixProcessGroup).toHaveBeenCalledWith(identity.pid)
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
    expect(db.getTask(taskId)?.status).toBe('blocked')
    reopen()
    expect(readCanonicalWorkerRecord(db, dispatchId)?.terminalProof?.exit_code).toBe(0)
  })

  it.each(['missing journal', 'another session', 'another incarnation', 'another PID'])(
    'preserves uncertainty with %s',
    async (kind) => {
      if (kind !== 'missing journal') {
        writeExit({
          ...(kind === 'another session' ? { sessionId: 'pty_other' } : {}),
          ...(kind === 'another incarnation' ? { incarnationId: 'other_incarnation' } : {}),
          ...(kind === 'another PID' ? { pid: identity.pid + 1 } : {})
        })
      }
      reopen()
      await expectUnproven()
    }
  )

  it.each([null, '', 'without_separator'])(
    'requires a bound process incarnation: %s',
    async (value) => {
      writeExit()
      db.db
        .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
        .run(value, dispatchId)
      await expectUnproven()
    }
  )

  it('does not recover an exit without the previously attested process identity', async () => {
    writeExit()
    updateCanonicalWorkerRecord(db, dispatchId, { processIdentity: null })
    await expectUnproven()
  })

  it.each([
    ['current', 0, identity.started_at],
    ['different', 0, 'Wed Sep 9 13:00:00 2026'],
    ['unverifiable', 2, ''],
    ['empty status', 0, '']
  ] as const)(
    'does not certify termination when process birth is %s',
    async (_label, code, stdout) => {
      writeExit()
      vi.mocked(runProcess).mockResolvedValue({
        code,
        stdout,
        stderr: '',
        signal: null,
        timedOut: false
      })
      expect((await observeCanonicalWorker(db, dispatchId))?.terminalProof).toBeNull()
      expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit?.observedAt).toBe(observedAt)
      expect(forceTerminatePosixProcessGroup).not.toHaveBeenCalled()
    }
  )

  it('does not certify termination when process inspection loses contact', async () => {
    writeExit()
    vi.mocked(runProcess).mockRejectedValue(new Error('Execution host unavailable'))
    expect((await observeCanonicalWorker(db, dispatchId))?.terminalProof).toBeNull()
    expect(forceTerminatePosixProcessGroup).not.toHaveBeenCalled()
  })

  it('waits for process-group quiescence and can recover on a later observation', async () => {
    writeExit()
    vi.mocked(forceTerminatePosixProcessGroup).mockResolvedValueOnce(false)
    expect((await observeCanonicalWorker(db, dispatchId))?.terminalProof).toBeNull()
    reopen()
    expect((await observeCanonicalWorker(db, dispatchId))?.terminalProof?.process_exited).toBe(true)
    expect(forceTerminatePosixProcessGroup).toHaveBeenCalledTimes(2)
  })

  it('preserves a signal exit without inventing a numeric child status', async () => {
    writeExit({ exitCode: null, exitCause: { kind: 'signaled', signal: 9 } })
    reopen()
    expect((await observeCanonicalWorker(db, dispatchId))?.terminalProof).toMatchObject({
      exit_code: null,
      exit_cause: { kind: 'signaled', signal: 9 }
    })
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
    expect(db.getTask(taskId)?.status).toBe('blocked')
  })

  it('retains an unknown exit cause in the journal without creating native terminal proof', async () => {
    writeExit({ exitCode: null, exitCause: { kind: 'unknown', reason: 'host_status_unavailable' } })
    const observed = await observeCanonicalWorker(db, dispatchId)
    expect(observed?.terminalProof).toBeNull()
    expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit?.exitCause).toEqual({
      kind: 'unknown',
      reason: 'host_status_unavailable'
    })
  })

  it('preserves failed child status through journal recovery', async () => {
    writeExit({ exitCode: 7, exitCause: { kind: 'exited', exitCode: 7 } })
    expect((await observeCanonicalWorker(db, dispatchId))?.terminalProof?.exit_code).toBe(7)
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })

  it('does not repeat cleanup or replace evidence when observations are replayed', async () => {
    writeExit()
    const first = await observeCanonicalWorker(db, dispatchId)
    const firstRecord = readCanonicalWorkerRecord(db, dispatchId)
    reopen()
    expect(await observeCanonicalWorker(db, dispatchId)).toEqual(first)
    expect(await observeCanonicalWorker(db, dispatchId)).toEqual(first)
    expect(readCanonicalWorkerRecord(db, dispatchId)).toEqual(firstRecord)
    expect(runProcess).toHaveBeenCalledTimes(1)
    expect(forceTerminatePosixProcessGroup).toHaveBeenCalledTimes(1)
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM dispatch_contexts').get()).toEqual({
      count: 1
    })
  })

  it('preserves cancellation while adding recovered execution evidence', async () => {
    db.beginWorkerStop(dispatchId, 'runtime_cancellation')
    db.settleWorkerStop(dispatchId)
    const cancelledDispatch = db.getDispatchContextById(dispatchId)
    const cancelledTask = db.getTask(taskId)
    writeExit()
    reopen()
    expect((await observeCanonicalWorker(db, dispatchId))?.terminalProof?.process_exited).toBe(true)
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('stopped')
    expect(db.getWorkerDispatch(dispatchId)?.stage).toBe('process_stopped')
    expect(db.getDispatchContextById(dispatchId)).toEqual(cancelledDispatch)
    expect(db.getTask(taskId)).toEqual(cancelledTask)
    expect(db.getTask(taskId)?.status).toBe('blocked')
  })

  it('records a closed prepare gate as not started after the exact exit is recovered', async () => {
    updateCanonicalWorkerRecord(db, dispatchId, { phase: 'prepared' })
    writeExit({ exitCode: 125, exitCause: { kind: 'exited', exitCode: 125 } })
    expect((await observeCanonicalWorker(db, dispatchId))?.terminalProof).toMatchObject({
      kind: 'not_started',
      launch_gate_closed: true,
      exit_code: 125
    })
  })
})
