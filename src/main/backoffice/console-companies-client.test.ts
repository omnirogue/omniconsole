import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleCompaniesClient as client } from './console-companies-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const current = vi.fn(() => true)
function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}
function requested(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return { url, init }
}
const snapshot = {
  company: 'omnirogue',
  name: 'OmniRogue',
  generated_at: '2026-09-11T09:00:00Z',
  bank: {
    status: 'ready',
    last_synced_at: '2026-09-11T08:00:00Z',
    last_attempt_at: '2026-09-11T08:00:00Z',
    error: null,
    accounts: [
      {
        id: 'acc_1',
        name: 'Operating',
        kind: 'checking',
        mask: '4321',
        currency: 'USD',
        cash_available_minor: 1_250_00,
        cash_posted_minor: 1_250_00,
        credit_available_minor: null,
        credit_posted_minor: null,
        credit_owed_minor: null
      }
    ],
    transactions: [],
    coverage: { from: '2026-08-01', to: '2026-09-11', complete: true }
  },
  books: {
    status: 'ready',
    last_synced_at: null,
    company_name: 'OmniRogue Inc',
    realm_id: null,
    reports: {},
    connection_url: 'https://omnios.test/connect',
    note: null
  },
  automation: { task_url: null, task_title: null, status: 'active', source: 'bank', note: null }
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

describe('native companies read contract', () => {
  it('reads the estate rollup on the signed connection and keeps the hub freshness fields', async () => {
    reply({
      ok: true,
      stale: true,
      age_s: 42,
      window_hours: 24,
      companies: [{ company_id: 'omnirogue', slug: 'omnirogue', name: 'OmniRogue', active: 3 }]
    })
    const result = await client.rollup()
    expect(result.ok && result.data.companies[0].active).toBe(3)
    expect(result.ok && result.data.stale).toBe(true)
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/estate/rollup')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
  })

  it('scopes the scorecard to one company and never accepts another company in the answer', async () => {
    reply({
      generated_at: '2026-09-11T09:00:00Z',
      timezone: 'UTC',
      companies: [
        {
          id: 'c1',
          slug: 'betacorp',
          name: 'BetaCorp',
          status: 'healthy',
          href: '/c/betacorp',
          domains: []
        }
      ]
    })
    const wrongScope = await client.health({ company: 'omnirogue' })
    expect(wrongScope.ok).toBe(false)
    expect(requested().url).toBe(
      'https://console.test/api/gtd/scorecard/attention?company=omnirogue'
    )
  })

  it('reads the console folder tree the Companies surfaces file by', async () => {
    reply({
      ok: true,
      companies: [
        {
          id: 'co_1',
          slug: 'omnirogue',
          name: 'OmniRogue',
          domains: [{ id: 'd_1', name: 'Sales', count: 2, parent_unit_id: null }]
        }
      ]
    })
    const result = await client.folders()
    expect(result.ok && result.data.companies[0].domains[0].name).toBe('Sales')
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/work/folders')
    expect(init.method).toBe('GET')
  })

  it('refuses a company id that is not a plain identifier before any request', async () => {
    const result = await client.company({ companyId: '../estate/rollup' })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'The workflow request does not match this operation.'
      }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an accounting snapshot that answers for a different company', async () => {
    reply({ ...snapshot, company: 'acme' })
    const result = await client.accounting({ company: 'omnirogue' })
    expect(result.ok).toBe(false)
    expect(requested().url).toBe('https://console.test/api/accounting?company=omnirogue')
  })

  it('returns the bank snapshot and queues a refresh the person asked for', async () => {
    reply(snapshot)
    const read = await client.accounting({ company: 'omnirogue' })
    expect(read.ok && read.data.bank.accounts[0].cash_available_minor).toBe(125000)
    fetchMock.mockClear()
    reply({ queued: true })
    const queued = await client.syncAccounting({ company: 'omnirogue' })
    expect(queued).toEqual({ ok: true, data: { queued: true } })
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/accounting/omnirogue/sync')
    expect(init.method).toBe('POST')
  })

  it('reads the bank export as text and names the file after the company', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('date,amount\n2026-09-11,10.00\n', { status: 200 })
    )
    const result = await client.transactionsCsv({ company: 'acme' })
    expect(result.ok && result.data.filename).toBe('acme-bank-transactions.csv')
    expect(result.ok && result.data.csv).toContain('2026-09-11,10.00')
    expect(requested().url).toBe('https://console.test/api/accounting/acme/transactions.csv')
  })

  it('cancels the export body it will not read, which undici needs to stay alive', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const refused = new Response('should not be read', { status: 403 })
    Object.defineProperty(refused, 'body', { value: { cancel } })
    fetchMock.mockResolvedValueOnce(refused)
    const result = await client.transactionsCsv({ company: 'omnirogue' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('forbidden')
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('does not hand back an export captured after the signed person changed', async () => {
    fetchMock.mockResolvedValueOnce(new Response('date,amount\n', { status: 200 }))
    current.mockReturnValue(false)
    const result = await client.transactionsCsv({ company: 'omnirogue' })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'connection_changed',
        message: 'The signed-in person or connection changed; refresh before continuing.'
      }
    })
  })

  it('passes the signed-out refusal through untouched instead of reading anything', async () => {
    vi.mocked(captureConsoleWorkflowPerson).mockResolvedValue({
      ok: false,
      error: {
        code: 'signed_in_required',
        message: 'Sign in to OmniConsole before using workflows.'
      }
    } as never)
    expect(await client.rollup()).toEqual({
      ok: false,
      error: {
        code: 'signed_in_required',
        message: 'Sign in to OmniConsole before using workflows.'
      }
    })
    expect(await client.transactionsCsv({ company: 'omnirogue' })).toEqual({
      ok: false,
      error: {
        code: 'signed_in_required',
        message: 'Sign in to OmniConsole before using workflows.'
      }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // Why: the Companies tree and every folder-scoped filter read this one route. It shipped
  // missing from the transport allowlist, so `folders()` was refused before it ever reached
  // the network and the tree could only ever be empty. Assert it actually goes out.
  it('reads the work folders the Companies tree is built from', async () => {
    reply({
      ok: true,
      companies: [
        {
          id: 'c1',
          slug: 'omnirogue',
          name: 'OmniRogue',
          count: 2,
          domains: [{ id: 'u1', name: 'Sales', count: 2, parent_unit_id: null }]
        }
      ]
    })
    const result = await client.folders()
    expect(result.ok).toBe(true)
    expect(result.ok && result.data.companies[0].domains[0].name).toBe('Sales')
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/work/folders')
    expect(init.method).toBe('GET')
  })

  it('refuses a route the allowlist does not carry instead of sending it', async () => {
    const result = await client.company({ companyId: '../../api/admin/users' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('invalid_request')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
