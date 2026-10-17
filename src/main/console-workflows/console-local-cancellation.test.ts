import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationCaller } from '../runtime/build-review/build-review-rpc-call'
import {
  readConsoleJobProcessHandshake,
  recordConsoleJobProcessHandshake
} from '../runtime/orchestration/console-job-process-handshake'
import { attachConsoleJobProcessStart } from '../runtime/orchestration/console-job-process-test-fixture'
import { cancelConsoleLocalExecution } from './console-local-cancellation'
import { createConsoleProcessObservationFixture } from './console-job-process-observation.test-fixture'

describe('console cancellation physical proof', () => {
  const fixtures: ReturnType<typeof createConsoleProcessObservationFixture>[] = []
  function fixture(released = true) {
    const f = createConsoleProcessObservationFixture(':memory:', released)
    fixtures.push(f)
    return f
  }
  afterEach(() => {
    for (const f of fixtures.splice(0)) {
      f.db.close()
    }
    vi.restoreAllMocks()
  })

  it('stops only the bound Dispatch through the real RPC and journals death before its result', async () => {
    const f = fixture()
    const call = vi.fn(f.ctx.call)
    const recordResult = vi.mocked(f.ctx.results.record).getMockImplementation()!
    vi.mocked(f.ctx.results.record).mockImplementation((record, result) => {
      expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeDefined()
      recordResult(record, result)
    })
    const view = await cancelConsoleLocalExecution(
      { ...f.ctx, call: call as OrchestrationCaller },
      f.record()
    )
    expect(view.state).toBe('cancelled')
    expect(call).toHaveBeenCalledExactlyOnceWith('orchestration.workerStop', {
      dispatch: f.identity.dispatchId
    })
    expect(f.runtime.closeTerminal).toHaveBeenCalledExactlyOnceWith('term_process')
    expect(f.db.getWorkerDispatch(f.identity.dispatchId)?.state).toBe('stopped')
    expect(f.ctx.results.read(f.identity.dispatchId)).toMatchObject({
      status: 'cancelled',
      exit_code: null,
      terminal_proof: {
        kind: 'exited',
        process_exit_code: null,
        exit_cause: { kind: 'signaled', signal: 15 },
        process_identity: { pid: f.gate.pid }
      }
    })
    expect(f.ctx.results.flush).toHaveBeenCalledTimes(1)
  })

  it('workerStop confirmed alone cannot publish cancellation', async () => {
    const f = fixture()
    vi.mocked(f.runtime.closeTerminal).mockResolvedValue({
      handle: 'term_process',
      tabId: 'tab_process',
      ptyKilled: true
    })
    const view = await cancelConsoleLocalExecution(f.ctx, f.record())
    expect(f.db.getWorkerDispatch(f.identity.dispatchId)?.state).toBe('stopped')
    expect(view.state).toBe('unverifiable')
    expect(f.ctx.results.record).not.toHaveBeenCalled()
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeUndefined()
  })

  it('lost contact after an ambiguous stop stays unverifiable and is not stopped twice', async () => {
    const f = fixture()
    vi.mocked(f.runtime.closeTerminal).mockImplementation(async () => {
      f.state.observation = { ...f.fields, state: 'unverifiable', reason: 'contact lost' }
      return {
        handle: 'term_process',
        tabId: 'tab_process',
        ptyKilled: false,
        ptyStopVerdict: 'unverifiable'
      }
    })
    expect((await cancelConsoleLocalExecution(f.ctx, f.record())).state).toBe('unverifiable')
    expect((await cancelConsoleLocalExecution(f.ctx, f.record())).state).toBe('unverifiable')
    expect(f.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(f.ctx.results.record).not.toHaveBeenCalled()
  })

  it('a recovered exact exit can complete cancellation after an ambiguous stop', async () => {
    const f = fixture()
    vi.mocked(f.runtime.closeTerminal).mockResolvedValue({
      handle: 'term_process',
      tabId: 'tab_process',
      ptyKilled: false
    })
    expect((await cancelConsoleLocalExecution(f.ctx, f.record())).state).toBe('unverifiable')
    f.exit(null, 9)
    expect((await cancelConsoleLocalExecution(f.ctx, f.record())).state).toBe('cancelled')
    expect(f.runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('cancels a physically dead closed gate with canonical not_started proof', async () => {
    const f = fixture(false)
    expect((await cancelConsoleLocalExecution(f.ctx, f.record())).state).toBe('cancelled')
    expect(f.ctx.results.read(f.identity.dispatchId)?.terminal_proof).toMatchObject({
      kind: 'not_started',
      launch_gate_closed: true,
      process_exited: true,
      process_exit_code: null,
      exit_cause: { kind: 'signaled', signal: 15 }
    })
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.startAcknowledged).toBeUndefined()
  })

  it.each([false, true])(
    'proves a registered but closed process without inventing start state (journal acknowledgement %s)',
    async (acknowledged) => {
      const f = fixture(false)
      attachConsoleJobProcessStart(f.db, f.identity)
      if (acknowledged) {
        recordConsoleJobProcessHandshake(f.db, f.identity, {
          phase: 'start_acknowledged',
          gate: f.gate
        })
      }
      const record = f.record()
      const binding = { ...record.binding }
      expect(binding.sessionId).toBe('ses_canonical')
      expect((await cancelConsoleLocalExecution(f.ctx, record)).state).toBe('cancelled')
      expect(f.ctx.results.read(f.identity.dispatchId)?.terminal_proof).toMatchObject({
        kind: 'not_started',
        launch_gate_closed: true,
        process_exited: true,
        process_identity: { pid: f.gate.pid },
        exit_cause: { kind: 'signaled', signal: 15 }
      })
      expect(f.record().binding).toEqual(binding)
      expect(Boolean(readConsoleJobProcessHandshake(f.db, f.identity)?.startAcknowledged)).toBe(
        acknowledged
      )
      expect(readConsoleJobProcessHandshake(f.db, f.identity)?.released).toBeUndefined()
    }
  )

  it('does not label an uncertain release intent as not_started', async () => {
    const f = fixture(false)
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
    f.exit(null, 15)
    expect((await cancelConsoleLocalExecution(f.ctx, f.record())).state).toBe('unverifiable')
    expect(f.ctx.results.record).not.toHaveBeenCalled()
    expect(readConsoleJobProcessHandshake(f.db, f.identity)?.physicalExit).toBeUndefined()
  })

  it.each(['pid', 'processStartTimeMs'] as const)(
    'does not stop or publish from a mismatched host %s',
    async (field) => {
      const f = fixture()
      f.state.observation[field] += 1
      expect((await cancelConsoleLocalExecution(f.ctx, f.record())).state).toBe('unverifiable')
      expect(f.runtime.closeTerminal).not.toHaveBeenCalled()
      expect(f.ctx.results.record).not.toHaveBeenCalled()
    }
  )

  it('requires the original signed-in principal before cancellation', async () => {
    const f = fixture()
    vi.mocked(f.ctx.port.principal).mockResolvedValue('b'.repeat(64))
    await expect(cancelConsoleLocalExecution(f.ctx, f.record())).rejects.toThrow('signed-in person')
    expect(f.runtime.closeTerminal).not.toHaveBeenCalled()
  })

  it('will not close a terminal after ownership was taken over', async () => {
    const f = fixture()
    const resource = f.db.getWorkerTerminalResourceByOwner(f.identity.dispatchId)!
    f.db.markWorkerTerminalUserOwned(resource.pane_key!)
    expect((await cancelConsoleLocalExecution(f.ctx, f.record())).state).toBe('unverifiable')
    expect(f.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(f.ctx.results.record).not.toHaveBeenCalled()
  })

  it('waits for the separate host receipt after stop acknowledgement without another stop', async () => {
    const f = fixture()
    let polls = 0
    vi.mocked(f.runtime.closeTerminal).mockResolvedValue({
      handle: 'term_process',
      tabId: 'tab_process',
      ptyKilled: true
    })
    vi.mocked(f.runtime.readTerminalLaunchGateObservation).mockImplementation(async () => {
      if (++polls === 3) {
        f.exit(null, 15)
      }
      return f.state.observation
    })
    expect((await cancelConsoleLocalExecution(f.ctx, f.record())).state).toBe('cancelled')
    expect(f.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(polls).toBe(3)
  })
})
