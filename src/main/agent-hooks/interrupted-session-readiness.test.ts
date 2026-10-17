import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/omni-runtime'
import { watchInterruptedSessionReadiness } from './interrupted-session-readiness'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe.each(['omp', 'pi', 'opencode'] as const)('%s prompt readiness fallback', (agentType) => {
  function fixture() {
    vi.useFakeTimers()
    let ownsPane = true
    let enabled = true
    const status = vi.fn(async () => ({
      isRunningAgent: true,
      status: 'idle' as string | null
    }))
    const wait = vi.fn(async (): Promise<unknown> => null)
    const incarnation = vi.fn(() => 'incarnation')
    const observe = vi.fn()
    const stop = watchInterruptedSessionReadiness({
      runtime: {
        getTerminalHandleForPaneKey: () => 'handle',
        getTerminalProcessIncarnation: incarnation,
        getTerminalInteractiveWait: wait,
        getTerminalAgentStatus: status
      } as unknown as OrcaRuntimeService,
      paneKey: 'pane',
      ownsPane: () => ownsPane,
      enabled: () => enabled,
      event: {
        paneKey: 'pane',
        connectionId: null,
        launchToken: 'replacement',
        providerSession: { key: 'session_id', id: 'thread' },
        hookEventName: 'SessionStart',
        payload: {
          agentType,
          state: 'done',
          prompt: '',
          sessionBoundary: true
        }
      },
      observe
    })
    return {
      status,
      wait,
      incarnation,
      observe,
      stop,
      replace: () => {
        ownsPane = false
      },
      disable: () => {
        enabled = false
      }
    }
  }

  it('emits exactly one boundary after positive prompt evidence', async () => {
    const f = fixture()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.observe).toHaveBeenCalledTimes(1)
    expect(f.observe.mock.calls[0][0]).toMatchObject({
      hookEventName: 'SessionStart',
      payload: { sessionBoundary: true, agentType }
    })
  })

  it.each(['working', 'permission', null])(
    'never treats %s or elapsed time as readiness',
    async (status) => {
      const f = fixture()
      f.status.mockResolvedValue({ isRunningAgent: true, status })
      await vi.advanceTimersByTimeAsync(10_000)
      expect(f.observe).not.toHaveBeenCalled()
      f.status.mockResolvedValue({ isRunningAgent: true, status: 'idle' })
      await vi.advanceTimersByTimeAsync(250)
      expect(f.observe).toHaveBeenCalledTimes(1)
    }
  )

  it('refuses unreadable prompt checks and shell-only observations', async () => {
    const f = fixture()
    f.wait.mockRejectedValue(new Error('unavailable'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.observe).not.toHaveBeenCalled()
    f.wait.mockResolvedValue(null)
    f.status.mockResolvedValue({ isRunningAgent: false, status: 'idle' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.observe).not.toHaveBeenCalled()
    f.stop()
  })

  it.each(['replace', 'disable', 'stop'] as const)(
    'fences an in-flight reading on %s',
    async (action) => {
      const f = fixture()
      f[action]()
      await vi.advanceTimersByTimeAsync(1000)
      expect(f.observe).not.toHaveBeenCalled()
    }
  )

  it('refuses a changed process incarnation', async () => {
    const f = fixture()
    f.incarnation.mockReturnValueOnce('incarnation').mockReturnValue('replacement-incarnation')
    await vi.advanceTimersByTimeAsync(0)
    expect(f.observe).not.toHaveBeenCalled()
    f.stop()
  })
})
