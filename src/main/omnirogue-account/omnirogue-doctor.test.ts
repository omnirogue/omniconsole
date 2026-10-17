import { describe, expect, it, vi } from 'vitest'
import type { OmniRogueAccountState } from '../../shared/omnirogue-account'
import { runOmniRogueDoctor, type OmniRogueDoctorOptions } from './omnirogue-doctor'

const token = `or_obp_${'a'.repeat(43)}`
const now = 1_800_000_000_000
const tools = ['credits.balance', 'media.generate', 'si.query', 'tools_search']
const models = ['claude-opus-5-5', 'gpt-6-astra', 'gemini-4-argon']
const json = (value: unknown, status = 200) => Response.json(value, { status })
type Fixture = {
  state?: OmniRogueAccountState
  token?: string | null
  wallet?: unknown
  models?: unknown
  tools?: string[]
  intercept?: (url: string, init: RequestInit) => Response | Promise<Response> | undefined
}
function fixture(overrides: Fixture = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetcher = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const response = overrides.intercept?.(url, init)
    if (response) {
      return response
    }
    if (url.endsWith('/device/me')) {
      return json({ user: { id: 'private-user' } })
    }
    if (url.endsWith('/wallet')) {
      return json(overrides.wallet ?? { spendableCredits: 42 })
    }
    if (url.endsWith('/v1/models')) {
      return json({ data: overrides.models ?? models.map((id) => ({ id })) })
    }
    const request = JSON.parse(String(init.body))
    if (request.method === 'notifications/initialized') {
      return new Response(null, { status: 202 })
    }
    const result =
      request.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
        : { tools: (overrides.tools ?? tools).map((name) => ({ name })) }
    return json({ jsonrpc: '2.0', id: request.id, result })
  })
  const account = {
    status: vi.fn(
      async () => overrides.state ?? { state: 'linked' as const, expiresAt: now + 3_600_000 }
    ),
    leaseToken: vi.fn(async () => (overrides.token === undefined ? token : overrides.token))
  }
  const options: OmniRogueDoctorOptions = {
    account,
    billingMode: 'omnirogue-credits',
    fetcher,
    now: () => now
  }
  return { options, calls, account, fetcher }
}

