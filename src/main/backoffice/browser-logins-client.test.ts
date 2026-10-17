import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserLoginsClient as client } from './browser-logins-client'
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

function requested(index = 0): { url: string; init: RequestInit } {
  const [url, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit]
  return { url, init }
}

const profile = {
  profile_id: 'stripe_omnirogue',
  service: 'Stripe',
  url: 'https://dashboard.stripe.com',
  company_id: 'omnirogue',
  company_slug: 'omnirogue',
  login_status: 'verified',
  verified_at: '2026-09-14T00:00:00Z',
  reason_code: null,
  revision: 3,
  operate_capability: 'airtop_stripe_omnirogue.operate',
  identity_notice: "Shared profile — this is Sal's identity at Stripe. Act as Sal would.",
  actions: ['open', 'verify'],
  notes: null,
  aliases: []
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

describe('the browser-login rail read contract', () => {
  it('lists every shared profile', async () => {
    reply({ profiles: [profile] })
    const result = await client.list()
    expect(result.ok && result.data.profiles[0].profile_id).toBe('stripe_omnirogue')
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/connections/browser-profiles')
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
  })

  it('reads one profile’s live status', async () => {
    reply({
      profile_id: 'stripe_omnirogue',
      service: 'Stripe',
      login_status: 'verified',
      revision: 3,
      verified_at: '2026-09-14T00:00:00Z',
      reason_code: null
    })
    const result = await client.status({ profile_id: 'stripe_omnirogue' })
    expect(result.ok && result.data.login_status).toBe('verified')
    expect(requested().url).toBe(
      'https://console.test/api/connections/browser-profiles/stripe_omnirogue'
    )
  })

  it('never accepts another profile’s status as the one asked for', async () => {
    reply({
      profile_id: 'freshdesk_acme',
      service: 'Freshdesk',
      login_status: 'verified',
      revision: 1
    })
    const result = await client.status({ profile_id: 'stripe_omnirogue' })
    expect(result.ok).toBe(false)
  })

  it('refuses a profile id that is not a profile id before any request', async () => {
    const result = await client.status({ profile_id: '../../etc/passwd' })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid_request',
        message: 'The workflow request does not match this operation.'
      }
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the browser-login rail write contract', () => {
  it('opens the live view as a POST with reconnect defaulted', async () => {
    reply({
      profile_id: 'stripe_omnirogue',
      service: 'Stripe',
      login_status: 'sign_in_required',
      revision: 3,
      live_view_url: 'https://airtop.test/live/abc'
    })
    const result = await client.open({ profile_id: 'stripe_omnirogue' })
    expect(result.ok && result.data.live_view_url).toBe('https://airtop.test/live/abc')
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/connections/browser-profiles/stripe_omnirogue/open')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ reconnect: false })
  })

  it('saves at the revision it was opened at', async () => {
    reply({
      profile_id: 'stripe_omnirogue',
      service: 'Stripe',
      login_status: 'not_checked',
      revision: 4
    })
    const result = await client.save({ profile_id: 'stripe_omnirogue', expected_revision: 3 })
    expect(result.ok).toBe(true)
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/connections/browser-profiles/stripe_omnirogue/save')
    expect(JSON.parse(String(init.body))).toEqual({ expected_revision: 3 })
  })

  it('verifies the saved session', async () => {
    reply({
      profile_id: 'stripe_omnirogue',
      service: 'Stripe',
      login_status: 'verified',
      revision: 4
    })
    const result = await client.verify({ profile_id: 'stripe_omnirogue', expected_revision: 4 })
    expect(result.ok).toBe(true)
    expect(requested().url).toBe(
      'https://console.test/api/connections/browser-profiles/stripe_omnirogue/verify'
    )
  })

  it('adds a new shared site', async () => {
    reply(profile)
    const result = await client.add({
      profile_id: 'stripe_omnirogue',
      service: 'Stripe',
      url: 'https://dashboard.stripe.com',
      company_id: 'omnirogue',
      expected_identity: 'Sal'
    })
    expect(result.ok).toBe(true)
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/connections/browser-profiles')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({
      profile_id: 'stripe_omnirogue',
      service: 'Stripe',
      url: 'https://dashboard.stripe.com',
      company_id: 'omnirogue',
      expected_identity: 'Sal'
    })
  })

  it('adds a new shared site with no expected identity — the hub decides it is optional', async () => {
    reply(profile)
    const result = await client.add({
      profile_id: 'stripe_omnirogue',
      service: 'Stripe',
      url: 'https://dashboard.stripe.com',
      company_id: 'omnirogue'
    })
    expect(result.ok).toBe(true)
    expect(JSON.parse(String(requested().init.body))).toEqual({
      profile_id: 'stripe_omnirogue',
      service: 'Stripe',
      url: 'https://dashboard.stripe.com',
      company_id: 'omnirogue'
    })
  })

  it('refuses to add a site with an insecure url before any request', async () => {
    const result = await client.add({
      profile_id: 'stripe_omnirogue',
      service: 'Stripe',
      url: 'http://dashboard.stripe.com',
      company_id: 'omnirogue',
      expected_identity: 'Sal'
    })
    expect(result.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('runs the verify-all sweep with no body', async () => {
    reply({ checked: 5, needs_login: 1 })
    const result = await client.verifyAll()
    expect(result.ok).toBe(true)
    const { url, init } = requested()
    expect(url).toBe('https://console.test/api/admin/browser-profiles/verify-all')
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
  })

  it('relays the console’s own refusal untouched', async () => {
    reply(
      { detail: 'Only an active employee may re-login this profile.', tag: 'not_authorized' },
      403
    )
    const result = await client.open({ profile_id: 'stripe_omnirogue' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('not_authorized')
    expect(!result.ok && result.error.status).toBe(403)
  })
})
