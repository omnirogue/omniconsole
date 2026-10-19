import { resolveAgentBudgetCredential } from '../../structured-decisions/decision-credential'

/**
 * The OmniSI agent budget authority (omnidots-cloud docs/agent-budget-controls.md): one durable
 * ledger that reserves a bounded cost before every provider call of a root mission, on any host.
 * This computer never keeps a balance of its own: an unreachable authority is a refusal.
 */
export type AgentBudgetDecision = {
  decision: 'admitted' | 'refused' | 'not_enforced'
  code?: string
  retryable?: boolean
  report?: boolean
  replay?: boolean
  attempt_no?: number
  reserved_micros?: number
  remaining_micros?: number
  ceiling_micros?: number
  attempts_remaining?: number
  warn?: boolean
  cost_basis?: string
}

export type AgentBudgetAdmission = {
  attempt_id: string
  root_id: string
  run_id: string
  parent_run_id?: string
  product: 'omniconsole' | 'cli'
  execution_host: string
  stage: string
  call_key: string
  provider: string
  account_ref?: string
  model: string
  effort?: string
  max_input_tokens: number
  max_output_tokens: number
}

export type AgentBudgetReceipt = {
  attempt_id: string
  outcome: 'ok' | 'empty' | 'failed' | 'cancelled' | 'unknown'
  cost_micros?: number
  cost_complete?: boolean
  input_tokens?: number
  output_tokens?: number
  cache_read_tokens?: number
  cache_write_tokens?: number
  reasoning_tokens?: number
  provider_request_id?: string
  /** No dollar figure from the provider: the authority prices the tokens (marked incomplete). */
  estimate_from_tokens?: boolean
}

export type AgentBudgetRootView = {
  root_id: string
  title: string
  kind: 'research' | 'benchmark' | 'customer_run'
  state: 'open' | 'stopped' | 'exhausted' | 'closed'
  effective_ceiling_micros?: number
  exposure_micros?: number
  remaining_micros?: number
  max_attempts?: number
  max_in_flight?: number
  totals?: Record<string, number>
  /** Plain lines from the ledger alone: measures named apart, incomplete costs said so. */
  summary?: string[]
}

export type AgentBudgetConfig = { url: string; key: string; host: string }

const DEFAULT_TIMEOUT_MS = 10_000

function enabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

/** Off unless OMNI_AGENT_BUDGET_ENFORCE=true with the authority's URL and a budget:write key. */
export async function resolveAgentBudgetConfig(
  env: NodeJS.ProcessEnv = process.env,
  host: string
): Promise<AgentBudgetConfig | undefined> {
  if (!enabled(env.OMNI_AGENT_BUDGET_ENFORCE)) {
    return undefined
  }
  const url = env.OMNISI_AGENT_BUDGET_URL?.trim()
  const key = await resolveAgentBudgetCredential(env)
  // Enforcement asked for but not configured: a config that refuses everything.
  return {
    url: url && /^https:\/\/|^http:\/\/127\.0\.0\.1[:/]/.test(url) ? url : '',
    key: key ?? '',
    host
  }
}

export class AgentBudgetClient {
  constructor(
    private readonly config: AgentBudgetConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS
  ) {}

  get host(): string {
    return this.config.host
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    if (!this.config.url || !this.config.key) {
      throw new Error('The agent budget authority is not configured on this computer.')
    }
    const response = await this.fetchImpl(new URL(path, this.config.url), {
      method,
      headers: {
        Authorization: `Bearer ${this.config.key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.timeoutMs)
    })
    if (!response.ok) {
      throw new Error(`The agent budget authority answered ${response.status}.`)
    }
    return response.json()
  }

  /** Anything but a durable admission is a refusal: nothing may be sent. */
  async admit(admission: AgentBudgetAdmission): Promise<AgentBudgetDecision> {
    try {
      const decision = (await this.call(
        'POST',
        '/api/v1/agent-budget/admit',
        admission
      )) as AgentBudgetDecision
      return decision && ['admitted', 'refused', 'not_enforced'].includes(decision.decision)
        ? decision
        : { decision: 'refused', code: 'authority_unavailable' }
    } catch {
      return { decision: 'refused', code: 'authority_unavailable' }
    }
  }

  /** False when the settlement did not reach the authority; the reservation then stays counted. */
  async settle(receipt: AgentBudgetReceipt): Promise<boolean> {
    try {
      await this.call('POST', '/api/v1/agent-budget/settle', receipt)
      return true
    } catch {
      return false
    }
  }

  async release(attemptId: string, reason: string): Promise<boolean> {
    try {
      await this.call('POST', '/api/v1/agent-budget/release', { attempt_id: attemptId, reason })
      return true
    } catch {
      return false
    }
  }

  async recordReuse(body: Record<string, string>): Promise<void> {
    await this.call('POST', '/api/v1/agent-budget/reuse', body).catch(() => undefined)
  }

  async stop(rootId: string, reason: string): Promise<string | undefined> {
    try {
      const result = (await this.call(
        'POST',
        `/api/v1/agent-budget/roots/${encodeURIComponent(rootId)}/stop`,
        { reason }
      )) as { state?: string }
      return result.state
    } catch {
      return undefined
    }
  }

  async view(rootId: string): Promise<AgentBudgetRootView | undefined> {
    try {
      return (await this.call(
        'GET',
        `/api/v1/agent-budget/roots/${encodeURIComponent(rootId)}`
      )) as AgentBudgetRootView
    } catch {
      return undefined
    }
  }
}
