import { describe, expect, it, vi } from 'vitest'
import { createWorkerNaturalExitFixture as fixture } from './orchestration-worker-natural-exit.test-fixture'

describe('settled worker natural exit', () => {
  it('requests the configured command and returns the physical exact-process exit', async () => {
    const f = fixture()
    expect(await f.run()).toMatchObject({
      status: 'exited',
      gate: f.gate,
      exitCode: 0,
      exitCause: { kind: 'exited', exitCode: 0 }
    })
    expect(f.runtime.sendTerminal).toHaveBeenCalledWith(
      'term-1',
      { text: '/exit', enter: true },
      expect.any(Object)
    )
    expect(f.runtime.getOrchestrationDispatchAuthority()).toBeNull()
    expect(f.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(f.resource.release_state).toBe('not_requested')
  })

  it('uses an already observed exit without requiring another live authority or input policy', async () => {
    const f = fixture()
    f.state.observation!.agent = 'grok'
    f.exit(37)
    expect(await f.run()).toMatchObject({ status: 'exited', exitCode: 37 })
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
    expect(f.runtime.waitForTerminal).not.toHaveBeenCalled()
  })

  it.each(['codex', 'grok', 'claude-agent-teams'] as const)(
    'refuses an unverified %s exit request',
    async (agent) => {
      const f = fixture()
      f.state.observation!.agent = agent
      expect(await f.run()).toMatchObject({
        status: 'refused',
        reason: 'provider_graceful_exit_unsupported'
      })
      expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['missing cause', undefined, 'unverifiable'],
    ['unknown cause', { kind: 'unknown', reason: 'cause_unreported' }, 'unverifiable'],
    ['signaled zero', { kind: 'signaled', signal: 9 }, 'refused'],
    ['operator close', { kind: 'operator_close' }, 'refused'],
    ['contradictory code', { kind: 'exited', exitCode: 37 }, 'refused']
  ] as const)('does not accept %s', async (_label, cause, status) => {
    const f = fixture()
    f.exit()
    f.state.observation!.exit!.wait.exitCause = cause
    expect(await f.run()).toMatchObject({ status })
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it.each(['pid', 'processStartTimeMs', 'incarnationId', 'ptyId', 'gateId'] as const)(
    'fences a changed %s',
    async (field) => {
      const f = fixture()
      f.exit()
      Object.assign(f.state.observation!.gate, {
        [field]: typeof f.gate[field] === 'number' ? 99 : 'other'
      })
      expect(await f.run()).toMatchObject({ status: 'unverifiable' })
      expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
    }
  )

  it.each(['providerExitObserved', 'observedAt', 'wait'] as const)(
    'needs physical receipt field %s',
    async (field) => {
      const f = fixture()
      f.exit()
      Object.assign(f.state.observation!.exit!, {
        [field]: field === 'observedAt' ? '' : field === 'providerExitObserved' ? false : undefined
      })
      expect(await f.run()).not.toMatchObject({ status: 'exited' })
    }
  )

  it('refuses shell startup even after a natural shell zero', async () => {
    const f = fixture()
    f.gate.startupCommandMode = 'shell'
    f.state.observation!.gate.startupCommandMode = 'shell'
    f.exit()
    expect(await f.run()).toMatchObject({
      status: 'refused',
      reason: 'provider_exit_fidelity_unproven'
    })
  })

  it('refuses macOS login wrapper status and a gate that was never released', async () => {
    const wrapped = fixture()
    wrapped.gate.reportsChildExitStatus = false
    wrapped.state.observation!.gate.reportsChildExitStatus = false
    wrapped.exit()
    expect(await wrapped.run()).toMatchObject({ status: 'refused' })
    const closed = fixture()
    closed.state.observation!.launchGateReleased = false
    closed.exit()
    expect(await closed.run()).toMatchObject({ status: 'refused' })
  })

  it.each(['ready', 'stopped', 'abandoned'])('refuses worker state %s', async (state) => {
    const f = fixture()
    f.worker.state = state
    expect(await f.run()).toMatchObject({ status: 'refused' })
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it.each(['user_owned', 'transferred', 'external'] as const)(
    'refuses %s ownership',
    async (state) => {
      const f = fixture()
      f.resource.ownership_state = state
      expect(await f.run()).toMatchObject({ status: 'refused' })
      expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
    }
  )

  it('refuses release intent, host mismatch, identity conflict and changed pane', async () => {
    const release = fixture()
    release.resource.release_state = 'requested'
    expect(await release.run()).toMatchObject({ status: 'refused' })
    const host = fixture()
    host.resource.host_scope = JSON.stringify({ kind: 'ssh', targetId: 'remote' })
    expect(await host.run()).toMatchObject({ status: 'unverifiable' })
    const conflict = fixture()
    conflict.db.workerTerminalResourceHasIdentityConflict.mockReturnValue(true)
    expect(await conflict.run()).toMatchObject({ status: 'refused' })
    const pane = fixture()
    pane.runtime.getTerminalPaneKey.mockReturnValue('other-pane')
    expect(await pane.run()).toMatchObject({ status: 'refused' })
  })

  it('does not turn terminal wait zero or lost contact into a physical receipt', async () => {
    const f = fixture()
    f.runtime.waitForTerminal.mockImplementation(async (_handle, options) => ({
      handle: 'term-1',
      condition: options.condition,
      satisfied: true,
      status: options.condition === 'exit' ? 'exited' : 'running',
      exitCode: 0,
      exitCause: { kind: 'exited', exitCode: 0 }
    }))
    expect(await f.run()).toMatchObject({ status: 'live' })
    f.observeProcess.mockRejectedValue(new Error('host disconnected'))
    expect(await f.run()).toMatchObject({ status: 'unverifiable' })
  })

  it('does not type into a blocked or unsettled composer', async () => {
    const f = fixture()
    f.runtime.waitForTerminal.mockResolvedValue({
      handle: 'term-1',
      condition: 'tui-idle',
      satisfied: false,
      status: 'running',
      exitCode: null,
      blockedReason: 'agent-approval-prompt'
    })
    expect(await f.run()).toMatchObject({ status: 'refused', reason: 'provider_not_idle' })
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
  })

  it('rechecks ownership synchronously after the asynchronous write check', async () => {
    const f = fixture()
    const write = vi.fn()
    f.runtime.sendTerminal.mockImplementation(async (_handle, _action, options) => {
      await options.beforeWrite(f.gate.ptyId)
      f.resource.ownership_state = 'user_owned'
      options.reserveWrite(f.gate.ptyId)
      write()
      return { handle: 'term-1', accepted: true, bytesWritten: 6 }
    })
    expect(await f.run()).toMatchObject({ status: 'refused' })
    expect(write).not.toHaveBeenCalled()
  })

  it('coalesces concurrent requests and never repeats a partial write', async () => {
    const f = fixture()
    f.runtime.sendTerminal.mockImplementation(async (_handle, _action, options) => {
      await options.beforeWrite(f.gate.ptyId)
      options.reserveWrite(f.gate.ptyId)
      throw new Error('input acknowledgement lost')
    })
    const first = f.run()
    expect(f.run()).toBe(first)
    expect(await first).toMatchObject({ status: 'unverifiable' })
    f.runtime.waitForTerminal.mockRejectedValue(new Error('timeout'))
    expect(await f.run()).toMatchObject({ status: 'live' })
    expect(f.runtime.sendTerminal).toHaveBeenCalledTimes(1)
  })

  it('refuses an exit timestamp before the registered process was born', async () => {
    const f = fixture()
    f.exit()
    f.state.observation!.exit!.observedAt = new Date(f.gate.processStartTimeMs - 1).toISOString()
    expect(await f.run()).toMatchObject({ status: 'unverifiable' })
  })

  it('pins the original identity across retries even if the caller replaces its PID', async () => {
    const f = fixture()
    f.runtime.waitForTerminal.mockRejectedValue(new Error('timeout'))
    expect(await f.run()).toMatchObject({ status: 'unverifiable' })
    f.gate.pid++
    expect(await f.run()).toMatchObject({
      status: 'refused',
      reason: 'worker_exit_identity_changed'
    })
    expect(f.runtime.sendTerminal).not.toHaveBeenCalled()
  })
})
