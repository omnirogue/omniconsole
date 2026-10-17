/**
 * One agent stage of the direct-versus-coordinated benchmark: create the task, start a disposable
 * supervised worker through the existing executor, wait for its report and read what it used.
 */
import type { StageRecord, TokenUsage } from './direct-vs-coordinated-report'

export type BenchTask = {
  id: string
  objective: string
  target: string
  publicTest: string
  acceptanceTest: string
}

export type Exec = (
  args: string[]
) => Promise<{ code: number | null; stdout: string; stderr: string }>

export type Seat = { agent: string; model?: string; effort?: string }

export type BenchDeps = {
  omni: Exec
  /** Copies the frozen fixture into a new folder under the workspace and returns it. */
  materialize: (label: string) => string
  /** Runs the task's hidden acceptance tests in that folder. */
  verify: (dir: string, task: BenchTask) => Promise<{ pass: number; fail: number; output: string }>
  readUsage: (transcriptPath: string | null, agent: string) => TokenUsage | 'unknown'
  readText: (path: string) => string | null
  now: () => number
  log: (line: string) => void
}

export type BenchOptions = {
  runId: string
  /** Selector of the registered folder workspace the workers start in. */
  workspace: string
  host: string
  owner: string
  implementer: Seat
  reviewer: Seat
  stageTimeoutMs: number
}

type Json = Record<string, unknown>

export async function call(
  deps: BenchDeps,
  args: string[]
): Promise<{ result?: Json; error?: string }> {
  const outcome = await deps.omni([...args, '--json'])
  try {
    const parsed = JSON.parse(outcome.stdout) as { ok?: boolean; result?: Json; error?: Json }
    return parsed.ok && parsed.result
      ? { result: parsed.result }
      : { error: String(parsed.error?.message ?? `omni exited ${outcome.code}`) }
  } catch {
    return { error: outcome.stderr.trim().slice(-400) || `omni exited ${outcome.code}` }
  }
}

export type StageOutcome = { record: StageRecord; questions: number; waitingOnHuman: boolean }

/** Reads what only exists while the worker terminal is live; run before the ack releases it. */
async function observeWorker(
  deps: BenchDeps,
  dispatchId: string
): Promise<{ transcriptPath: string | null; model: string | null; startupMs: number | null }> {
  const shown = await call(deps, ['orchestration', 'worker-show', '--dispatch', dispatchId])
  const handle = (shown.result?.worker as Json | undefined)?.agent_terminal_handle
  const sessions = await call(deps, ['session', 'list'])
  const row = ((sessions.result?.sessions as Json[] | undefined) ?? []).find(
    (session) => typeof handle === 'string' && session.terminal === handle
  )
  const receipt = (
    await call(deps, [
      'orchestration',
      'worker-show',
      '--dispatch',
      dispatchId,
      '--receipt',
      '--observe-provider'
    ])
  ).result?.receipt as Json | undefined
  const actual = (receipt?.route as Json | undefined)?.actual as Json | null | undefined
  const startup = (receipt?.phaseDurations as Json | undefined)?.startupMs
  return {
    transcriptPath: typeof row?.transcriptPath === 'string' ? row.transcriptPath : null,
    model: typeof actual?.model === 'string' ? actual.model : null,
    startupMs: typeof startup === 'number' ? startup : null
  }
}

export async function runStage(
  deps: BenchDeps,
  options: BenchOptions,
  input: { stage: StageRecord['stage']; spec: string; title: string; seat: Seat }
): Promise<StageOutcome> {
  const startedAtMs = deps.now()
  const record: StageRecord = {
    stage: input.stage,
    dispatchId: null,
    agent: input.seat.agent,
    observedModel: null,
    startedAtMs,
    launchedAtMs: null,
    reportedAtMs: null,
    endedAtMs: startedAtMs,
    outcome: 'refused',
    startupMs: null,
    tokens: 'unknown'
  }
  const finish = (patch: Partial<StageRecord>, questions = 0, waitingOnHuman = false) => ({
    record: { ...record, ...patch, endedAtMs: deps.now() },
    questions,
    waitingOnHuman
  })
  const run = ['--run', options.runId]
  const task = await call(deps, [
    'orchestration',
    'task-create',
    ...run,
    '--spec',
    input.spec,
    '--task-title',
    input.title
  ])
  const taskId = (task.result?.task as Json | undefined)?.id
  if (typeof taskId !== 'string') {
    return finish({ detail: `task-create: ${task.error ?? 'no task id'}` })
  }
  const started = await call(deps, [
    'orchestration',
    'worker-start',
    '--task',
    taskId,
    ...run,
    '--worktree',
    options.workspace,
    '--agent',
    input.seat.agent,
    ...(input.seat.model ? ['--model', input.seat.model] : []),
    ...(input.seat.model && input.seat.effort ? ['--effort', input.seat.effort] : []),
    '--close-on-completion'
  ])
  const dispatchId = started.result?.dispatchId
  if (typeof dispatchId !== 'string') {
    return finish({ detail: `worker-start: ${started.error ?? 'no dispatch id'}` })
  }
  record.dispatchId = dispatchId
  record.launchedAtMs = deps.now()
  let questions = 0
  while (deps.now() - startedAtMs < options.stageTimeoutMs) {
    const wait = Math.min(120_000, options.stageTimeoutMs - (deps.now() - startedAtMs))
    const delivery = await call(deps, [
      'orchestration',
      'check',
      ...run,
      '--wait',
      '--types',
      'worker_done,escalation,question',
      '--timeout-ms',
      String(Math.max(1_000, wait))
    ])
    let done: { outcome: StageRecord['outcome']; detail: string } | null = null
    for (const message of (delivery.result?.messages as Json[] | undefined) ?? []) {
      const payload = JSON.parse(
        typeof message.payload === 'string' ? message.payload : '{}'
      ) as Json
      if (message.type === 'worker_done' && payload.dispatchId === dispatchId) {
        done = {
          outcome: payload.outcome === 'succeeded' ? 'succeeded' : 'failed',
          detail: String(message.body ?? '')
        }
      } else if (message.type === 'question') {
        questions += 1
        // Why: the harness has no person behind it; saying so beats leaving the worker blocked.
        await call(deps, [
          'orchestration',
          'reply',
          ...run,
          '--id',
          String(message.id),
          '--body',
          'No one can answer in this benchmark. Decide within the Allowed scope and note the assumption.'
        ])
      }
    }
    if (done) {
      record.reportedAtMs = deps.now()
    }
    const observed = done ? await observeWorker(deps, dispatchId) : null
    const deliveryId = delivery.result?.deliveryId
    if (typeof deliveryId === 'string') {
      await call(deps, ['orchestration', 'check', ...run, '--ack', deliveryId])
    }
    if (done && observed) {
      return finish(
        {
          ...done,
          observedModel: observed.model,
          startupMs: observed.startupMs,
          tokens: deps.readUsage(observed.transcriptPath, input.seat.agent)
        },
        questions
      )
    }
  }
  // Why: a timeout is reported, never repaired by stopping the worker; quiet is not dead.
  const shown = await call(deps, ['orchestration', 'worker-show', '--dispatch', dispatchId])
  const waiting = Boolean((shown.result?.observation as Json | undefined)?.agentWait)
  return finish(
    {
      outcome: 'timeout',
      detail: waiting
        ? 'The worker is waiting on a person.'
        : 'No report before the stage deadline.'
    },
    questions,
    waiting
  )
}
