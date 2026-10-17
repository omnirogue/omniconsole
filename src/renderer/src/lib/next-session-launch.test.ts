import { describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalWait } from '../../../shared/runtime-types'
import {
  createTerminalWaitDependencies,
  runNextSessionAfterCompletion,
  SourceSessionFailedError,
  waitForSourceSessionCompletion,
  waitForSourceSessionStop,
  type NextSessionLaunchDependencies
} from './next-session-launch'

const rpc = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc.callRuntimeRpc,
  getActiveRuntimeTarget: () => ({ kind: 'local' })
}))

function wait(overrides: Partial<RuntimeTerminalWait> = {}): RuntimeTerminalWait {
  return {
    handle: 'term_source',
    condition: 'tui-idle',
    satisfied: true,
    status: 'running',
    exitCode: null,
    ...overrides
  }
}

function dependencies(
  overrides: Partial<NextSessionLaunchDependencies> = {}
): NextSessionLaunchDependencies {
  return {
    resolveSource: vi.fn().mockResolvedValue({ handle: 'term_source' }),
    waitForIdle: vi.fn().mockResolvedValue(wait()),
    waitForExit: vi
      .fn()
      .mockResolvedValue(wait({ condition: 'exit', status: 'exited', exitCode: 0 })),
    launch: vi.fn().mockResolvedValue(true),
    ...overrides
  }
}

