import type { LocalWorkflowRoute } from '../../../shared/local-workflow-seats'
import type { AgentBudgetClient, AgentBudgetReceipt } from './agent-budget-client'
import { jevCallBudget } from '../../structured-decisions/jev-call-budget'
import { localWorkflowReceiptTokens, localWorkflowReportedCostUsd } from './local-workflow-usage'

/** Frozen into a run's snapshot at Start: the approved root it spends and its per-call bounds. */
export type WorkflowBudgetSnapshot = {
  rootId: string
  /** The root's kind at Start, read from the authority, never from the caller. */
  benchmark: boolean
  maxInputTokens: number
  maxOutputTokens: number
}

export const WORKFLOW_BUDGET_CALL_BOUNDS = { maxInputTokens: 60_000, maxOutputTokens: 8_000 }

/**
 * Routes whose adapter holds one call to its reservation: Claude's `--max-budget-usd` stops the
 * session once its spend reaches the cap (checked after each model response, so one response can
 * pass it; the settlement then records the overrun). Codex, Gemini, Grok, OpenRouter tool loops
 * and Ollama have no such cap here, so a budgeted run refuses them as unsupported.
 */
export const WORKFLOW_BUDGET_ROUTES: ReadonlySet<LocalWorkflowRoute> = new Set(['claude'])

/** A retryable refusal (calls in flight, another root running) waits this long at most. */
const RETRY_WAIT_MS = 2_000
const RETRY_LIMIT_MS = 10 * 60_000

export class WorkflowBudgetRefusedError extends Error {
  constructor(readonly code: string) {
    super(`The budget refused this call (${code}). Nothing was sent.`)
    this.name = 'WorkflowBudgetRefusedError'
  }
}

export type WorkflowBudgetGrant = { reservedUsd: number }

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

const sleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })

/** One budgeted execution's calls against its root, through the shared authority. */
export class WorkflowCallBudget {
  constructor(
    private readonly client: AgentBudgetClient,
    readonly snapshot: WorkflowBudgetSnapshot,
    readonly executionId: string,
    private readonly wait: Sleep = sleep,
    private readonly now: () => number = Date.now
  ) {}

  /** Admits one attempt before it launches; throws WorkflowBudgetRefusedError otherwise. */
  async admit(input: {
    attemptId: string
    callId: string
    route: LocalWorkflowRoute
    model: string
    effort?: string
    accountRef?: string
    signal: AbortSignal
  }): Promise<WorkflowBudgetGrant> {
    if (!WORKFLOW_BUDGET_ROUTES.has(input.route)) {
      throw new WorkflowBudgetRefusedError('adapter_unsupported')
    }
    return this.admitBounded({
      attemptId: input.attemptId,
      stage: input.callId.split(':')[0] || 'call',
      callKey: input.callId,
      provider: `${input.route}-cli`,
      model: input.model,
      effort: input.effort,
      accountRef: input.accountRef,
      maxInputTokens: this.snapshot.maxInputTokens,
      maxOutputTokens: this.snapshot.maxOutputTokens,
      signal: input.signal
    })
  }

  /** A billed tool call (a JEV ballot) admitted like a model call, with its own bounds. */
  async admitBounded(input: {
    attemptId: string
    stage: string
    callKey: string
    provider: string
    model: string
    effort?: string
    accountRef?: string
    maxInputTokens: number
    maxOutputTokens: number
    signal?: AbortSignal
  }): Promise<WorkflowBudgetGrant> {
    const deadline = this.now() + RETRY_LIMIT_MS
    for (;;) {
      input.signal?.throwIfAborted()
      const decision = await this.client.admit({
        attempt_id: input.attemptId,
        root_id: this.snapshot.rootId,
        run_id: this.executionId,
        product: 'omniconsole',
        execution_host: this.client.host,
        stage: input.stage,
        call_key: `${this.executionId}:${input.callKey}`,
        provider: input.provider,
        ...(input.accountRef ? { account_ref: input.accountRef } : {}),
        model: input.model,
        ...(input.effort ? { effort: input.effort } : {}),
        max_input_tokens: input.maxInputTokens,
        max_output_tokens: input.maxOutputTokens
      })
      if (decision.decision === 'admitted') {
        return { reservedUsd: (decision.reserved_micros ?? 0) / 1_000_000 }
      }
      // A budgeted run on an enforcing computer never runs unmetered.
      if (decision.decision === 'not_enforced') {
        throw new WorkflowBudgetRefusedError('authority_not_enforcing')
      }
      if (decision.retryable && this.now() < deadline) {
        await this.wait(RETRY_WAIT_MS, input.signal)
        continue
      }
      throw new WorkflowBudgetRefusedError(decision.code ?? 'budget_exhausted')
    }
  }

