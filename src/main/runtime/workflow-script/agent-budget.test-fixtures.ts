import { AgentBudgetClient } from './agent-budget-client'

type Attempt = {
  attempt_id: string
  root_id: string
  reserved: number
  state: 'reserved' | 'settled' | 'uncertain' | 'released'
  settled?: number
  body: Record<string, unknown>
}

/**
 * An in-memory stand-in for the OmniSI authority's HTTP API (the real one is migration 0115 in
 * omnidots-cloud, tested there on Postgres). Same wire shapes; reserves `perCallMicros` a call.
 */
export function fakeBudgetAuthority(
  options: {
    ceilingMicros?: number
    maxAttempts?: number
    perCallMicros?: number
    kind?: 'research' | 'benchmark'
    down?: boolean
  } = {}
) {
  const state = {
    root: {
      root_id: '11111111-1111-4111-8111-111111111111',
      kind: options.kind ?? 'research',
      state: 'open' as 'open' | 'stopped' | 'exhausted' | 'closed'
    },
    attempts: new Map<string, Attempt>(),
    reuses: [] as Record<string, unknown>[],
    requests: [] as { path: string; body: Record<string, unknown> }[],
    down: options.down ?? false
  }
  const ceiling = options.ceilingMicros ?? 1_000_000
  const perCall = options.perCallMicros ?? 80_000
  const maxAttempts = options.maxAttempts ?? 20
  const exposure = () =>
    [...state.attempts.values()].reduce(
      (sum, a) =>
        sum +
        (a.state === 'settled'
          ? (a.settled ?? 0)
          : a.state === 'released'
            ? 0
            : Math.max(a.reserved, a.settled ?? 0)),
      0
    )
  const answer = (path: string, body: Record<string, unknown>): unknown => {
    if (path.endsWith('/admit')) {
      const prior = state.attempts.get(String(body.attempt_id))
      if (state.root.state !== 'open') {
        return {
          decision: 'refused',
          code: state.root.state === 'stopped' ? 'stopped' : 'root_closed'
        }
      }
      if (prior) {
        return { decision: 'admitted', replay: true, reserved_micros: prior.reserved }
      }
      if (body.root_id !== state.root.root_id) {
        return { decision: 'refused', code: 'root_unknown' }
      }
      const used = [...state.attempts.values()].filter((a) => a.state !== 'released').length
      if (used >= maxAttempts) {
        return { decision: 'refused', code: 'attempt_limit' }
      }
      if (exposure() + perCall > ceiling) {
        return { decision: 'refused', code: 'budget_exhausted' }
      }
      state.attempts.set(String(body.attempt_id), {
        attempt_id: String(body.attempt_id),
        root_id: String(body.root_id),
        reserved: perCall,
        state: 'reserved',
        body
      })
      return { decision: 'admitted', reserved_micros: perCall, attempt_no: used + 1 }
    }
    if (path.endsWith('/settle')) {
      const attempt = state.attempts.get(String(body.attempt_id))
      if (!attempt || attempt.state === 'settled' || attempt.state === 'released') {
        return { settled: false, code: attempt ? 'already_settled' : 'attempt_unknown' }
      }
      const cost = typeof body.cost_micros === 'number' ? body.cost_micros : undefined
      attempt.state = cost === undefined || body.outcome === 'unknown' ? 'uncertain' : 'settled'
      attempt.settled = cost
      attempt.body = { ...attempt.body, receipt: body }
      return { settled: attempt.state === 'settled', state: attempt.state }
    }
    if (path.endsWith('/release')) {
      const attempt = state.attempts.get(String(body.attempt_id))
      if (attempt?.state === 'reserved') {
        attempt.state = 'released'
        return { result: 'released' }
      }
      return { result: 'not_releasable' }
    }
    if (path.endsWith('/reuse')) {
      state.reuses.push(body)
      return { result: 'recorded' }
    }
    if (path.endsWith('/stop')) {
      if (state.root.state === 'open') {
        state.root.state = 'stopped'
      }
      return { state: state.root.state }
    }
    return {
      ...state.root,
      title: 'Root',
      exposure_micros: exposure(),
      summary: [
        `Committed $${(exposure() / 1_000_000).toFixed(2)} of $${(ceiling / 1_000_000).toFixed(2)}.`
      ]
    }
  }
  const fetchImpl = (async (url: URL | string, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}
    state.requests.push({ path, body })
    if (state.down) {
      throw new TypeError('fetch failed')
    }
    if (!String(path).startsWith('/api/v1/agent-budget/')) {
      return new Response('{}', { status: 404 })
    }
    return new Response(JSON.stringify(answer(path, body)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof fetch
  const client = new AgentBudgetClient(
    { url: 'https://omnisi.test', key: 'osi_api1.org-research.test-key-0000', host: 'test-host' },
    fetchImpl
  )
  return { state, client, exposure, rootId: state.root.root_id }
}