describe('runNextSessionAfterCompletion', () => {
  it('does not launch before the source session reports idle', async () => {
    let finish: ((value: RuntimeTerminalWait) => void) | undefined
    const waitForIdle = vi.fn(
      () =>
        new Promise<RuntimeTerminalWait>((resolve) => {
          finish = resolve
        })
    )
    const deps = dependencies({ waitForIdle })
    const pending = runNextSessionAfterCompletion(deps)

    await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalledWith('term_source'))
    expect(deps.launch).not.toHaveBeenCalled()
    finish?.(wait())
    await pending
    expect(deps.launch).toHaveBeenCalledOnce()
  })

  it('re-arms a bounded wait instead of treating timeout as completion', async () => {
    const waitForIdle = vi
      .fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(wait())
    const deps = dependencies({ waitForIdle })

    await runNextSessionAfterCompletion(deps)

    expect(waitForIdle).toHaveBeenCalledTimes(2)
    expect(deps.launch).toHaveBeenCalledOnce()
  })

  it('never advances past an approval or permission blocker', async () => {
    const deps = dependencies({
      waitForIdle: vi
        .fn()
        .mockResolvedValue(wait({ satisfied: false, blockedReason: 'agent-approval-prompt' }))
    })

    await expect(runNextSessionAfterCompletion(deps)).rejects.toThrow(
      'source session needs attention'
    )
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it('advances after a proven zero exit', async () => {
    const deps = dependencies({
      waitForIdle: vi.fn().mockRejectedValue(new Error('terminal_exited'))
    })

    await runNextSessionAfterCompletion(deps)

    expect(deps.waitForExit).toHaveBeenCalledWith('term_source')
    expect(deps.launch).toHaveBeenCalledOnce()
  })

  it('refuses a failed or unverifiable exit', async () => {
    for (const exitCode of [7, null]) {
      const deps = dependencies({
        waitForIdle: vi.fn().mockRejectedValue(new Error('terminal_exited')),
        waitForExit: vi
          .fn()
          .mockResolvedValue(wait({ condition: 'exit', status: 'exited', exitCode }))
      })

      await expect(runNextSessionAfterCompletion(deps)).rejects.toThrow()
      expect(deps.launch).not.toHaveBeenCalled()
    }
  })

  it('does not advance after runtime contact loss', async () => {
    const deps = dependencies({
      waitForIdle: vi.fn().mockRejectedValue(new Error('runtime unavailable'))
    })

    await expect(runNextSessionAfterCompletion(deps)).rejects.toThrow('runtime unavailable')
    expect(deps.launch).not.toHaveBeenCalled()
  })
  it('exposes the wait alone so a chain can read the source before launching', async () => {
    const deps = dependencies()
    await expect(waitForSourceSessionCompletion(deps)).resolves.toEqual({ handle: 'term_source' })
    expect(deps.launch).not.toHaveBeenCalled()
  })
  it('skips the host wait when hooks already reported the source finished', async () => {
    // Why: the host forgets idle status across an app restart; the hooks' verdict resumes the chain.
    const deps = dependencies({
      waitForIdle: vi.fn().mockRejectedValue(new Error('timeout')),
      sourceFinishedByHooks: () => true,
      foregroundProcess: vi.fn().mockResolvedValue('2.1.267')
    })

    await expect(waitForSourceSessionCompletion(deps)).resolves.toEqual({ handle: 'term_source' })
    expect(deps.waitForIdle).not.toHaveBeenCalled()
  })

  it('does not trust a finished verdict once a shell owns the pane', async () => {
    const deps = dependencies({
      waitForIdle: vi.fn().mockRejectedValue(new Error('terminal_exited')),
      waitForExit: vi.fn().mockResolvedValue({ status: 'exited', exitCode: 3 }),
      sourceFinishedByHooks: () => true,
      foregroundProcess: vi.fn().mockResolvedValue('zsh')
    })

    await expect(runNextSessionAfterCompletion(deps)).rejects.toThrow('exited with code 3')
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it('re-resolves the pane when the host reports the wait handle stale', async () => {
    const deps = dependencies({
      resolveSource: vi
        .fn()
        .mockResolvedValueOnce({ handle: 'term_old' })
        .mockResolvedValueOnce({ handle: 'term_new' }),
      waitForIdle: vi
        .fn()
        .mockRejectedValueOnce(new Error('terminal_handle_stale'))
        .mockResolvedValueOnce({ status: 'running', satisfied: true })
    })

    await expect(waitForSourceSessionCompletion(deps)).resolves.toEqual({ handle: 'term_new' })
    expect(deps.waitForIdle).toHaveBeenNthCalledWith(1, 'term_old')
    expect(deps.waitForIdle).toHaveBeenNthCalledWith(2, 'term_new')
  })

  it('gives up on a handle that stays stale', async () => {
    const deps = dependencies({
      resolveSource: vi.fn().mockResolvedValue({ handle: 'term_x' }),
      waitForIdle: vi.fn().mockRejectedValue(new Error('terminal_handle_stale'))
    })

    await expect(runNextSessionAfterCompletion(deps)).rejects.toThrow('terminal_handle_stale')
    expect(deps.waitForIdle).toHaveBeenCalledTimes(4)
    expect(deps.launch).not.toHaveBeenCalled()
  })

  it('fails instead of re-arming forever when the agent left the pane', async () => {
    const deps = dependencies({
      waitForIdle: vi.fn().mockRejectedValue(new Error('timeout')),
      assertAgentAlive: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("The session's agent is no longer running"))
    })

    await expect(runNextSessionAfterCompletion(deps)).rejects.toThrow('no longer running')
    expect(deps.waitForIdle).toHaveBeenCalledTimes(2)
    expect(deps.launch).not.toHaveBeenCalled()
  })
})

describe('waitForSourceSessionStop', () => {
  it('tells a host-observed zero exit apart from a stop at the prompt', async () => {
    await expect(waitForSourceSessionStop(dependencies())).resolves.toEqual({
      source: { handle: 'term_source' },
      exited: false
    })
    const exited = dependencies({
      waitForIdle: vi.fn().mockRejectedValue(new Error('terminal_exited'))
    })
    await expect(waitForSourceSessionStop(exited)).resolves.toEqual({
      source: { handle: 'term_source' },
      exited: true
    })
  })

  it('types only host-observed bad ends as a failed source; anything else stays unverifiable', async () => {
    const exitedWith = (exitCode: number | null) =>
      dependencies({
        waitForIdle: vi.fn().mockRejectedValue(new Error('terminal_exited')),
        waitForExit: vi
          .fn()
          .mockResolvedValue(wait({ condition: 'exit', status: 'exited', exitCode }))
      })
    const failed = [
      dependencies({
        waitForIdle: vi
          .fn()
          .mockResolvedValue(wait({ satisfied: false, blockedReason: 'agent-approval-prompt' }))
      }),
      exitedWith(2),
      exitedWith(null)
    ]
    for (const deps of failed) {
      await expect(waitForSourceSessionStop(deps)).rejects.toBeInstanceOf(SourceSessionFailedError)
    }
    const unverifiable = [
      dependencies({ waitForIdle: vi.fn().mockRejectedValue(new Error('runtime unavailable')) }),
      dependencies({ waitForIdle: vi.fn().mockResolvedValue(wait({ satisfied: false })) }),
      dependencies({
        waitForIdle: vi.fn().mockRejectedValue(new Error('terminal_exited')),
        waitForExit: vi.fn().mockResolvedValue(wait({ condition: 'exit', status: 'running' }))
      }),
      dependencies({
        resolveSource: vi.fn().mockResolvedValue({ handle: 'term_x' }),
        waitForIdle: vi.fn().mockRejectedValue(new Error('terminal_handle_stale'))
      })
    ]
    for (const deps of unverifiable) {
      const error = await waitForSourceSessionStop(deps).catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(SourceSessionFailedError)
    }
  })

  it('types an agent back at its shell as a failed source and waits for exit as long as asked', async () => {
    const deps = createTerminalWaitDependencies(
      { kind: 'local' },
      { sourcePaneKey: 'tab-1:leaf-1', worktreeId: 'folder:f1' }
    )
    rpc.callRuntimeRpc.mockResolvedValueOnce({ process: { foregroundProcess: 'zsh' } })
    await expect(deps.assertAgentAlive?.('term_1')).rejects.toBeInstanceOf(SourceSessionFailedError)
    rpc.callRuntimeRpc.mockResolvedValueOnce({ wait: wait({ condition: 'exit' }) })
    await deps.waitForExit('term_1', 600_000)
    expect(rpc.callRuntimeRpc).toHaveBeenLastCalledWith(
      { kind: 'local' },
      'terminal.wait',
      { terminal: 'term_1', for: 'exit', timeoutMs: 600_000 },
      { timeoutMs: 605_000, signal: undefined }
    )
  })
})
