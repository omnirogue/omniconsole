import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeAutomationRunTerminalObserver } from './runtime-terminal-run-observer'
import type { AutomationRunTerminalHost } from './runtime-terminal-run-observer'
import type { AutomationRunCompletionObservation } from './run-completion-watcher'
import type { AutomationRun } from '../../shared/automations-types'

const HANDLE = 'terminal-1'
const RUNTIME_TUI_IDLE_TIMEOUT_MS = 5 * 60 * 1000

/** The three shapes the runtime satisfies tui-idle from. `lastAgentStatus` is the
 *  sticky pty record, `paneTitle` the leaf branch's inlined title read, `preview`
 *  the ready-shell-prompt match. All three are level, none require an edge. */
type FakePane = {
  lastAgentStatus: 'idle' | 'working' | 'permission' | null
  paneTitle: string | null
  preview: string
  blockedReason?: string
}

type FakeWaiter = {
  resolve: (value: { satisfied: boolean; blockedReason?: string }) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function createFakeRuntime(initial: Partial<FakePane>) {
  const pane: FakePane = {
    lastAgentStatus: null,
    paneTitle: null,
    preview: '',
    ...initial
  }
  const waiters = new Set<FakeWaiter>()
  let waitCalls = 0

  // Mirrors the runtime's tui-idle satisfaction: sticky status, idle title, or a
  // ready shell prompt — whichever is true at the instant of the read.
  const satisfiedNow = (): boolean =>
    pane.lastAgentStatus === 'idle' ||
    (pane.paneTitle?.toLowerCase().includes('idle') ?? false) ||
    pane.preview.trimEnd().endsWith('$')

  const runtime: AutomationRunTerminalHost & {
    setPane: (next: Partial<FakePane>) => void
    waitCalls: () => number
  } = {
    getTerminalHandleForPaneKey: () => HANDLE,
    getFreshAgentHookStatusForHandle: () => ({ state: 'done' }),
    readTerminal: async () => ({ tail: ['previous run output'] }),
    waitForTerminal: (_handle, options) => {
      waitCalls += 1
      if (options?.signal?.aborted) {
        return Promise.reject(new Error('request_aborted'))
      }
      if (pane.blockedReason) {
        return Promise.resolve({ satisfied: false, blockedReason: pane.blockedReason })
      }
      if (satisfiedNow()) {
        return Promise.resolve({ satisfied: true })
      }
      return new Promise((resolve, reject) => {
        const waiter: FakeWaiter = {
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            reject(new Error('timeout'))
          }, options?.timeoutMs ?? RUNTIME_TUI_IDLE_TIMEOUT_MS)
        }
        waiters.add(waiter)
      })
    },
    setPane: (next) => {
      Object.assign(pane, next)
      if (!pane.blockedReason && !satisfiedNow()) {
        return
      }
      for (const waiter of waiters) {
        waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve({
          satisfied: !pane.blockedReason,
          ...(pane.blockedReason ? { blockedReason: pane.blockedReason } : {})
        })
      }
    },
    waitCalls: () => waitCalls
  }
  return runtime
}

function retainedRun(): AutomationRun {
  return {
    id: 'run',
    automationId: 'routine',
    title: 'Report',
    scheduledFor: Date.now(),
    status: 'dispatched',
    trigger: 'scheduled',
    workspaceId: 'wt',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab',
    terminalPaneKey: 'pane',
    terminalPtyId: 'pty',
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: Date.now(),
    dispatchedAt: Date.now(),
    createdAt: Date.now()
  }
}

function observe(runtime: AutomationRunTerminalHost, current?: AutomationRun) {
  const controller = new AbortController()
  const settled: (AutomationRunCompletionObservation | null)[] = []
  const errors: unknown[] = []
  const observer = createRuntimeAutomationRunTerminalObserver(runtime)
  const promise = observer
    .observeCompletion(HANDLE, {
      signal: controller.signal,
      ...(current ? { readCurrentRun: () => current } : {})
    })
    .then((observation) => {
      settled.push(observation)
    })
    .catch((error: unknown) => {
      errors.push(error)
    })
  return { controller, settled, errors, promise }
}

