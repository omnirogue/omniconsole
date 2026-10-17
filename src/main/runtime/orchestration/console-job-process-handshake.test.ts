import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redactConsoleWorkflowValue } from '../../backoffice/console-workflow-redaction'
import { ConsoleJobJournal } from './console-job-journal'
import {
  readConsoleJobProcessHandshake,
  recordConsoleJobProcessHandshake,
  type ConsoleJobPhysicalExit,
  type ConsoleJobProcessEventInput
} from './console-job-process-handshake'
import {
  attachConsoleJobProcessStart,
  createConsoleJobProcessFixture,
  recordReleasedConsoleJobProcess
} from './console-job-process-test-fixture'
import { OrchestrationDb } from './db/orchestration-db'

describe('console job physical process handshake journal', () => {
  let directory: string
  let path: string
  let db: OrchestrationDb
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'omni-process-journal-'))
    path = join(directory, 'orchestration.db')
    db = new OrchestrationDb(path)
  })
  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  function reopen() {
    db.close()
    db = new OrchestrationDb(path)
  }
  function count() {
    return db.db
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE id LIKE 'omnios_process_%'")
      .get()
  }
  const exit: ConsoleJobPhysicalExit = {
    observedAt: '2026-09-08T22:00:00.000Z',
    processExitCode: 0,
    exitCause: { kind: 'exited', exitCode: 0 }
  }

  it('freezes every physical phase across real database reopen without publishing business events', () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    const originalClaim = db.getRun(identity.runId)!.console_job
    const originalDispatch = db.getDispatchContextById(identity.dispatchId)
    const schema = db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    expect(readConsoleJobProcessHandshake(db, identity)).toBeNull()
    recordConsoleJobProcessHandshake(db, identity, { phase: 'prepared', gate })
    reopen()
    const started = attachConsoleJobProcessStart(db, identity)
    recordConsoleJobProcessHandshake(db, identity, { phase: 'start_acknowledged', gate })
    reopen()
    const startAcknowledgement = readConsoleJobProcessHandshake(db, identity)!.startAcknowledgement!
    expect(startAcknowledgement).toMatch(/^sha256:[a-f0-9]{64}$/)
    recordConsoleJobProcessHandshake(
      db,
      { ...identity, binding: started },
      {
        phase: 'release_intent',
        gate,
        startAcknowledgement
      }
    )
    reopen()
    recordConsoleJobProcessHandshake(db, identity, {
      phase: 'released',
      gate,
      released: { gateId: gate.gateId, state: 'released', startAcknowledgement }
    })
    recordConsoleJobProcessHandshake(db, identity, { phase: 'exit_intent', gate })
    reopen()
    recordConsoleJobProcessHandshake(db, identity, { phase: 'physical_exit', gate, exit })
    reopen()
    const state = readConsoleJobProcessHandshake(db, identity)!
    const before = db.db.prepare('SELECT total_changes() AS count').get()
    for (const record of [
      state.prepared,
      state.startAcknowledged!,
      state.releaseIntent!,
      state.released!,
      state.exitIntent!,
      state.physicalExit!
    ]) {
      const event =
        record.event.phase === 'start_acknowledged'
          ? { phase: record.event.phase, gate }
          : record.event
      expect(recordConsoleJobProcessHandshake(db, identity, event).fresh).toBe(false)
    }
    expect(db.db.prepare('SELECT total_changes() AS count').get()).toEqual(before)
    expect(count()).toEqual({ count: 6 })
    expect(state.physicalExit?.event).toEqual({ phase: 'physical_exit', gate, exit })
    expect(state.prepared.identity.binding).toEqual(identity.binding)
    expect(db.getRun(identity.runId)!.console_job).toBe(originalClaim)
    expect(db.getDispatchContextById(identity.dispatchId)).toEqual(originalDispatch)
    const failed = vi.fn()
    new ConsoleJobJournal(db, (text) => text).recover(failed)
    expect(failed).not.toHaveBeenCalled()
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM console_job_publications').get()).toEqual({
      count: 0
    })
    expect(db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual(
      schema
    )
    const rows = db.db
      .prepare(
        "SELECT payload, delivery_contract, from_handle FROM messages WHERE id LIKE 'omnios_process_%'"
      )
      .all() as { payload: string; delivery_contract: string; from_handle: string }[]
    expect(
      rows.every((row) => row.delivery_contract === 'audit_only' && row.from_handle === 'runtime')
    ).toBe(true)
    expect(rows.map((row) => row.payload).join()).not.toMatch(
      /result_exit_code|command|prompt|bearer|worker_done/
    )
  })

  it.each([
    'host',
    'claimedAt',
    'runnerInstance',
    'claimRequestId',
    'attemptIntentId',
    'dispatchKey'
  ] as const)('rejects claim %s drift on reads and writes after restart', (field) => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordConsoleJobProcessHandshake(db, identity, { phase: 'prepared', gate })
    reopen()
    const changed = {
      ...identity,
      binding: {
        ...identity.binding,
        claim: {
          ...identity.binding.claim!,
          [field]: field === 'claimedAt' ? '2026-09-09T00:00:00Z' : 'another'
        }
      }
    }
    expect(() => readConsoleJobProcessHandshake(db, changed)).toThrow()
    expect(() =>
      recordConsoleJobProcessHandshake(db, changed, { phase: 'prepared', gate })
    ).toThrow()
    expect(count()).toEqual({ count: 1 })
  })

  it('rejects another principal, Run, Dispatch, attempt, lease or attached session', () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordReleasedConsoleJobProcess(db, identity, gate)
    for (const changed of [
      { ...identity, principal: 'b'.repeat(64) },
      { ...identity, runId: 'run_other' },
      { ...identity, dispatchId: 'ctx_other' },
      { ...identity, binding: { ...identity.binding, attempt: 2 } },
      { ...identity, binding: { ...identity.binding, leaseGeneration: 99 } },
      {
        ...identity,
        binding: { ...identity.binding, sessionId: 'ses_wrong', attemptId: 'attempt_wrong' }
      }
    ]) {
      expect(() => readConsoleJobProcessHandshake(db, changed)).toThrow()
      expect(() =>
        recordConsoleJobProcessHandshake(db, changed, { phase: 'exit_intent', gate })
      ).toThrow()
    }
    expect(count()).toEqual({ count: 4 })
  })

  it.each([
    { pid: 43 },
    { processStartTimeMs: 1_780_000_000_001 },
    { incarnationId: 'inc-other' },
    { ptyId: 'pty-other' },
    { gateId: 'gate-other' }
  ])('refuses immutable prepared identity drift: %j', (patch) => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordReleasedConsoleJobProcess(db, identity, gate)
    reopen()
    expect(() =>
      recordConsoleJobProcessHandshake(db, identity, {
        phase: 'prepared',
        gate: { ...gate, ...patch }
      })
    ).toThrow('frozen')
    expect(() =>
      recordConsoleJobProcessHandshake(db, identity, {
        phase: 'exit_intent',
        gate: { ...gate, ...patch }
      })
    ).toThrow('exact gate')
    expect(count()).toEqual({ count: 4 })
  })

  it('preserves the separately registered macOS child and PTY root identity', () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    const childGate = {
      ...gate,
      processKind: 'pty-shell' as const,
      ptyRootPid: 40,
      ptyRootProcessStartTimeMs: gate.processStartTimeMs - 1000,
      exitObserver: 'macos-kqueue' as const
    }
    recordReleasedConsoleJobProcess(db, identity, childGate)
    reopen()
    expect(readConsoleJobProcessHandshake(db, identity)?.gate).toEqual(childGate)
    expect(() =>
      recordConsoleJobProcessHandshake(db, identity, {
        phase: 'exit_intent',
        gate: { ...childGate, ptyRootPid: 39 }
      })
    ).toThrow('exact gate')
  })

  it('requires persisted start and release predecessors and the exact canonical acknowledgement', () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordConsoleJobProcessHandshake(db, identity, { phase: 'prepared', gate })
    expect(() =>
      recordConsoleJobProcessHandshake(db, identity, { phase: 'start_acknowledged', gate })
    ).toThrow('canonical start')
    const started = attachConsoleJobProcessStart(db, identity)
    expect(() =>
      recordConsoleJobProcessHandshake(
        db,
        { ...identity, binding: started },
        { phase: 'exit_intent', gate }
      )
    ).toThrow('predecessor')
    recordConsoleJobProcessHandshake(db, identity, { phase: 'start_acknowledged', gate })
    const startAcknowledgement = readConsoleJobProcessHandshake(db, identity)!.startAcknowledgement!
    expect(() =>
      recordConsoleJobProcessHandshake(db, identity, {
        phase: 'release_intent',
        gate,
        startAcknowledgement: `sha256:${'b'.repeat(64)}`
      })
    ).toThrow('canonical start')
    expect(() =>
      recordConsoleJobProcessHandshake(db, identity, {
        phase: 'released',
        gate,
        released: { gateId: gate.gateId, state: 'released', startAcknowledgement }
      })
    ).toThrow('predecessor')
    recordConsoleJobProcessHandshake(db, identity, {
      phase: 'release_intent',
      gate,
      startAcknowledgement
    })
    expect(() =>
      recordConsoleJobProcessHandshake(db, identity, {
        phase: 'released',
        gate,
        released: { gateId: 'wrong', state: 'released', startAcknowledgement }
      })
    ).toThrow('another gate')
    expect(count()).toEqual({ count: 3 })
  })

  it.each([
    { processExitCode: null, exitCause: { kind: 'operator_close' } },
    { processExitCode: null, exitCause: { kind: 'signaled', signal: 15 } },
    { processExitCode: -9, exitCause: { kind: 'signaled', signal: 9 } },
    { processExitCode: 37, exitCause: { kind: 'exited', exitCode: 37 } }
  ] as const)(
    'records closed-gate physical death without inventing a start or successful result: %j',
    (physical) => {
      const { identity, gate } = createConsoleJobProcessFixture(db)
      recordConsoleJobProcessHandshake(db, identity, { phase: 'prepared', gate })
      recordConsoleJobProcessHandshake(db, identity, {
        phase: 'physical_exit',
        gate,
        exit: { ...exit, ...physical }
      })
      reopen()
      const state = readConsoleJobProcessHandshake(db, identity)!
      expect(state.released).toBeUndefined()
      expect(state.startAcknowledgement).toBeUndefined()
      expect(state.physicalExit?.event).toEqual({
        phase: 'physical_exit',
        gate,
        exit: { ...exit, ...physical }
      })
      attachConsoleJobProcessStart(db, identity)
      expect(() =>
        recordConsoleJobProcessHandshake(db, identity, { phase: 'start_acknowledged', gate })
      ).toThrow('another lifecycle action')
    }
  )

  it.each([
    { processExitCode: 0, exitCause: { kind: 'signaled', signal: 15 } },
    { processExitCode: 0, exitCause: { kind: 'exited', exitCode: 37 } },
    { processExitCode: 0, exitCause: { kind: 'unknown', reason: 'cause_unreported' } },
    { processExitCode: 0, exitCause: undefined },
    { processExitCode: null, exitCause: { kind: 'exited', exitCode: 0 } },
    { observedAt: '2020-01-01T00:00:00Z' },
    { result_exit_code: 0 },
    { prompt: 'not journal material' }
  ])('refuses incomplete, contradictory or non-physical proof: %j', (patch) => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordConsoleJobProcessHandshake(db, identity, { phase: 'prepared', gate })
    expect(() =>
      recordConsoleJobProcessHandshake(db, identity, {
        phase: 'physical_exit',
        gate,
        exit: { ...exit, ...patch }
      } as ConsoleJobProcessEventInput)
    ).toThrow()
    expect(count()).toEqual({ count: 1 })
  })

  it('refuses corrupted journal provenance and preserves the canonical start immutability guard', () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordReleasedConsoleJobProcess(db, identity, gate)
    const state = readConsoleJobProcessHandshake(db, identity)!
    db.db
      .prepare("UPDATE messages SET delivery_contract = 'current_delivery' WHERE sequence = ?")
      .run(state.prepared.sequence)
    reopen()
    expect(() => readConsoleJobProcessHandshake(db, identity)).toThrow('journal identity')
    db.db
      .prepare("UPDATE messages SET delivery_contract = 'audit_only' WHERE sequence = ?")
      .run(state.prepared.sequence)
    const receipt = JSON.parse(db.getRun(identity.runId)!.console_job_start_receipt!)
    expect(() =>
      db.db
        .prepare('UPDATE runs SET console_job_start_receipt = ? WHERE id = ?')
        .run(JSON.stringify({ ...receipt, sessionId: 'ses_replaced' }), identity.runId)
    ).toThrow('immutable')
    expect(readConsoleJobProcessHandshake(db, identity)).toEqual(state)
  })

  it('cannot publish receipts inside another uncommitted transaction', () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    db.db.exec('BEGIN IMMEDIATE')
    expect(() =>
      recordConsoleJobProcessHandshake(db, identity, { phase: 'prepared', gate })
    ).toThrow()
    db.db.exec('ROLLBACK')
    expect(count()).toEqual({ count: 0 })
  })

  it('rejects an opaque in-memory bearer sentinel in a gate field without a journal write', () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    const sentinel = 'opaque-test-credential-sentinel'
    expect(() =>
      recordConsoleJobProcessHandshake(
        db,
        identity,
        { phase: 'prepared', gate: { ...gate, ptyId: `pty-${sentinel}` } },
        (value) => redactConsoleWorkflowValue(value, sentinel)
      )
    ).toThrow('protected data')
    expect(count()).toEqual({ count: 0 })
    expect(db.db.prepare('SELECT payload FROM messages').all()).toEqual([])
  })

  it('always applies default token-pattern rules even when a supplied sanitizer misses them', () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    const token = `sk-${'a'.repeat(40)}`
    for (const redact of [undefined, (value: unknown) => value]) {
      expect(() =>
        recordConsoleJobProcessHandshake(
          db,
          identity,
          { phase: 'prepared', gate: { ...gate, ptyId: token } },
          redact
        )
      ).toThrow('protected data')
    }
    expect(count()).toEqual({ count: 0 })
  })
})
