import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleAdvertisingActionsClient as client } from './console-advertising-actions-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const current = vi.fn(() => true)
const id = `act_${'a'.repeat(32)}`
const revision = 'b'.repeat(64)
const target = {
  domain: 'advertising',
  company: 'omnirogue',
  type: 'adset',
  id: '120000001'
} as const
const scope = { target, verb: 'pause' } as const
const read = { id, ...scope }
const execute = {
  ...read,
  expected_revision: revision,
  idempotency_key: 'tsa:decision-1',
  approved: true
} as const
const at = '2026-09-20T12:00:00Z'
const base = 'https://console.test/api/gtd/hub/api/actions'

function preview(over: Record<string, unknown> = {}) {
  return {
    id,
    revision,
    protocol_version: 'human-action.v1',
    principal: 'human:emp_sal',
    service: null,
    actor_kind: 'human',
    ...scope,
    expected_version: 'native-v1',
    created_at: at,
    expires_at: '2026-09-20T12:10:00Z',
    undo_of: null,
    parameters: {},
    reason: '',
    snapshot: {
      id: 'native-internal-row',
      objectId: target.id,
      adAccountId: 'act_1000000000000002',
      level: target.type,
      parentId: '120000000',
      campaignId: '120000000',
      status: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      dailyBudget: 25,
      lifetimeBudget: null,
      currency: 'USD',
      budgetOwnerId: null,
      ancestors: []
    },
    transition: { field: 'status', from: 'active', to: 'paused' },
    authority: { revision: 'authority-v1', details: {} },
    risk: { action_class: 'external_reversible', requires_confirmation: true },
    summary: 'Pause DTC prospecting',
    financial_impact: {
      currency: 'USD',
      profit_effect: 'unproven',
      daily_budget_ceiling: 25,
      basis: 'Budget ceiling; delivery and profit are not guaranteed'
    },
    undo: {},
    evidence: {},
    ...over
  }
}
function receipt(over: Record<string, unknown> = {}) {
  return { id, status: 'preview', preview: preview(), execution: null, ...over }
}
function execution(over: Record<string, unknown> = {}) {
  return {
    idempotency_key: execute.idempotency_key,
    requested_at: at,
    dispatched_at: at,
    completed_at: null,
    outcome: { accepted: true, reference: 'native-write-1', result: {} },
    verification: null,
    ...over
  }
}
function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}
function requested() {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return { url, init }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('fetch', fetchMock)
  current.mockReturnValue(true)
  vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
    ok: true,
    data: {
      bearer: 'test-person-only',
      baseUrl: 'https://console.test',
      principal: 'test-person',
      isCurrent: current
    }
  } as never)
})

