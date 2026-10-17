import { describe, expect, it, vi } from 'vitest'
import { createWorker } from './build-review-pipeline-state'
import { BuildReviewRpcError, type OrchestrationCaller } from './build-review-rpc-call'
import {
  buildReviewStartupAnswerWait,
  DEFAULT_STARTUP_WAIT_TIMING,
  waitForStartupAnswer,
  type StartupWaitTiming
} from './build-review-startup-wait'
import {
  CancelledError,
  startWorker,
  type ActiveRun,
  type WorkerHostContext
} from './build-review-worker-lifecycle'

const TRUST_SCREEN = [
  'Quick safety check: Is this a project you created or one you trust?',
  '❯ No, exit',
  '  Yes, I trust this folder'
]
const READY_SCREEN = ['╭─ Claude Code', '> ']
/** What Claude leaves when it exits at its trust question: the dialog drawn above the shell. */
const EXITED_OVER_SHELL = [...TRUST_SCREEN, 'Enter to confirm · Esc to cancel', 'me@mac repo % ']
/** What the runtime answers for a worker terminal after "Stop and Close": readable, exited. */
const EXITED = { exited: true } as const

/** A clock that moves one poll per sleep, so no real time passes and the order is fixed. */
function fakeTiming(timeoutMs = 60_000): StartupWaitTiming {
  let now = 0
  return {
    pollMs: 1_000,
    timeoutMs,
    now: () => now,
    sleep: async (ms) => {
      now += ms
    }
  }
}

type Script = {
  /** Successive rendered screens; the last repeats. A string is an RPC error code instead. */
  screens: (string[] | string | typeof EXITED)[]
  /** Successive agent checks; the last repeats. */
  running?: boolean | boolean[]
}

function scripted(script: Script) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let read = 0
  let checked = 0
  const call = (async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    if (method === 'terminal.read') {
      const screen = script.screens[Math.min(read, script.screens.length - 1)]!
      read += 1
      if (typeof screen === 'string') {
        throw new BuildReviewRpcError(method, screen, screen)
      }
      if (screen === EXITED) {
        return { terminal: { status: 'exited', source: 'screen-unavailable', tail: [] } }
      }
      return { terminal: { status: 'running', tail: screen, source: 'screen' } }
    }
    if (method === 'terminal.isRunningAgent') {
      const running = [script.running ?? true].flat()
      checked += 1
      return { isRunningAgent: running[Math.min(checked - 1, running.length - 1)] }
    }
    return {}
  }) as OrchestrationCaller
  return { call, calls }
}

