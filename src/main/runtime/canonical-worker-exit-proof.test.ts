import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'
import { OrcaRuntimeService } from './omni-runtime'
import { OrchestrationDb } from './orchestration/db'
import {
  readCanonicalWorkerRecord,
  type CanonicalWorkerRecord
} from './orchestration/canonical-worker-record'

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: vi.fn(async () => {
    throw new Error('OS process inspection is outside this callback fixture.')
  })
}))

describe('canonical worker exit evidence', () => {
  const tabId = '11111111-1111-4111-8111-111111111111'
  const leafId = '22222222-2222-4222-8222-222222222222'
  const paneKey = `${tabId}:${leafId}`
  const ptyId = 'pty_canonical_exit'
  const incarnationId = 'canonical_incarnation'
  const handle = 'term_canonical_exit'
  const worktreeId = 'folder:canonical-exit'
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let dispatchId: string

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.registerPty(ptyId, worktreeId, null, { tabId, leafId, incarnationId })
    runtime.registerPreAllocatedHandleForPty(ptyId, handle)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [{ tabId, worktreeId, title: 'Canonical worker', activeLeafId: leafId, layout: null }],
      leaves: [{ tabId, worktreeId, leafId, paneRuntimeId: 1, ptyId }]
    })
    const run = db.createRun({
      objective: 'Observe canonical worker exit',
      coordinatorHandle: 'term_coordinator',
      coordinatorPaneKey:
        '99999999-9999-4999-8999-999999999999:88888888-8888-4888-8888-888888888888'
    })
    const task = db.createTask({ spec: 'Observe exact worker', runId: run.id })
    const canonical: CanonicalWorkerRecord = {
      binding: { job_id: 'job_exit' },
      bindingHash: 'binding_hash',
      launchDigest: 'launch_digest',
      gateDirectory: '/unused/canonical-exit',
      gateNonce: 'gate_nonce',
      runGeneration: run.consumer_generation,
      processIdentity: {
        pid: 424242,
        started_at: 'Wed Sep 9 12:00:00 2026',
        runner_instance: 'runner_1'
      },
      phase: 'released',
      terminalProof: null
    }
    dispatchId = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: 3,
      taskId: task.id,
      runtimeEpoch: runtime.getRuntimeId(),
      startOptions: { canonical }
    }).dispatch.id
    db.prepareStartingWorkerAuthority({
      dispatchId,
      handle,
      paneKey,
      processIncarnation: `${ptyId}:${incarnationId}`,
      worktreeId,
      setupState: 'not_applicable',
      effects: [],
      terminalOwnership: 'created'
    })
    db.markWorkerDispatchReady(dispatchId)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.close()
  })

  function expectUnproven(): void {
    expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit).toBeUndefined()
    expect(readCanonicalWorkerRecord(db, dispatchId)?.terminalProof).toBeNull()
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('ready')
  }

  it.each([-1, 0, 7])(
    'does not turn an uncertified teardown code %s into process evidence',
    (code) => {
      // Recovery can encode disappearance as zero without observing a child wait status.
      runtime.onPtyExit(ptyId, code, incarnationId)
      expectUnproven()
    }
  )

  it.each(['providerExitObserved', 'hostExitConfirmed'] as const)(
    'records an exact physical exit certified by %s',
    (certificate) => {
      runtime.onPtyExit(ptyId, 7, incarnationId, {
        [certificate]: true,
        cause: { kind: 'exited', exitCode: 7 }
      })
      expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit).toMatchObject({ exitCode: 7 })
      expect(db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
    }
  )

  it('accepts zero only with certified child-exit status', () => {
    runtime.onPtyExit(ptyId, 0, incarnationId, {
      providerExitObserved: true,
      cause: { kind: 'exited', exitCode: 0 }
    })
    expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit).toMatchObject({ exitCode: 0 })
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('succeeded')
  })

  it.each<TerminalExitCause>([
    { kind: 'signaled', signal: 9 },
    { kind: 'unknown', reason: 'host_status_unavailable' },
    { kind: 'operator_close' }
  ])('keeps $kind status unknown even when a certified callback carries zero', (cause) => {
    runtime.onPtyExit(ptyId, 0, incarnationId, { providerExitObserved: true, cause })
    expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit).toMatchObject({ exitCode: null })
    expect(db.getWorkerDispatch(dispatchId)?.state).not.toBe('succeeded')
  })

  it('records physical negative exits without inventing a child exit code', () => {
    runtime.onPtyExit(ptyId, -1, incarnationId, {
      providerExitObserved: true,
      cause: { kind: 'unknown', reason: 'host_status_unavailable' }
    })
    expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit).toMatchObject({ exitCode: null })
  })

  it('records the exact exit while preserving an in-flight stop outcome', () => {
    db.beginWorkerStop(dispatchId, runtime.getRuntimeId())
    runtime.markPtyStopRequested(ptyId)
    runtime.onPtyExit(ptyId, 0, incarnationId, {
      providerExitObserved: true,
      cause: { kind: 'operator_close' }
    })

    expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit).toMatchObject({
      exitCode: null,
      exitCause: { kind: 'operator_close' }
    })
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('stopping')
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'dispatched',
      last_failure: null
    })

    db.settleWorkerStop(dispatchId)
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'stopped',
      stage: 'process_stopped'
    })
    const dispatch = db.getDispatchContextById(dispatchId)!
    expect(dispatch).toMatchObject({ status: 'failed', last_failure: 'stopped' })
    expect(db.getTask(dispatch.task_id)?.status).toBe('blocked')
  })

  it('does not certify synthetic daemon fanout carrying the provider-observed flag', () => {
    runtime.onPtyExit(ptyId, -1, incarnationId, { providerExitObserved: true })
    expectUnproven()
  })

  it('ignores a delayed exit callback from a replaced incarnation', () => {
    runtime.onPtyExit(ptyId, 0, 'previous_incarnation', {
      providerExitObserved: true,
      cause: { kind: 'exited', exitCode: 0 }
    })
    expectUnproven()
  })

  it('does not attribute the current PTY exit to another dispatch incarnation', () => {
    db.db
      .prepare('UPDATE dispatch_contexts SET process_incarnation = ? WHERE id = ?')
      .run(`${ptyId}:previous_incarnation`, dispatchId)
    runtime.onPtyExit(ptyId, 0, incarnationId, {
      providerExitObserved: true,
      cause: { kind: 'exited', exitCode: 0 }
    })
    expectUnproven()
  })

  it('records an exact received exit before runtime PTY and handle adoption', () => {
    runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    runtime.onPtyExit(ptyId, 7, incarnationId, {
      providerExitObserved: true,
      cause: { kind: 'exited', exitCode: 7 }
    })
    expect(readCanonicalWorkerRecord(db, dispatchId)?.rootExit).toMatchObject({ exitCode: 7 })
    expect(db.getWorkerDispatch(dispatchId)?.state).toBe('failed')
  })

  it('does not attribute a different received incarnation before runtime adoption', () => {
    runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(db)
    runtime.onPtyExit(ptyId, 0, 'another_incarnation', {
      providerExitObserved: true,
      cause: { kind: 'exited', exitCode: 0 }
    })
    expectUnproven()
  })
})