describe('runOmniRogueDoctor', () => {
  it('checks all four stages without invoking a paid tool or exposing account data', async () => {
    const { options, calls } = fixture()
    const report = await runOmniRogueDoctor(options)
    expect(report.status).toBe('pass')
    expect(report.stages.map((stage) => stage.id)).toEqual(['account', 'wallet', 'mcp', 'gateway'])
    expect(report.stages.every((stage) => stage.status === 'pass' && stage.latencyMs >= 0)).toBe(
      true
    )
    expect(report.stages[2].checks).toHaveLength(2)
    expect(calls).toHaveLength(9)
    for (const { init } of calls) {
      expect(init.redirect).toBe('error')
      expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`)
      expect(String(init.body)).not.toContain('tools/call')
    }
    expect(JSON.stringify(report)).not.toMatch(/or_obp_|private-user|Bearer/)
  })

  it.each([null, 'bad-token', 'or_obp_short'])(
    'blocks network probes for invalid lease %s',
    async (leased) => {
      const { options, fetcher } = fixture({ token: leased })
      const report = await runOmniRogueDoctor(options)
      expect(report.stages[0]).toMatchObject({ status: 'fail', remediation: 'reconnect' })
      expect(report.stages.slice(1).every((stage) => stage.status === 'skipped')).toBe(true)
      expect(fetcher).not.toHaveBeenCalled()
    }
  )

  it.each<OmniRogueAccountState>([
    { state: 'unlinked' },
    { state: 'linking' },
    { state: 'linked', expiresAt: now },
    { state: 'linked', expiresAt: now - 1 },
    { state: 'linked', apiOrigin: 'https://untrusted.example', expiresAt: now + 3_600_000 }
  ])('blocks unavailable, expired or differently scoped accounts: %j', async (state) => {
    const { options, fetcher } = fixture({ state })
    expect((await runOmniRogueDoctor(options)).status).toBe('fail')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([undefined, Number.NaN, Infinity, now + 299_999])(
    'warns about unverifiable or short expiry: %s',
    async (expiresAt) => {
      const { options } = fixture({ state: { state: 'linked', expiresAt } })
      const report = await runOmniRogueDoctor(options)
      expect(report.stages[0]).toMatchObject({ status: 'warn', remediation: 'reconnect' })
      expect(report.stages[1].status).toBe('pass')
    }
  )

  it('accepts the exact configured expiry headroom', async () => {
    const { options } = fixture({ state: { state: 'linked', expiresAt: now + 300_000 } })
    expect((await runOmniRogueDoctor(options)).stages[0].status).toBe('pass')
  })

  it.each([401, 403, 500])(
    'does not probe downstream services after account HTTP %i',
    async (status) => {
      const { options, calls } = fixture({ intercept: () => json({ error: token }, status) })
      const report = await runOmniRogueDoctor(options)
      expect(report.status).toBe('fail')
      expect(calls).toHaveLength(1)
      expect(JSON.stringify(report)).not.toContain(token)
    }
  )

  it('warns about zero spendable credits even when reserved or total credits remain', async () => {
    const { options } = fixture({
      wallet: { wallet: { spendableCredits: 0, reservedCredits: 50, totalCredits: 50 } }
    })
    const report = await runOmniRogueDoctor(options)
    expect(report.stages[1]).toMatchObject({ status: 'warn', remediation: 'top-up' })
    expect(report.stages[3].status).toBe('pass')
  })

  it.each([{ availableCredits: 4 }, { data: { spendable_credits: 4 } }])(
    'accepts spendable balance projection %j',
    async (wallet) => {
      expect((await runOmniRogueDoctor(fixture({ wallet }).options)).stages[1].status).toBe('pass')
    }
  )

  it.each([
    { totalCredits: 100 },
    { spendableCredits: '10' },
    { spendableCredits: -1 },
    { error: 'denied' }
  ])('rejects malformed wallet %j', async (wallet) => {
    const report = await runOmniRogueDoctor(fixture({ wallet }).options)
    expect(report.stages[1].status).toBe('fail')
    expect(report.stages[2].status).toBe('pass')
  })

  it.each(tools)('detects absent namespace/tool %s', async (missing) => {
    const report = await runOmniRogueDoctor(
      fixture({ tools: tools.filter((tool) => tool !== missing) }).options
    )
    expect(report.stages[2].status).toBe('fail')
  })

  it('reports each MCP endpoint independently and still checks the gateway', async () => {
    const { options } = fixture({
      intercept: (url) => (url.includes('app.omnisi.ai') ? json({}, 503) : undefined)
    })
    const report = await runOmniRogueDoctor(options)
    expect(report.stages[2].checks?.map((check) => check.status)).toEqual(['fail', 'pass'])
    expect(report.stages[3].status).toBe('pass')
  })

  it('negotiates sessions and follows paginated SSE tool responses without waiting for EOF', async () => {
    const cancelled = vi.fn()
    const { options, calls } = fixture({
      intercept: (url, init) => {
        if (!url.endsWith('/mcp')) {
          return undefined
        }
        const rpc = JSON.parse(String(init.body))
        if (rpc.method === 'initialize') {
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: rpc.id,
              result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } }
            }),
            { headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'test-session' } }
          )
        }
        if (rpc.method !== 'tools/list') {
          return undefined
        }
        const result = rpc.params.cursor
          ? { tools: tools.slice(2).map((name) => ({ name })) }
          : { tools: tools.slice(0, 2).map((name) => ({ name })), nextCursor: 'page-2' }
        const data = `: heartbeat\r\n\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notice' })}\r\n\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\r\n\r\n`
        return new Response(
          new ReadableStream({
            start(controller) {
              const bytes = new TextEncoder().encode(data)
              controller.enqueue(bytes.slice(0, 15))
              controller.enqueue(bytes.slice(15))
            },
            cancel: cancelled
          }),
          { headers: { 'Content-Type': 'text/event-stream' } }
        )
      }
    })
    expect((await runOmniRogueDoctor(options)).status).toBe('pass')
    expect(cancelled).toHaveBeenCalledTimes(4)
    const lists = calls.filter(({ init }) => String(init.body).includes('tools/list'))
    expect(lists).toHaveLength(4)
    expect(
      lists.every(({ init }) => new Headers(init.headers).get('Mcp-Session-Id') === 'test-session')
    ).toBe(true)
    expect(
      lists.every(
        ({ init }) => new Headers(init.headers).get('MCP-Protocol-Version') === '2025-03-26'
      )
    ).toBe(true)
  })

  it.each(['rpc-error', 'wrong-id', 'cursor-loop', 'malformed-tools'])(
    'rejects MCP %s',
    async (mode) => {
      const { options } = fixture({
        intercept: (url, init) => {
          if (!url.endsWith('/mcp')) {
            return undefined
          }
          const rpc = JSON.parse(String(init.body))
          if (rpc.method !== 'tools/list') {
            return undefined
          }
          return json({
            jsonrpc: '2.0',
            id: mode === 'wrong-id' ? 99 : rpc.id,
            ...(mode === 'rpc-error'
              ? { error: { message: token } }
              : {
                  result: {
                    tools: mode === 'malformed-tools' ? [{}] : tools.map((name) => ({ name })),
                    ...(mode === 'cursor-loop' ? { nextCursor: 'same' } : {})
                  }
                })
          })
        }
      })
      const report = await runOmniRogueDoctor(options)
      expect(report.stages[2].status).toBe('fail')
      expect(JSON.stringify(report)).not.toContain(token)
    }
  )

  it.each(models)('requires the exact frontier model %s', async (missing) => {
    const { options } = fixture({
      models: models.filter((id) => id !== missing).map((id) => ({ id }))
    })
    const report = await runOmniRogueDoctor(options)
    expect(report.stages[3]).toMatchObject({ status: 'fail', remediation: 'retry' })
    expect(report.stages[3].message).toContain(missing)
  })

  it('skips gateway checks for own-login billing', async () => {
    const { options, calls } = fixture()
    options.billingMode = 'own-login'
    expect((await runOmniRogueDoctor(options)).stages[3].status).toBe('skipped')
    expect(calls.some(({ url }) => url.endsWith('/v1/models'))).toBe(false)
  })

  it('bounds hanging leases and requests, including adapters ignoring abort', async () => {
    for (const hangingLease of [true, false]) {
      const { options } = fixture({ intercept: () => new Promise<Response>(() => {}) })
      options.timeoutMs = 5
      if (hangingLease) {
        options.account.leaseToken = () => new Promise(() => {})
      }
      const report = await runOmniRogueDoctor(options)
      expect(report.stages[0]).toMatchObject({ status: 'fail', message: 'Check timed out.' })
    }
  })

  it('redacts raw lease exceptions and rejects non-JSON account replies', async () => {
    const { options } = fixture()
    options.account.status = async () => {
      throw new Error(`secret ${token}`)
    }
    expect(JSON.stringify(await runOmniRogueDoctor(options))).not.toContain(token)
    const malformed = fixture({ intercept: () => new Response('<html>Sign in</html>') })
    expect((await runOmniRogueDoctor(malformed.options)).status).toBe('fail')
  })
})