describe('waitForStartupAnswer', () => {
  it('waits while the question is on screen and continues once it is gone and the agent runs', async () => {
    const { call, calls } = scripted({
      screens: [TRUST_SCREEN, TRUST_SCREEN, READY_SCREEN, READY_SCREEN]
    })
    const signal = new AbortController().signal
    await expect(waitForStartupAnswer(call, 'term_1', signal, fakeTiming())).resolves.toBe(
      'answered'
    )
    expect(calls.map(({ method }) => method)).toEqual(
      Array.from({ length: 4 }, () => ['terminal.read', 'terminal.isRunningAgent']).flat()
    )
    expect(calls[0]!.params).toEqual({ terminal: 'term_1', limit: 60, screen: true })
  })

  it('needs two clear reads in a row: a redraw between frames is not an answer', async () => {
    const { call } = scripted({ screens: [READY_SCREEN, TRUST_SCREEN, READY_SCREEN, READY_SCREEN] })
    const timing = fakeTiming()
    await expect(
      waitForStartupAnswer(call, 'term_1', new AbortController().signal, timing)
    ).resolves.toBe('answered')
    expect(timing.now()).toBe(3_000)
  })

  it('sees an agent that exited at its question, though its dialog stays drawn', async () => {
    const { call } = scripted({ screens: [EXITED_OVER_SHELL], running: false })
    const timing = fakeTiming()
    await expect(
      waitForStartupAnswer(call, 'term_1', new AbortController().signal, timing)
    ).resolves.toBe('declined')
    // Two reads agree, one poll apart; not the hour the question may wait.
    expect(timing.now()).toBe(1_000)
    // One probe that blinks is not an exit.
    const blink = scripted({
      screens: [TRUST_SCREEN, READY_SCREEN, READY_SCREEN],
      running: [false, true]
    })
    await expect(
      waitForStartupAnswer(blink.call, 'term_1', new AbortController().signal, fakeTiming())
    ).resolves.toBe('answered')
  })

  it('reads a banner that asks nothing, and an answered question higher up, as clear', async () => {
    const banner = ['✨ Update available! 0.150.0 -> 0.154.0', '╭─ OpenAI Codex', '› ']
    const answered = [
      'Hooks need review',
      '1. Trust all and continue',
      'Press enter to confirm or esc to go back',
      ...Array.from({ length: 24 }, (_, index) => `output ${index}`),
      '› '
    ]
    const { call } = scripted({ screens: [banner, answered] })
    const timing = fakeTiming()
    await expect(
      waitForStartupAnswer(call, 'term_1', new AbortController().signal, timing)
    ).resolves.toBe('answered')
    expect(timing.now()).toBe(1_000)
    const hooks = scripted({ screens: [answered.slice(0, 3)] })
    await expect(
      waitForStartupAnswer(hooks.call, 'term_1', new AbortController().signal, fakeTiming(3_000))
    ).resolves.toBe('timed-out')
  })

  it('reports a closed terminal, a cancel and a question nobody answered', async () => {
    const closed = scripted({ screens: [TRUST_SCREEN, 'terminal_handle_stale'] })
    await expect(
      waitForStartupAnswer(closed.call, 'term_1', new AbortController().signal, fakeTiming())
    ).resolves.toBe('closed')
    // "Stop and Close" as the runtime answers it: the handle stays readable, and has exited.
    const stopped = scripted({ screens: [TRUST_SCREEN, EXITED] })
    await expect(
      waitForStartupAnswer(stopped.call, 'term_1', new AbortController().signal, fakeTiming())
    ).resolves.toBe('closed')
    const abort = new AbortController()
    abort.abort()
    const cancelled = scripted({ screens: [TRUST_SCREEN] })
    await expect(
      waitForStartupAnswer(cancelled.call, 'term_1', abort.signal, fakeTiming())
    ).resolves.toBe('cancelled')
    const unanswered = scripted({ screens: [TRUST_SCREEN] })
    await expect(
      waitForStartupAnswer(
        unanswered.call,
        'term_1',
        new AbortController().signal,
        fakeTiming(5_000)
      )
    ).resolves.toBe('timed-out')
  })

  it('leaves no abort listener behind once a poll ends', async () => {
    const signal = new AbortController().signal
    const added = vi.spyOn(signal, 'addEventListener')
    const removed = vi.spyOn(signal, 'removeEventListener')
    await DEFAULT_STARTUP_WAIT_TIMING.sleep(1, signal)
    expect(added).toHaveBeenCalledTimes(1)
    expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0]![1])
  })
})

function host(): WorkerHostContext {
  return { coordinatorTerminalHandle: 'term_coord', runId: 'run_1', log: vi.fn(), changed: vi.fn() }
}

function activeRun(): ActiveRun {
  return {
    abort: new AbortController(),
    pendingAck: null,
    seenMessageIds: new Set(),
    execution: null
  }
}

function blockedWorker(startupBlocker = 'claude-folder-trust') {
  const worker = createWorker('builder', { agent: 'claude' })
  return Object.assign(worker, {
    status: 'failed' as const,
    error: 'Agent startup blocked: codex-trust-workspace',
    terminalHandle: 'term_1',
    startupBlocker
  })
}

