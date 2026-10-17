import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleQuickBooksClient as client } from './console-quickbooks-client'
import { captureConsoleWorkflowPerson } from './console-workflow-person'

vi.mock('./console-workflow-person', () => ({
  captureConsoleWorkflowPerson: vi.fn(),
  redactConsoleWorkflowMemory: (value: unknown) => value
}))
const fetchMock = vi.fn<typeof fetch>()
const current = vi.fn(() => true)
function reply(body: unknown, status = 200): void {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }))
}
function requested(): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
  return { url, init }
}
const status = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  provider: 'quickbooks',
  oauth: { configured: true, connect_supported: true, missing_requirements: [] },
  companies: [
    {
      company_id: 'c1',
      company_slug: 'omnirogue',
      company_name: 'OmniRogue Inc',
      realm_id: '9341',
      status: 'connected_enabled',
      reason_code: null,
      checked_at: '2026-09-12T12:00:00Z',
      mappings: [
        { ledger_kind: 'cash', account_id: 'a1', expected_type: 'Bank', source_account_id: 's1' }
      ]
    }
  ],
  sync_health: 'ready',
  ...over
})

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

describe('the books connection read', () => {
  it('reads the connection on the signed connection, carrying no cookie', async () => {
    reply(status())
    const result = await client.status()
    expect(result.ok).toBe(true)
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/accounting/connections/quickbooks')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
  })

  it('refuses an answer from a different provider', async () => {
    reply(status({ provider: 'xero' }))
    const result = await client.status()
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('invalid_response')
  })

  it('keeps a status it has never seen rather than flattening it', async () => {
    // A new provider state is information; dropping it would hide a real condition.
    reply(
      status({
        companies: [
          { ...((status().companies as never[])[0] as object), status: 'brand_new_state' }
        ]
      })
    )
    const result = await client.status()
    expect(result.ok && result.data.companies[0].status).toBe('brand_new_state')
  })

  it('relays the console refusal rather than reporting the books as disconnected', async () => {
    reply({ detail: 'Accounting is limited to admins.', tag: 'forbidden' }, 403)
    const result = await client.status()
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.status).toBe(403)
  })

  it('says nobody is signed in rather than showing an empty connection list', async () => {
    reply({ detail: 'Sign in.' }, 401)
    const result = await client.status()
    expect(!result.ok && result.error.code).toBe('signed_in_required')
  })

  it('reads a connection that is not yet authorized, with its reason intact', async () => {
    reply(
      status({
        oauth: {
          configured: false,
          connect_supported: true,
          missing_requirements: ['client_secret']
        },
        companies: [
          {
            company_id: 'c2',
            company_slug: 'acme',
            company_name: 'ACME',
            realm_id: null,
            status: 'waiting_for_access',
            reason_code: 'access_missing',
            checked_at: null,
            mappings: []
          }
        ]
      })
    )
    const result = await client.status()
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.data.oauth.configured).toBe(false)
    expect(result.data.oauth.missing_requirements).toEqual(['client_secret'])
    expect(result.data.companies[0].reason_code).toBe('access_missing')
  })
})