describe('createRuntimeAutomationRunTerminalObserver', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    'codex-trust-workspace',
    'codex-hooks-review-prompt',
    'codex-interactive-prompt',
    'agent-approval-prompt'
  ])('keeps %s attached until the same worker continues and completes', async (blockedReason) => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'permission', blockedReason })
    runtime.getFreshAgentHookStatusForHandle = () => null
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(run.settled).toEqual([])
    expect(run.errors).toEqual([])
    expect(runtime.waitCalls()).toBeGreaterThan(2)

    runtime.setPane({ lastAgentStatus: 'working', blockedReason: undefined })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])
    runtime.setPane({ lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled[0]?.status).toBe('completed')
    await run.promise
  })

  it('keeps a genuine failed hook final even when a supported prompt remains visible', async () => {
    const runtime = createFakeRuntime({
      lastAgentStatus: 'permission',
      blockedReason: 'agent-approval-prompt'
    })
    runtime.getFreshAgentHookStatusForHandle = () => ({ state: 'done', failed: true })
    const run = observe(runtime)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled[0]?.status).toBe('dispatch_failed')
    await run.promise
  })

  it('preserves failure for a blocker outside the supported input prompts', async () => {
    const runtime = createFakeRuntime({
      lastAgentStatus: 'permission',
      blockedReason: 'provider-authentication'
    })
    runtime.getFreshAgentHookStatusForHandle = () => null
    const run = observe(runtime)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled[0]?.status).toBe('dispatch_failed')
    await run.promise
  })

  it('keeps the existing observation budget while waiting for approval', async () => {
    const runtime = createFakeRuntime({
      lastAgentStatus: 'permission',
      blockedReason: 'agent-approval-prompt'
    })
    runtime.getFreshAgentHookStatusForHandle = () => null
    const run = observe(runtime)
    await vi.advanceTimersByTimeAsync(1_000)
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(run.settled).toEqual([null])
    await run.promise
  })

  it.each([
    [{ state: 'done', failed: true, failureReason: 'Usage limit reached' }, 'Usage limit reached'],
    [{ state: 'done', interrupted: true }, 'cancelled']
  ])('fails a run whose hook reports failure despite idle evidence: %j', async (hook, reason) => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'working' })
    runtime.getFreshAgentHookStatusForHandle = () => hook
    const run = observe(runtime)
    await vi.advanceTimersByTimeAsync(1_000)
    runtime.setPane({ lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled[0]?.status).toBe('dispatch_failed')
    expect(run.settled[0]?.error).toContain(reason)
    await run.promise
  })

  // Why: Codex keeps a ready prompt visible while it works, so the screen can look idle
  // mid-turn. The hook is the truth; an unfinished hook keeps the run open, never fails it.
  it.each([[{ state: 'done', sessionBoundary: true }], [{ state: 'working' }]])(
    'keeps waiting while the hook is unfinished and completes on its clean done: %j',
    async (unfinished) => {
      const runtime = createFakeRuntime({ lastAgentStatus: 'working' })
      let hook: { state: string; sessionBoundary?: boolean } = unfinished
      runtime.getFreshAgentHookStatusForHandle = () => hook
      const run = observe(runtime)
      await vi.advanceTimersByTimeAsync(1_000)
      runtime.setPane({ lastAgentStatus: 'idle' })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(run.settled).toEqual([])
      hook = { state: 'done' }
      await vi.advanceTimersByTimeAsync(1_000)
      expect(run.settled[0]?.status).toBe('completed')
      await run.promise
    }
  )

  it('preserves hook-less automation completion after a real working-to-idle transition', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'idle' })
    runtime.getFreshAgentHookStatusForHandle = () => null
    const run = observe(runtime)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])
    runtime.setPane({ lastAgentStatus: 'working' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])
    runtime.setPane({ lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled[0]?.status).toBe('completed')
    await run.promise
  })

  it.each(['osc', 'hook-less'])(
    'preserves a real busy edge with retained watcher context and no provider identity: %s',
    async (kind) => {
      const runtime = createFakeRuntime({ lastAgentStatus: 'idle' })
      runtime.showTerminal = async () => ({ ptyId: 'pty' })
      runtime.getFreshAgentHookStatusForHandle = () =>
        kind === 'hook-less'
          ? null
          : {
              state: 'done',
              observation: {
                origin: 'osc',
                kind: 'snapshot',
                authorityId: 'renderer',
                incarnation: 1,
                revision: 1,
                observedAt: Date.now()
              }
            }
      const run = observe(runtime, retainedRun())
      await vi.advanceTimersByTimeAsync(1_000)
      runtime.setPane({ lastAgentStatus: 'working' })
      await vi.advanceTimersByTimeAsync(1_000)
      runtime.setPane({ lastAgentStatus: 'idle' })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(run.settled[0]?.status).toBe('completed')
      await run.promise
    }
  )

  it('does not complete the old run when a hook-less pane is replaced after its busy edge', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'working' })
    runtime.getFreshAgentHookStatusForHandle = () => null
    runtime.showTerminal = async () => ({ ptyId: 'replacement' })
    const run = observe(runtime, retainedRun())
    await vi.advanceTimersByTimeAsync(1_000)
    runtime.setPane({ lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])
    run.controller.abort()
    await run.promise
  })

  it('ignores a visible ready prompt while the live agent is still working', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'working', preview: 'ready $' })
    let status: 'working' | 'idle' = 'working'
    const liveRuntime = {
      ...runtime,
      getTerminalAgentStatus: async () => ({ isRunningAgent: true, status })
    }
    const run = observe(liveRuntime)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(run.settled).toEqual([])
    status = 'idle'
    await vi.advanceTimersByTimeAsync(500)
    expect(run.settled[0]?.status).toBe('completed')
    await run.promise
  })

  it('requires a real working edge when an agent is still starting', async () => {
    const runtime = createFakeRuntime({ preview: 'ready $' })
    let status: 'working' | 'idle' | null = null
    const liveRuntime = {
      ...runtime,
      getTerminalAgentStatus: async () => ({ isRunningAgent: status !== null, status })
    }
    const run = observe(liveRuntime)
    await vi.advanceTimersByTimeAsync(1_000)
    status = 'idle'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])
    status = 'working'
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])
    status = 'idle'
    await vi.advanceTimersByTimeAsync(500)
    expect(run.settled[0]?.status).toBe('completed')
    await run.promise
  })

  it('does not complete a reused run from the previous run idle status', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'idle' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.settled).toEqual([])
    expect(run.errors).toEqual([])

    runtime.setPane({ lastAgentStatus: 'working' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled[0]?.status).toBe('completed')
    await run.promise
  })

  it('does not complete from a stale idle pane title (leaf branch shape)', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: null, paneTitle: '✳ Claude — idle' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ paneTitle: '✳ Claude — working' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ paneTitle: '✳ Claude — idle' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled[0]?.status).toBe('completed')
    await run.promise
  })

  it('does not complete from a ready shell prompt left over at dispatch', async () => {
    const runtime = createFakeRuntime({ preview: 'user@host repo %\n$' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ preview: 'claude is thinking…' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled[0]?.status).toBe('completed')
    await run.promise
  })

  it('keeps an unproven start open, backs off and ends observation without failing it', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'idle' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1_000)
    expect(run.settled).toEqual([])
    const callsAtBackoff = runtime.waitCalls()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(runtime.waitCalls() - callsAtBackoff).toBeLessThanOrEqual(5)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(run.settled).toEqual([null])
    await run.promise
  })

  it('completes a fresh launch that was never idle at dispatch', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'working' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.settled).toEqual([])

    runtime.setPane({ lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(10)
    expect(run.settled[0]?.status).toBe('completed')
    expect(run.settled[0]?.outputSnapshot?.content).toContain('previous run output')
    await run.promise
  })

  it('fails a hook-less idle pane that shows the Codex resume-lock banner (2026-09-20)', async () => {
    // A `codex resume` of a thread still open in another pane: the TUI redraws the previous
    // run's report, then "Conversation interrupted · open in another app · R to Retry".
    const runtime = createFakeRuntime({ lastAgentStatus: 'working' })
    runtime.getFreshAgentHookStatusForHandle = () => null
    runtime.readTerminal = async () => ({
      tail: [
        '  Worked for 8m 30s · done 4:08 PM',
        '',
        '■ Conversation interrupted - tell the model what to do differently.',
        '    🔒  This conversation is open in another app          R to Retry',
        '    r retry   esc/ctrl+c/q exit   ctrl+t transcript%'
      ]
    })
    const run = observe(runtime)
    await vi.advanceTimersByTimeAsync(1_000)
    runtime.setPane({ lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(10)
    expect(run.settled[0]?.status).toBe('dispatch_failed')
    expect(run.settled[0]?.error).toMatch(/open in another app/)
    expect(run.settled[0]?.error).not.toMatch(/[■🔒│]/u)
    await run.promise
  })

  it('stops re-arming the tui-idle wait instead of looping for the process lifetime', async () => {
    const runtime = createFakeRuntime({ lastAgentStatus: 'working' })
    const run = observe(runtime)

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + RUNTIME_TUI_IDLE_TIMEOUT_MS)
    expect(run.settled).toEqual([null])
    // 6h of 5-minute waits, not an unbounded re-arm.
    expect(runtime.waitCalls()).toBeLessThanOrEqual(80)
    await run.promise
  })
})