describe('buildReviewStartupAnswerWait', () => {
  it('keeps the worker waiting on the person, not failed, until the question is answered', async () => {
    const { call } = scripted({ screens: [TRUST_SCREEN, TRUST_SCREEN, READY_SCREEN] })
    const worker = blockedWorker()
    const target = host()
    const states: string[] = []
    vi.mocked(target.changed).mockImplementation(() => {
      states.push(`${worker.status}:${worker.error ?? ''}:${worker.startupBlocker ?? ''}`)
    })
    const wait = buildReviewStartupAnswerWait(call, fakeTiming())
    await expect(wait(worker, target, activeRun())).resolves.toBe(true)
    // Answered: the agent is up in that terminal, so the card says Running, not Starting.
    expect(states).toEqual(['starting::claude-folder-trust', 'running::'])
    expect(worker.startupBlocker).toBeUndefined()
  })

  it('leaves a question it cannot see, or one nobody can answer, to fail as before', async () => {
    const unreadable = {
      call: (async () => ({ terminal: { tail: TRUST_SCREEN } })) as OrchestrationCaller
    }
    const worker = blockedWorker()
    await expect(
      buildReviewStartupAnswerWait(unreadable.call, fakeTiming())(worker, host(), activeRun())
    ).resolves.toBe(false)
    expect(worker).toMatchObject({ status: 'failed', startupBlocker: 'claude-folder-trust' })
    const stalled = scripted({ screens: [TRUST_SCREEN] })
    await expect(
      buildReviewStartupAnswerWait(stalled.call, fakeTiming())(
        blockedWorker('agent-prompt-stalled'),
        host(),
        activeRun()
      )
    ).resolves.toBe(false)
    expect(stalled.calls).toEqual([])
  })

  it('fails in plain words when the person declines or closes the terminal', async () => {
    const declined = blockedWorker()
    await expect(
      buildReviewStartupAnswerWait(
        scripted({ screens: [TRUST_SCREEN, READY_SCREEN], running: false }).call,
        fakeTiming()
      )(declined, host(), activeRun())
    ).resolves.toBe(false)
    expect(declined).toMatchObject({
      status: 'failed',
      error: 'The agent exited at its startup question, so it did not start.'
    })
    expect(declined.startupBlocker).toBeUndefined()
    // The agent exited to its shell: that terminal is still there to open.
    expect(declined.terminalClosed).toBeUndefined()
    const closed = blockedWorker()
    await expect(
      buildReviewStartupAnswerWait(
        scripted({ screens: [TRUST_SCREEN, 'terminal_gone'] }).call,
        fakeTiming()
      )(closed, host(), activeRun())
    ).resolves.toBe(false)
    expect(closed.error).toBe('Its terminal was closed before the startup question was answered.')
    // Recorded on the worker, so the card stops offering to open it.
    expect(closed.terminalClosed).toBe(true)
  })

  it('says the agent exited, or its terminal closed, instead of that it still asks', async () => {
    const exited = blockedWorker()
    await expect(
      buildReviewStartupAnswerWait(
        scripted({ screens: [EXITED_OVER_SHELL], running: false }).call,
        fakeTiming()
      )(exited, host(), activeRun())
    ).resolves.toBe(false)
    expect(exited).toMatchObject({
      status: 'failed',
      error: 'The agent exited at its startup question, so it did not start.'
    })
    expect(exited.startupBlocker).toBeUndefined()
    const gone = blockedWorker()
    await expect(
      buildReviewStartupAnswerWait(scripted({ screens: [EXITED] }).call, fakeTiming())(
        gone,
        host(),
        activeRun()
      )
    ).resolves.toBe(false)
    expect(gone).toMatchObject({
      status: 'failed',
      error: 'Its terminal was closed before the startup question was answered.',
      terminalClosed: true
    })
    expect(gone.startupBlocker).toBeUndefined()
    expect(exited.terminalClosed).toBeUndefined()
  })

  it('turns a cancel while waiting into the run being cancelled', async () => {
    const run = activeRun()
    const timing = fakeTiming()
    const sleep = timing.sleep
    timing.sleep = async (ms, signal) => {
      run.abort.abort()
      await sleep(ms, signal)
    }
    const worker = blockedWorker()
    await expect(
      buildReviewStartupAnswerWait(scripted({ screens: [TRUST_SCREEN] }).call, timing)(
        worker,
        host(),
        run
      )
    ).rejects.toBeInstanceOf(CancelledError)
    expect(worker).toMatchObject({ status: 'failed', startupBlocker: 'claude-folder-trust' })
  })
})

