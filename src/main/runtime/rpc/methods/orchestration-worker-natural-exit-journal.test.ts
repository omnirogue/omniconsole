import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import {
  readConsoleJobProcessHandshake,
  recordConsoleJobProcessHandshake,
  type ConsoleJobProcessIdentity
} from '../../orchestration/console-job-process-handshake'
import {
  createConsoleJobProcessFixture,
  recordReleasedConsoleJobProcess
} from '../../orchestration/console-job-process-test-fixture'
import { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import {
  requestWorkerNaturalExit,
  type WorkerNaturalExitRuntime
} from './orchestration-worker-natural-exit'
import { createWorkerNaturalExitFixture } from './orchestration-worker-natural-exit.test-fixture'

describe('durable natural exit input reservation', () => {
  let directory: string
  let path: string
  let db: OrchestrationDb
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'omni-exit-intent-'))
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

  function worker(identity: ConsoleJobProcessIdentity) {
    const f = createWorkerNaturalExitFixture()
    f.resource.owner_dispatch_id = identity.dispatchId
    vi.spyOn(db, 'getWorkerTerminalResourceByOwner').mockImplementation(
      f.db.getWorkerTerminalResourceByOwner
    )
    vi.spyOn(db, 'getWorkerDispatch').mockReturnValue(f.worker as never)
    vi.spyOn(db, 'isDispatchProcessCurrent').mockReturnValue(true)
    vi.spyOn(db, 'workerTerminalResourceHasIdentityConflict').mockReturnValue(false)
    const run = (consoleJob: ConsoleJobProcessIdentity | undefined = identity) =>
      requestWorkerNaturalExit({
        runtime: f.runtime as unknown as WorkerNaturalExitRuntime,
        db,
        dispatchId: identity.dispatchId,
        gate: f.gate,
        observeProcess: f.observeProcess,
        ...(consoleJob ? { consoleJob } : {}),
        timeoutMs: 30
      })
    return { ...f, run }
  }

  it('commits before the first byte and never resends after an unacknowledged write and restart', async () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordReleasedConsoleJobProcess(db, identity, gate)
    const first = worker(identity)
    let bytesWritten = 0
    first.runtime.sendTerminal.mockImplementation(async (_handle, _action, options) => {
      expect(readConsoleJobProcessHandshake(db, identity)?.exitIntent).toBeUndefined()
      await options.beforeWrite(gate.ptyId)
      options.reserveWrite(gate.ptyId)
      expect(readConsoleJobProcessHandshake(db, identity)?.exitIntent).toBeDefined()
      bytesWritten++
      throw new Error('connection_lost_after_partial_write')
    })
    expect(await first.run()).toMatchObject({
      status: 'unverifiable',
      reason: 'connection_lost_after_partial_write'
    })
    expect(bytesWritten).toBe(1)
    reopen()
    const restarted = worker(identity)
    expect(await restarted.run()).toMatchObject({ status: 'exited', exitCode: 0 })
    expect(restarted.runtime.sendTerminal).not.toHaveBeenCalled()
    expect(restarted.runtime.waitForTerminal).toHaveBeenCalledOnce()
    expect(restarted.runtime.waitForTerminal).toHaveBeenCalledWith('term-1', {
      condition: 'exit',
      timeoutMs: 30
    })
    expect(restarted.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('keeps an unobserved retry unverifiable instead of treating persisted intent as exit evidence', async () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordReleasedConsoleJobProcess(db, identity, gate)
    recordConsoleJobProcessHandshake(db, identity, { phase: 'exit_intent', gate })
    reopen()
    const f = worker(identity)
    f.state.observation = null
    expect(await f.run()).toMatchObject({ status: 'unverifiable' })
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('allows the same reserved send to write its suffix without permitting a second sender', async () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordReleasedConsoleJobProcess(db, identity, gate)
    const f = worker(identity)
    let writes = 0
    f.runtime.sendTerminal.mockImplementation(async (_handle, _action, options) => {
      for (let chunk = 0; chunk < 2; chunk++) {
        await options.beforeWrite(gate.ptyId)
        options.reserveWrite(gate.ptyId)
        writes++
      }
      return { handle: 'term-1', accepted: true, bytesWritten: 6 }
    })
    expect(await f.run()).toMatchObject({ status: 'exited' })
    expect(writes).toBe(2)
    expect(
      db.db
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE payload LIKE '%exit_intent%'")
        .get()
    ).toEqual({ count: 1 })
  })

  it('fences independent runtime callers that both saw an idle process before reservation', async () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordReleasedConsoleJobProcess(db, identity, gate)
    const first = worker(identity)
    const second = worker(identity)
    let writes = 0
    let readyCount = 0
    let ready!: () => void
    const bothReady = new Promise<void>((resolve) => {
      ready = resolve
    })
    for (const f of [first, second]) {
      f.runtime.sendTerminal.mockImplementation(async (_handle, _action, options) => {
        await options.beforeWrite(gate.ptyId)
        readyCount++
        if (readyCount === 2) {
          ready()
        }
        await bothReady
        options.reserveWrite(gate.ptyId)
        writes++
        throw new Error('unacknowledged_write')
      })
    }
    const outcomes = await Promise.all([first.run(), second.run()])
    expect(writes).toBe(1)
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['unverifiable', 'unverifiable'])
    expect(readConsoleJobProcessHandshake(db, identity)?.exitIntent).toBeDefined()
  })

  it('refuses input when the durable identity or released chain is missing', async () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    const f = worker(identity)
    expect(
      await requestWorkerNaturalExit({
        runtime: f.runtime as unknown as WorkerNaturalExitRuntime,
        db,
        dispatchId: identity.dispatchId,
        gate,
        observeProcess: f.observeProcess
      })
    ).toMatchObject({ status: 'refused' })
    recordConsoleJobProcessHandshake(db, identity, { phase: 'prepared', gate })
    expect(await f.run()).toMatchObject({ status: 'refused' })
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('refuses another principal before writing even when the worker has already exited', async () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordReleasedConsoleJobProcess(db, identity, gate)
    const f = worker(identity)
    f.exit()
    expect(await f.run({ ...identity, principal: 'b'.repeat(64) })).toMatchObject({
      status: 'refused'
    })
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it.each(['principal', 'claim'] as const)(
    "does not coalesce a changed %s into another caller's authorized in-flight result",
    async (changed) => {
      const { identity, gate } = createConsoleJobProcessFixture(db)
      recordReleasedConsoleJobProcess(db, identity, gate)
      const f = worker(identity)
      const other =
        changed === 'principal'
          ? { ...identity, principal: 'b'.repeat(64) }
          : { ...identity, binding: { ...identity.binding, leaseGeneration: 99 } }
      const results = await Promise.all([f.run(), f.run(other)])
      expect(results[0]).toMatchObject({ status: 'exited' })
      expect(results[1]).toMatchObject({ status: 'refused' })
      expect(f.runtime.sendTerminal).toHaveBeenCalledOnce()
    }
  )

  it('does not write when the before-write journal transaction cannot commit', async () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordReleasedConsoleJobProcess(db, identity, gate)
    const f = worker(identity)
    let writes = 0
    f.runtime.sendTerminal.mockImplementation(async (_handle, _action, options) => {
      await options.beforeWrite(gate.ptyId)
      db.db.exec('BEGIN IMMEDIATE')
      try {
        options.reserveWrite(gate.ptyId)
        writes++
      } finally {
        db.db.exec('ROLLBACK')
      }
      return { handle: 'term-1', accepted: true, bytesWritten: 6 }
    })
    expect(await f.run()).toMatchObject({ status: 'unverifiable' })
    expect(writes).toBe(0)
    expect(readConsoleJobProcessHandshake(db, identity)?.exitIntent).toBeUndefined()
  })

  it('preserves a live verdict when an intent exists and no physical exit has arrived', async () => {
    const { identity, gate } = createConsoleJobProcessFixture(db)
    recordReleasedConsoleJobProcess(db, identity, gate)
    recordConsoleJobProcessHandshake(db, identity, { phase: 'exit_intent', gate })
    reopen()
    const f = worker(identity)
    f.runtime.waitForTerminal.mockResolvedValue({
      handle: 'term-1',
      condition: 'exit',
      status: 'running',
      satisfied: false,
      exitCode: null
    } as RuntimeTerminalWait)
    expect(await f.run()).toMatchObject({ status: 'live' })
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
  })
})
