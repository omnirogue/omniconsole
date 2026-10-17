import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../runtime/omni-runtime'
import * as ConsoleWorkflowCredentialMemory from '../backoffice/console-workflow-credential-memory'
import { OrchestrationDb } from '../runtime/orchestration/db'
import {
  readConsoleJobProcessHandshake,
  recordConsoleJobProcessHandshake
} from '../runtime/orchestration/console-job-process-handshake'
import { attachConsoleJobProcessStart } from '../runtime/orchestration/console-job-process-test-fixture'
import {
  observeConsoleJobProcess,
  finishConsoleJobProcess
} from './console-job-process-observation'
import { createConsoleProcessObservationFixture } from './console-job-process-observation.test-fixture'
import { listConsoleLocalExecutions } from './console-local-execution-state'

describe('console physical process observation', () => {
  const databases: OrchestrationDb[] = []
  const directories: string[] = []
  function fixture(path?: string, released = true) {
    const f = createConsoleProcessObservationFixture(path, released)
    databases.push(f.db)
    return f
  }
  afterEach(() => {
    for (const db of databases.splice(0)) {
      db.close()
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
    vi.restoreAllMocks()
  })

  it.each([0, 37])(
    'journals the registered child exit %s independently of wrapper status',
    async (code) => {
      const f = fixture()
      f.exit(code)
      const observed = await observeConsoleJobProcess(f.runtime, f.identity)
      expect(observed).toMatchObject({
        state: 'exited',
        proof: {
          kind: 'exited',
          process_exit_code: code,
          exit_cause: { kind: 'exited', exit_code: code },
          process_identity: {
            pid: f.gate.pid,
            runner_instance: f.identity.binding.claim!.runnerInstance
          },
          observed_at: new Date(f.gate.processStartTimeMs + 1000).toISOString()
        }
      })
      expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit?.event).toMatchObject({
        phase: 'physical_exit',
        gate: f.gate,
        exit: { processExitCode: code }
      })
      expect(f.runtime.waitForTerminal).not.toHaveBeenCalled()
    }
  )

  it('retains a signal and null process code as physical death', async () => {
    const f = fixture()
    f.exit(null, 9)
    await expect(observeConsoleJobProcess(f.runtime, f.identity)).resolves.toMatchObject({
      state: 'exited',
      proof: { process_exit_code: null, exit_cause: { kind: 'signaled', signal: 9 } }
    })
  })

  it.each([
    'gateId',
    'ptyId',
    'incarnationId',
    'pid',
    'processStartTimeMs',
    'startAcknowledgement'
  ] as const)('refuses a host %s mismatch without a physical journal write', async (field) => {
    const f = fixture()
    f.exit()
    f.state.observation = {
      ...f.state.observation,
      [field]: typeof f.state.observation[field] === 'number' ? 123 : 'other'
    }
    await expect(observeConsoleJobProcess(f.runtime, f.identity)).resolves.toMatchObject({
      state: 'unverifiable'
    })
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeUndefined()
  })

  it.each([
    { exitCode: 0, signal: 9, waitStatus: 9 },
    { exitCode: 37, signal: null, waitStatus: 0 },
    { exitCode: null, signal: null, waitStatus: 0 },
    { exitCode: null, signal: 9, waitStatus: 0 },
    { observedAtMs: 100 },
    { source: 'wrapper' }
  ])('rejects inconsistent host evidence %j', async (change) => {
    const f = fixture()
    f.exit()
    Object.assign(f.state.observation, change)
    await expect(observeConsoleJobProcess(f.runtime, f.identity)).resolves.toMatchObject({
      state: 'unverifiable'
    })
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeUndefined()
  })

  it('preserves contact loss and old-host operation absence as unverifiable', async () => {
    const f = fixture()
    vi.mocked(f.runtime.readTerminalLaunchGateObservation)
      .mockRejectedValueOnce(new Error('contact lost'))
      .mockResolvedValueOnce({
        ...f.fields,
        state: 'unverifiable',
        reason: 'operation unavailable'
      })
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(observeConsoleJobProcess(f.runtime, f.identity)).resolves.toMatchObject({
        state: 'unverifiable'
      })
    }
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeUndefined()
  })

  it('requires exact principal and full binding before observing the host', async () => {
    const f = fixture()
    await expect(
      observeConsoleJobProcess(f.runtime, { ...f.identity, principal: 'b'.repeat(64) })
    ).rejects.toThrow('principal')
    await expect(
      observeConsoleJobProcess(f.runtime, {
        ...f.identity,
        binding: { ...f.identity.binding, attempt: 2 }
      })
    ).rejects.toThrow('principal')
    expect(f.runtime.readTerminalLaunchGateObservation).not.toHaveBeenCalled()
  })

  it('requires a closed unacknowledged gate for not_started proof', async () => {
    const f = fixture(undefined, false)
    f.exit(null, 15)
    await expect(observeConsoleJobProcess(f.runtime, f.identity)).resolves.toMatchObject({
      state: 'exited',
      proof: { kind: 'not_started', launch_gate_closed: true, process_exit_code: null }
    })
  })

  it('does not infer a closed gate from a journal when the host reports another acknowledgement', async () => {
    const f = fixture(undefined, false)
    f.exit(null, 15)
    f.state.observation.startAcknowledgement = `sha256:${'d'.repeat(64)}`
    await expect(observeConsoleJobProcess(f.runtime, f.identity)).resolves.toMatchObject({
      state: 'unverifiable'
    })
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeUndefined()
  })

  it('uses the durable physical receipt after a real SQLite reopen without host contact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'console-physical-reopen-'))
    directories.push(directory)
    const path = join(directory, 'orchestration.db')
    const f = fixture(path)
    f.settle()
    f.exit(37)
    const before = await observeConsoleJobProcess(f.runtime, f.identity)
    f.db.close()
    databases.pop()
    const reopened = new OrchestrationDb(path)
    databases.push(reopened)
    const runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(reopened)
    vi.spyOn(runtime, 'readTerminalLaunchGateObservation').mockRejectedValue(new Error('host gone'))
    vi.spyOn(runtime, 'sendTerminal')
    const record = listConsoleLocalExecutions(reopened, f.identity.principal)[0]
    await expect(observeConsoleJobProcess(runtime, f.identity)).resolves.toEqual(before)
    await expect(finishConsoleJobProcess(runtime, record)).resolves.toMatchObject({
      process_exit_code: 37
    })
    expect(runtime.readTerminalLaunchGateObservation).not.toHaveBeenCalled()
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('reserves natural exit before input and records physical death after the actual host exit', async () => {
    const f = fixture()
    f.settle()
    const send = vi.mocked(f.runtime.sendTerminal).getMockImplementation()!
    vi.mocked(f.runtime.sendTerminal).mockImplementation(async (...args) => {
      const answer = await send(...args)
      expect(readConsoleJobProcessHandshake(f.db, f.identity)?.exitIntent).toBeDefined()
      expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeUndefined()
      return answer
    })
    await expect(finishConsoleJobProcess(f.runtime, f.record())).resolves.toMatchObject({
      process_exit_code: 37
    })
    await finishConsoleJobProcess(f.runtime, f.record())
    expect(f.runtime.sendTerminal).toHaveBeenCalledTimes(1)
    const handshake = readConsoleJobProcessHandshake(f.db, f.identity)!
    expect(handshake.exitIntent!.sequence).toBeLessThan(handshake.physicalExit!.sequence)
  })

  it('never repeats persisted natural exit input after SQLite reopen and runtime replacement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'console-physical-intent-'))
    directories.push(directory)
    const path = join(directory, 'orchestration.db')
    const f = fixture(path)
    f.settle()
    recordConsoleJobProcessHandshake(f.db, f.identity, { phase: 'exit_intent', gate: f.gate })
    const resource = f.db.getWorkerTerminalResourceByOwner(f.identity.dispatchId)!
    f.db.close()
    databases.pop()
    const reopened = new OrchestrationDb(path)
    databases.push(reopened)
    const runtime = new OrcaRuntimeService(null)
    runtime.setOrchestrationDb(reopened)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(resource.pane_key)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(resource.process_incarnation)
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockImplementation(
      vi.mocked(f.runtime.getOrchestrationDispatchAuthority).getMockImplementation()!
    )
    vi.spyOn(runtime, 'readTerminalLaunchGateObservation').mockImplementation(
      async () => f.state.observation
    )
    vi.spyOn(runtime, 'waitForTerminal').mockImplementation(
      vi.mocked(f.runtime.waitForTerminal).getMockImplementation()!
    )
    vi.spyOn(runtime, 'sendTerminal')
    const record = listConsoleLocalExecutions(reopened, f.identity.principal)[0]
    await expect(finishConsoleJobProcess(runtime, record)).resolves.toMatchObject({
      process_exit_code: 37
    })
    expect(runtime.sendTerminal).not.toHaveBeenCalled()
    expect(readConsoleJobProcessHandshake(reopened, f.identity)?.physicalExit).toBeDefined()
  })

  it('a terminal wait satisfied by wrapper zero cannot replace the physical host observation', async () => {
    const f = fixture()
    f.settle()
    vi.mocked(f.runtime.waitForTerminal).mockImplementation(async (handle, options) => ({
      handle,
      condition: options?.condition ?? 'tui-idle',
      satisfied: true,
      status: options?.condition === 'exit' ? 'exited' : 'running',
      exitCode: 0,
      exitCause: { kind: 'exited', exitCode: 0 }
    }))
    await expect(finishConsoleJobProcess(f.runtime, f.record())).rejects.toThrow('unverifiable')
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeUndefined()
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.exitIntent).toBeDefined()
  })

  it('recovers an acknowledged host release before journaling a later physical exit', async () => {
    const f = fixture(undefined, false)
    attachConsoleJobProcessStart(f.db, f.identity)
    recordConsoleJobProcessHandshake(f.db, f.identity, {
      phase: 'start_acknowledged',
      gate: f.gate
    })
    const startAcknowledgement = readConsoleJobProcessHandshake(
      f.db,
      f.identity
    )!.startAcknowledgement!
    recordConsoleJobProcessHandshake(f.db, f.identity, {
      phase: 'release_intent',
      gate: f.gate,
      startAcknowledgement
    })
    f.exit(37)
    f.state.observation.startAcknowledgement = startAcknowledgement
    await expect(observeConsoleJobProcess(f.runtime, f.identity)).resolves.toMatchObject({
      state: 'exited',
      proof: { kind: 'exited', process_exit_code: 37 }
    })
    const handshake = readConsoleJobProcessHandshake(f.db, f.identity)!
    expect(handshake.released!.sequence).toBeLessThan(handshake.physicalExit!.sequence)
  })

  it('runs memory redaction before committing physical proof and refuses altered receipts', async () => {
    const f = fixture()
    f.exit(37)
    const redact = vi
      .spyOn(ConsoleWorkflowCredentialMemory, 'redactConsoleWorkflowMemory')
      .mockImplementation((value) =>
        JSON.parse(JSON.stringify(value).replaceAll(f.gate.gateId, '[redacted]'))
      )
    await expect(observeConsoleJobProcess(f.runtime, f.identity)).rejects.toThrow('protected data')
    expect(redact).toHaveBeenCalled()
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeUndefined()
  })

  it('a changed provider cannot select another natural-exit policy', async () => {
    const f = fixture()
    f.settle()
    const record = f.record()
    record.attempt.job.provider = 'codex'
    await expect(finishConsoleJobProcess(f.runtime, record)).rejects.toThrow('frozen Dispatch')
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
  })
})