describe('signed advertising actions', () => {
  it('discovers only supported status verbs and native object types', async () => {
    const capability = {
      label: 'Change status',
      action_class: 'consequential',
      requires_confirmation: true
    }
    reply({
      items: [
        { ...capability, verb: 'pause', target_types: ['campaign', 'adset', 'ad', 'adgroup'] },
        { ...capability, verb: 'resume', target_types: ['campaign'] },
        { ...capability, verb: 'increase_budget', target_types: ['campaign'] }
      ]
    })
    const result = await client.capabilities({ company: 'betacorp' })
    expect(result.ok && result.data.items.map((item) => item.verb)).toEqual(['pause', 'resume'])
    expect(result.ok && result.data.items[0].target_types).toEqual(['campaign', 'adset', 'ad'])
    expect(requested().url).toBe(`${base}/capabilities?domain=advertising&company=betacorp`)
  })

  it('previews the exact object using signed transport and an empty parameter set', async () => {
    reply(preview())
    expect(await client.preview(scope, 'test-person')).toMatchObject({
      ok: true,
      data: { id, target }
    })
    expect(requested().url).toBe(`${base}/preview`)
    expect(requested().init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error'
    })
    expect(JSON.parse(String(requested().init.body))).toEqual({ ...scope, parameters: {} })
    expect(requested().init.headers).toEqual({
      accept: 'application/json',
      Authorization: 'Bearer test-person-only',
      'Content-Type': 'application/json'
    })
  })

  it.each([
    { verb: 'increase_budget' },
    { parameters: { daily_budget: 100 } },
    { target: { ...target, company: 'acme' } },
    { target: { ...target, domain: 'finance' } },
    { target: { ...target, type: 'adgroup' } },
    { target: { ...target, id: 'google:account:object' } },
    { target: { ...target, id: '../120000001' } },
    { reason: 'x'.repeat(1001) },
    { actor: 'human:emp_other' }
  ])('refuses unscoped or broader preview input before fetching: %j', async (over) => {
    expect(await client.preview({ ...scope, ...over } as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { target: { ...target, company: 'betacorp' } },
    { target: { ...target, id: '120000002' } },
    { verb: 'resume', transition: { field: 'status', from: 'paused', to: 'active' } },
    { snapshot: { ...preview().snapshot, objectId: '120000003' } },
    { snapshot: { ...preview().snapshot, parentId: null } },
    { snapshot: { ...preview().snapshot, parentId: '120000004' } },
    { transition: { field: 'status', from: 'active', to: 'active' } }
  ])('refuses a preview with mismatched action, native identity or hierarchy: %j', async (over) => {
    reply(preview(over))
    expect(await client.preview(scope)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })

  it('keeps raw provider budget strings without changing the reviewed value', async () => {
    reply(preview({ snapshot: { ...preview().snapshot, dailyBudget: '25.00' } }))
    const result = await client.preview(scope)
    expect(result.ok && result.data.snapshot.dailyBudget).toBe('25.00')
  })

  it('reads a receipt for the requested proposal and scope', async () => {
    reply(receipt())
    expect((await client.get(read)).ok).toBe(true)
    expect(requested().url).toBe(`${base}/${id}`)
    expect(requested().init).toMatchObject({ method: 'GET' })
    expect(requested().init.body).toBeUndefined()
  })

  it('executes only the reviewed revision with one stable key and explicit approval', async () => {
    reply(receipt({ status: 'accepted', execution: execution() }))
    expect(await client.execute(execute, 'test-person')).toMatchObject({
      ok: true,
      data: { status: 'accepted' }
    })
    expect(requested().url).toBe(`${base}/${id}/execute`)
    expect(JSON.parse(String(requested().init.body))).toEqual({
      expected_revision: revision,
      idempotency_key: execute.idempotency_key,
      approved: true
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    { approved: false },
    { approved: 'true' },
    { expected_revision: 'old' },
    { idempotency_key: 'short' },
    { idempotency_key: 'with spaces' },
    { parameters: { budget: 200 } }
  ])('refuses an invalid execute contract before fetching: %j', async (over) => {
    expect(await client.execute({ ...execute, ...over } as never)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { preview: preview({ revision: 'c'.repeat(64) }), execution: execution() },
    { preview: preview({ target: { ...target, company: 'betacorp' } }), execution: execution() },
    { execution: execution({ idempotency_key: 'tsa:other-request' }) }
  ])('refuses an execution receipt from another reviewed request: %j', async (over) => {
    reply(receipt({ status: 'accepted', ...over }))
    expect(await client.execute(execute)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })

  it('requests readback without replaying execution or sending local scope fields', async () => {
    reply(receipt({ status: 'unverified', execution: execution() }))
    expect(await client.verify(read)).toMatchObject({ ok: true, data: { status: 'unverified' } })
    expect(requested().url).toBe(`${base}/${id}/verify`)
    expect(JSON.parse(String(requested().init.body))).toEqual({})
  })

  it('refuses a verified claim with only an accepted write', async () => {
    reply(receipt({ status: 'verified', execution: execution() }))
    expect(await client.verify(read)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })

  it('accepts verification only with native source and version evidence', async () => {
    reply(
      receipt({
        status: 'verified',
        execution: execution({
          verification: {
            status: 'verified',
            observed: { status: 'PAUSED' },
            source: 'Native provider readback',
            reference: 'native-write-1',
            version: 'native-v2',
            checked_at: at
          }
        })
      })
    )
    expect(await client.verify(read)).toMatchObject({ ok: true, data: { status: 'verified' } })
  })

  it('preserves a retained expired receipt without making it a fresh preview', async () => {
    const full = preview()
    const expired = {
      id,
      revision,
      protocol_version: full.protocol_version,
      principal: full.principal,
      service: null,
      actor_kind: full.actor_kind,
      ...scope,
      expected_version: full.expected_version,
      created_at: at,
      expires_at: full.expires_at,
      undo_of: null,
      details_expired: true
    }
    reply(receipt({ preview: expired }))
    expect(await client.get(read)).toMatchObject({
      ok: true,
      data: { preview: { details_expired: true } }
    })
    reply(expired)
    expect(await client.preview(scope)).toMatchObject({
      ok: false,
      error: { code: 'invalid_response' }
    })
  })

  it('fences the signed principal before any request', async () => {
    expect(await client.execute(execute, 'another-person')).toMatchObject({
      ok: false,
      error: { code: 'principal_mismatch' }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an account switch during the request', async () => {
    fetchMock.mockImplementationOnce(async () => {
      current.mockReturnValue(false)
      return new Response(JSON.stringify(preview()))
    })
    expect(await client.preview(scope)).toMatchObject({
      ok: false,
      error: { code: 'connection_changed' }
    })
  })

  it('retains hub refusal codes and never retries an uncertain execute', async () => {
    reply({ detail: { code: 'revision_mismatch', message: 'Preview changed.' } }, 409)
    expect(await client.execute(execute)).toMatchObject({
      ok: false,
      error: { code: 'revision_mismatch', status: 409 }
    })
    fetchMock.mockReset()
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
    expect(await client.execute(execute)).toMatchObject({
      ok: false,
      error: { code: 'backoffice_unavailable' }
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