describe('startWorker after a startup question', () => {
  function startScript(projection = false) {
    const calls: { method: string; params: Record<string, unknown> }[] = []
    let starts = 0
    const call = (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'orchestration.workerStart') {
        starts += 1
        return starts === 1
          ? { dispatchId: 'ctx_1', state: 'failed', startupBlocker: 'codex-trust-workspace' }
          : { dispatchId: 'ctx_2', state: 'ready' }
      }
      if (method === 'orchestration.workerShow') {
        return { worker: { state: 'ready', agent_terminal_handle: 'term_1' } }
      }
      return {}
    }) as OrchestrationCaller
    const answer = vi.fn(async () => true)
    const context = { call, changed: vi.fn(), awaitStartupAnswer: answer }
    const target = { ...host(), ...(projection ? { projectionTaskId: 'task_projection' } : {}) }
    return { calls, answer, context, target }
  }

  it('starts the worker again in the terminal the person answered in, retrying that start', async () => {
    const { calls, answer, context, target } = startScript()
    const worker = createWorker('builder', { agent: 'claude', model: 'opus' })
    worker.taskId = 'task_1'
    await startWorker(context, target, activeRun(), worker, 'Build it')
    expect(answer).toHaveBeenCalledTimes(1)
    const starts = calls.filter(({ method }) => method === 'orchestration.workerStart')
    expect(starts).toHaveLength(2)
    expect(starts[0]!.params).not.toHaveProperty('terminal')
    expect(starts[0]!.params).toMatchObject({ agent: 'claude', model: 'opus' })
    expect(starts[1]!.params).toMatchObject({
      terminal: 'term_1',
      retryOf: 'ctx_1',
      task: 'task_1'
    })
    // The agent already runs there with its model: worker-start refuses them beside `terminal`.
    expect(starts[1]!.params).not.toHaveProperty('agent')
    expect(starts[1]!.params).not.toHaveProperty('model')
    expect(worker).toMatchObject({
      status: 'running',
      dispatchId: 'ctx_2',
      terminalHandle: 'term_1'
    })
  })

  it('shows the worker running once answered, while its task is handed over again', async () => {
    const { context, target } = startScript()
    const worker = createWorker('builder', { agent: 'codex' })
    const seen: string[] = []
    const watching = {
      ...context,
      call: (async (method: string, params: Record<string, unknown>) => {
        if (method === 'orchestration.workerStart') {
          seen.push(worker.status)
        }
        return context.call(method, params)
      }) as OrchestrationCaller
    }
    await startWorker(watching, target, activeRun(), worker, 'Build it')
    // The first start is a start; the one in the answered terminal hands work to a running agent.
    expect(seen).toEqual(['starting', 'running'])
    expect(worker.status).toBe('running')
  })

  it('continues a card-bound Run from the failed start instead of retrying it', async () => {
    const { calls, context, target } = startScript(true)
    const worker = createWorker('builder', { agent: 'claude' })
    await startWorker(context, target, activeRun(), worker, 'Build it')
    const again = calls.filter(({ method }) => method === 'orchestration.workerStart')[1]!
    expect(again.params).toMatchObject({ terminal: 'term_1', continueFrom: 'ctx_1' })
    expect(again.params).not.toHaveProperty('retryOf')
  })

  it('waits on the real screen and starts again once the person answered Claude there', async () => {
    const screens = scripted({ screens: [TRUST_SCREEN, TRUST_SCREEN, READY_SCREEN] })
    const { calls, context, target } = startScript()
    const call = (async (method: string, params: Record<string, unknown>) =>
      method === 'terminal.read' || method === 'terminal.isRunningAgent'
        ? screens.call(method, params)
        : context.call(method, params)) as OrchestrationCaller
    const waiting = {
      ...context,
      call,
      awaitStartupAnswer: buildReviewStartupAnswerWait(call, fakeTiming())
    }
    const worker = createWorker('builder', { agent: 'claude' })
    await startWorker(waiting, target, activeRun(), worker, 'Build it')
    const again = calls.filter(({ method }) => method === 'orchestration.workerStart')[1]!
    expect(again.params).toMatchObject({ terminal: 'term_1', retryOf: 'ctx_1' })
    expect(worker).toMatchObject({ status: 'running', dispatchId: 'ctx_2' })
    expect(worker.startupBlocker).toBeUndefined()
  })

  it('fails the start as before when nobody waits for an answer', async () => {
    const { calls, context, target } = startScript()
    context.awaitStartupAnswer.mockResolvedValue(false)
    const worker = createWorker('builder', { agent: 'claude' })
    await expect(startWorker(context, target, activeRun(), worker)).rejects.toThrow(/^builder: /)
    expect(calls.filter(({ method }) => method === 'orchestration.workerStart')).toHaveLength(1)
    expect(worker).toMatchObject({ status: 'failed', startupBlocker: 'claude-folder-trust' })
  })
})