  /**
   * Settles a launched attempt once from its process output: Claude's own `total_cost_usd`
   * (an API-equivalent figure on a subscription seat). Without it the cost is unknown and the
   * reservation stays counted until it is reconciled.
   */
  async settleProcess(input: {
    attemptId: string
    route: LocalWorkflowRoute
    stdout: string
    usage?: unknown
    outcome: 'ok' | 'failed' | 'cancelled'
    providerRequestId?: string
  }): Promise<void> {
    const reported = localWorkflowReportedCostUsd(input.stdout)
    const tokens = localWorkflowReceiptTokens(input.route, input.usage)
    const receipt: AgentBudgetReceipt = {
      attempt_id: input.attemptId,
      outcome: reported === undefined ? 'unknown' : input.outcome,
      ...(reported === undefined ? {} : { cost_micros: Math.ceil(reported * 1_000_000) }),
      ...(tokens ? { input_tokens: tokens.input, output_tokens: tokens.output } : {}),
      ...(input.providerRequestId ? { provider_request_id: input.providerRequestId } : {})
    }
    await this.client.settle(receipt)
  }

  async settle(receipt: AgentBudgetReceipt): Promise<void> {
    await this.client.settle(receipt)
  }

  /** The adapter proved nothing left this computer: the reservation is released. */
  async notSent(attemptId: string, reason: string): Promise<void> {
    await this.client.release(attemptId, reason.slice(0, 200))
  }

  /** Lost or uncertain: recorded as unknown, keeping the whole reservation. */
  async unknown(attemptId: string): Promise<void> {
    await this.client.settle({ attempt_id: attemptId, outcome: 'unknown' })
  }

  /** A saved output was reused: no provider call, no attempt, no cost. */
  reuse(callId: string, attemptId: string): void {
    void this.client.recordReuse({
      attempt_id: attemptId,
      root_id: this.snapshot.rootId,
      run_id: this.executionId,
      product: 'omniconsole',
      execution_host: this.client.host,
      stage: callId.split(':')[0] || 'call',
      call_key: `${this.executionId}:${callId}`
    })
  }

  /** Stop: revokes the root's future admission for every product and host. */
  stop(reason: string): Promise<string | undefined> {
    return this.client.stop(this.snapshot.rootId, reason)
  }

  /** The authority's plain summary of the root (no model call), or nothing when unreachable. */
  async summary(): Promise<string[]> {
    return (await this.client.view(this.snapshot.rootId))?.summary ?? []
  }

  /** The root's state now, or undefined when the authority cannot be reached. */
  async state(): Promise<string | undefined> {
    return (await this.client.view(this.snapshot.rootId))?.state
  }
}

/** The run's gate, or a refusal when a budgeted run has no authority to admit its calls. */
export function workflowBudgetGate(
  budget: WorkflowBudgetSnapshot | undefined,
  authority: AgentBudgetClient | undefined,
  executionId: string
): WorkflowCallBudget | undefined {
  if (!budget) {
    return undefined
  }
  if (!authority) {
    throw new WorkflowBudgetRefusedError('authority_unavailable')
  }
  return new WorkflowCallBudget(authority, budget, executionId)
}

/** How often a budgeted run checks whether its root was stopped elsewhere (another host, OmniSI). */
export const WORKFLOW_BUDGET_WATCH_MS = 15_000

/**
 * Runs a budgeted program: billed tools deep inside it (JEV ballots) find the run's budget, and a
 * root stopped or used up elsewhere ends the run here too. An unreachable authority only waits.
 */
export async function runWorkflowBudgeted<T>(
  budget: WorkflowCallBudget | undefined,
  close: (error: Error) => void,
  watchMs: number | undefined,
  work: () => Promise<T>,
  log: (message: string) => void = () => {}
): Promise<T> {
  if (!budget) {
    return work()
  }
  // Before the first call and once it ends: where the root stands, from the ledger alone.
  const report = (heading: string) =>
    budget.summary().then(
      (lines) => lines.length && log([heading, ...lines].join(' ')),
      () => undefined
    )
  await report('Budget before this run:')
  const timer = setInterval(() => {
    void budget.state().then((state) => {
      if (state && state !== 'open') {
        clearInterval(timer)
        close(new WorkflowBudgetRefusedError(state === 'exhausted' ? 'budget_exhausted' : state))
      }
    })
  }, watchMs ?? WORKFLOW_BUDGET_WATCH_MS)
  timer.unref?.()
  try {
    return await jevCallBudget.run(budget, work)
  } finally {
    clearInterval(timer)
    await report('Budget after this run:')
  }
}
