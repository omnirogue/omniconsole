import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consoleAdvertisingClient as client } from './console-advertising-client'
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

function adRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    platform_id: '120000001',
    level: 'campaign',
    name: 'DTC · Seedance',
    campaign_id: '120000001',
    campaign_name: 'DTC · Seedance',
    parent_id: null,
    segment: 'dtc',
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    spend: 120,
    link_clicks: 60,
    cpc_link: 99,
    checkouts: 4,
    add_to_carts: 8,
    impressions: 10_000,
    reach: 5000,
    revenue: 480,
    leads: 3,
    lead_event: 'Lead',
    registrations: 12,
    purchases: 2,
    can_pause: true,
    pause_blocker: null,
    measured_at: '2026-09-12T12:00:00Z',
    ...over
  }
}
function adsReport(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    company: 'omnirogue',
    account_id: 'act_2337',
    currency: 'USD',
    measured_at: '2026-09-12T12:00:00Z',
    date_start: '2026-09-12',
    date_stop: '2026-09-12',
    timezone: 'America/New_York',
    fetched_at: '2026-09-12T12:01:00Z',
    partial: false,
    rows: [adRow()],
    sources: [{ name: 'meta:insights', ok: true, note: null, error: null, fetched_at: null }],
    can_pause: true,
    ...over
  }
}
const period = (key: string): Record<string, unknown> => ({
  key,
  label: key,
  date_start: '2026-09-12',
  date_stop: '2026-09-12',
  start_at: '2026-09-12T00:00:00-04:00',
  end_at: '2026-09-12T12:00:00-04:00',
  partial: key === 'today',
  currency: 'USD',
  metrics: { spend: 120, net_revenue: 480 },
  channels: [],
  sources: [],
  notes: []
})
const dailyBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema_version: 1,
  company: 'all',
  timezone: 'America/New_York',
  generated_at: '2026-09-12T12:00:00Z',
  periods: [period('today'), period('yesterday')],
  companies: ['omnirogue', 'betacorp'],
  connections: [],
  definitions: [],
  routine: null,
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

describe('native advertising read contract', () => {
  it('reads one account at one level on the signed connection, carrying no cookie', async () => {
    reply(adsReport())
    const result = await client.salesAds({
      company: 'omnirogue',
      rangeDays: 1,
      level: 'campaign',
      state: 'all'
    })
    expect(result.ok).toBe(true)
    const { url, init } = requested()
    expect(url).toBe(
      'https://console.test/api/gtd/hub/api/sales/ads?company=omnirogue&range_days=1&level=campaign&state=all'
    )
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('omit')
    expect(init.redirect).toBe('error')
  })

  it('derives every cost per result from the two figures shown, and never from the provider CPC', async () => {
    reply(adsReport())
    const result = await client.salesAds({
      company: 'omnirogue',
      rangeDays: 1,
      level: 'campaign',
      state: 'all'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const row = result.data.rows[0]
    // The payload claimed cpc_link 99; spend 120 over 60 link clicks is 2.
    expect(row.cpc_link).toBe(2)
    expect(row.cpl).toBe(40)
    expect(row.cost_per_registration).toBe(10)
    expect(row.cost_per_add_to_cart).toBe(15)
    expect(row.cost_per_checkout).toBe(30)
    expect(row.cost_per_purchase).toBe(60)
    expect(row.roas).toBe(4)
  })

  it('shows no cost for a result nobody produced, rather than a free one', async () => {
    reply(adsReport({ rows: [adRow({ purchases: 0, registrations: null, leads: 0 })] }))
    const result = await client.salesAds({
      company: 'omnirogue',
      rangeDays: 1,
      level: 'campaign',
      state: 'all'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    const row = result.data.rows[0]
    expect(row.cost_per_purchase).toBeNull()
    expect(row.cost_per_registration).toBeNull()
    expect(row.cpl).toBeNull()
  })

  it('refuses a CPL when the account maps no Lead event', async () => {
    reply(adsReport({ rows: [adRow({ lead_event: null, leads: 3 })] }))
    const result = await client.salesAds({
      company: 'omnirogue',
      rangeDays: 1,
      level: 'campaign',
      state: 'all'
    })
    expect(result.ok && result.data.rows[0].cpl).toBeNull()
    expect(result.ok && result.data.rows[0].leads).toBe(3)
  })

  it('refuses an advertising report for another company', async () => {
    reply(adsReport({ company: 'betacorp' }))
    const result = await client.salesAds({
      company: 'omnirogue',
      rangeDays: 1,
      level: 'campaign',
      state: 'all'
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('invalid_response')
  })

  it('refuses a report that mixes levels, which would add a campaign to its own ad sets', async () => {
    reply(adsReport({ rows: [adRow(), adRow({ id: 'row-2', level: 'adset' })] }))
    const result = await client.salesAds({
      company: 'omnirogue',
      rangeDays: 1,
      level: 'campaign',
      state: 'all'
    })
    expect(result.ok).toBe(false)
  })

  it('reads the ad-set level for the same account and window', async () => {
    reply(adsReport({ rows: [adRow({ level: 'adset', id: 'as-1', platform_id: '230000001' })] }))
    await client.salesAds({ company: 'betacorp', rangeDays: 7, level: 'adset', state: 'active' })
    expect(requested().url).toBe(
      'https://console.test/api/gtd/hub/api/sales/ads?company=betacorp&range_days=7&level=adset&state=active'
    )
  })

  it('keeps a paginated ad-set read alive through the BFF response deadline', async () => {
    vi.useFakeTimers()
    const abortClock = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), milliseconds)
      return controller.signal
    })
    try {
      fetchMock.mockImplementationOnce(
        (_url, init) =>
          new Promise((resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('read aborted')))
            setTimeout(
              () =>
                resolve(
                  new Response(
                    JSON.stringify(
                      adsReport({
                        rows: [adRow({ level: 'adset' })]
                      })
                    )
                  )
                ),
              42_000
            )
          })
      )
      const pending = client.salesAds({
        company: 'omnirogue',
        rangeDays: 1,
        level: 'adset',
        state: 'all'
      })
      await vi.advanceTimersByTimeAsync(42_000)
      expect((await pending).ok).toBe(true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      abortClock.mockRestore()
      vi.useRealTimers()
    }
  })

  it('reads the multichannel daily comparison for both companies at once', async () => {
    reply(dailyBody())
    const result = await client.dailySales({ scope: 'all', rangeDays: 1, sameTime: true })
    expect(result.ok).toBe(true)
    expect(requested().url).toBe(
      'https://console.test/api/gtd/hub/api/sales/daily?company=all&range_days=1&same_time=true'
    )
  })

  it('refuses a daily report with no yesterday to compare against', async () => {
    reply(dailyBody({ periods: [period('today')] }))
    const result = await client.dailySales({ scope: 'all', rangeDays: 1, sameTime: true })
    expect(result.ok).toBe(false)
  })

  it('refuses a daily report for a different company scope', async () => {
    reply(dailyBody({ company: 'betacorp' }))
    const result = await client.dailySales({ scope: 'omnirogue', rangeDays: 1, sameTime: true })
    expect(result.ok).toBe(false)
  })

  it('reads the Enterprise webinar funnel for one window and rejects another', async () => {
    const summary = {
      company: 'omnirogue',
      provider: 'everwebinar',
      window: 'd7',
      cohort: {
        basis: 'signup_date',
        start: '2026-09-05T00:00:00-04:00',
        end: '2026-09-11T23:59:59-04:00',
        time_zone: 'America/New_York',
        includes_today: false
      },
      as_of: '2026-09-12T12:00:00-04:00',
      metrics: {
        registrations: 40,
        attended: 18,
        attended_live: 12,
        attended_replay: 6,
        attendance_rate: 0.45,
        avg_live_watch_seconds: 900,
        live_watch_samples: 12,
        live_watch_missing: 0,
        live_watch_zero: 1,
        watched_full: 5,
        // Consistent on purpose: every attendee's completion is known, so the rate is
        // the completions over the attendance. An inconsistent fixture would be refused.
        watched_rate: 5 / 18,
        completion_known_attendees: 18,
        completion_unknown_attendees: 0
      },
      by_adset: [],
      by_ad: [],
      attribution: {
        adset_mapped_registrations: 36,
        ad_mapped_registrations: 30,
        unattributed_adset_registrations: 4,
        unattributed_ad_registrations: 10,
        unresolved_template_registrations: 0
      }
    }
    reply({ status: 'ready', refreshing: false, data: summary })
    const ok = await client.webinar({ window: 'd7' })
    expect(ok.ok).toBe(true)
    expect(requested().url).toBe(
      'https://console.test/api/gtd/hub/api/adops/webinarjam/summary?company=omnirogue&window=d7'
    )
    fetchMock.mockReset()
    reply({ status: 'ready', refreshing: false, data: { ...summary, window: 'today' } })
    expect((await client.webinar({ window: 'd7' })).ok).toBe(false)
  })

  it('refuses a funnel whose completion counts cannot be true', async () => {
    const inconsistent = {
      company: 'omnirogue',
      provider: 'everwebinar',
      window: 'today',
      cohort: {
        basis: 'signup_date',
        start: '2026-09-12T00:00:00-04:00',
        end: '2026-09-12T23:59:59-04:00',
        time_zone: 'America/New_York',
        includes_today: true
      },
      as_of: '2026-09-12T12:00:00-04:00',
      metrics: {
        registrations: 10,
        attended: 4,
        attended_live: 4,
        attended_replay: 0,
        attendance_rate: 0.4,
        avg_live_watch_seconds: 100,
        live_watch_samples: 4,
        live_watch_missing: 0,
        live_watch_zero: 0,
        // More full completions than people who attended: this cannot be true, and the
        // figure is one Sal reads against Meta's own events.
        watched_full: 9,
        watched_rate: 2.25,
        completion_known_attendees: 4,
        completion_unknown_attendees: 0
      },
      by_adset: [],
      by_ad: [],
      attribution: {
        adset_mapped_registrations: 10,
        ad_mapped_registrations: 10,
        unattributed_adset_registrations: 0,
        unattributed_ad_registrations: 0,
        unresolved_template_registrations: 0
      }
    }
    reply({ status: 'ready', refreshing: false, data: inconsistent })
    const result = await client.webinar({ window: 'today' })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('invalid_response')
  })

  it('still reads an older funnel that carries no completion fields at all', async () => {
    reply({
      status: 'ready',
      refreshing: false,
      data: {
        company: 'omnirogue',
        provider: 'everwebinar',
        window: 'today',
        cohort: {
          basis: 'signup_date',
          start: '2026-09-12T00:00:00-04:00',
          end: '2026-09-12T23:59:59-04:00',
          time_zone: 'America/New_York',
          includes_today: true
        },
        as_of: '2026-09-12T12:00:00-04:00',
        metrics: {
          registrations: 10,
          attended: 4,
          attended_live: 4,
          attended_replay: 0,
          attendance_rate: 0.4,
          avg_live_watch_seconds: 100,
          live_watch_samples: 4,
          live_watch_missing: 0,
          live_watch_zero: 0
        },
        by_adset: [],
        by_ad: [],
        attribution: {
          adset_mapped_registrations: 10,
          ad_mapped_registrations: 10,
          unattributed_adset_registrations: 0,
          unattributed_ad_registrations: 0,
          unresolved_template_registrations: 0
        }
      }
    })
    // The original accepts these while the backend rolls the fields out; so does this.
    expect((await client.webinar({ window: 'today' })).ok).toBe(true)
  })

  it('reads the coordinator list and resolves nothing when it is ambiguous', async () => {
    reply({
      instances: [
        { id: 'a', company: 'omnirogue', config: { execution_mode: 'account_coordinator' } },
        { id: 'b', company: 'OmniRogue', config: { execution_mode: 'account_coordinator' } }
      ]
    })
    const result = await client.adOps()
    expect(result.ok).toBe(true)
    expect(requested().url).toBe('https://console.test/api/gtd/hub/api/adops')
  })

  it('asks for one bounded evidence page and refuses an answer from a different page', async () => {
    const decision = (
      pagination: Record<string, unknown> | undefined
    ): Record<string, unknown> => ({
      schema_version: 1,
      company: 'omnirogue',
      account_id: 'act_2337',
      ...(pagination ? { pagination } : {}),
      operation: {
        mode: 'auto',
        status: 'armed',
        coverage: { evaluated: 12, active: 4, paused: 8, campaigns: 4, adsets: 12, ads: 20 },
        errors: []
      },
      windows: {
        timezone: 'America/New_York',
        today: { start: '2026-09-12T00:00:00-04:00', end: '2026-09-12T12:00:00-04:00' },
        seven: { start: '2026-09-05', end: '2026-09-11' }
      },
      money: { spend_today: 120, active_daily_budget: 300, currency: 'USD' },
      decisions: [],
      policy: { probability_model_calibrated: false }
    })
    reply(
      decision({
        section: 'decisions',
        offset: 0,
        limit: 10,
        total: 3,
        returned: 0,
        has_more: false,
        campaign_id: null
      })
    )
    const ok = await client.decision({
      instanceId: 'omnirogue-omnirogue-ad-monitor',
      section: 'decisions',
      offset: 0,
      limit: 10
    })
    expect(ok.ok).toBe(true)
    expect(requested().url).toBe(
      'https://console.test/api/gtd/hub/api/adops/instances/omnirogue-omnirogue-ad-monitor/decision?section=decisions&offset=0&limit=10'
    )
    fetchMock.mockReset()
    reply(
      decision({
        section: 'decisions',
        offset: 10,
        limit: 10,
        total: 3,
        returned: 0,
        has_more: false,
        campaign_id: null
      })
    )
    const wrongPage = await client.decision({
      instanceId: 'omnirogue-omnirogue-ad-monitor',
      section: 'decisions',
      offset: 0,
      limit: 10
    })
    expect(wrongPage.ok).toBe(false)
  })

  it('omits the page parameters on the overview section, which the allowlist requires', async () => {
    reply({
      schema_version: 1,
      company: 'betacorp',
      account_id: 'act_2209',
      operation: { mode: 'recommend', status: 'idle', coverage: {}, errors: [] },
      windows: {
        timezone: null,
        today: { start: null, end: null },
        seven: { start: null, end: null }
      },
      money: {},
      decisions: [],
      policy: {}
    })
    await client.decision({
      instanceId: 'betacorp-betacorp-ad-monitor',
      section: 'overview',
      offset: 0,
      limit: 10
    })
    expect(requested().url).toBe(
      'https://console.test/api/gtd/hub/api/adops/instances/betacorp-betacorp-ad-monitor/decision?section=overview'
    )
  })

  it('filters a statistics page by its exact native campaign and checks the echoed scope', async () => {
    const campaignId = '120000001'
    const request = {
      instanceId: 'adops-omnirogue',
      section: 'statistics' as const,
      offset: 0,
      limit: 20,
      campaignId
    }
    const decision = (pagination: Record<string, unknown> | undefined) => ({
      schema_version: 1,
      company: 'omnirogue',
      account_id: 'act_1000000000000002',
      operation: { mode: 'recommend', status: 'idle', coverage: {}, errors: [] },
      windows: {
        timezone: 'America/New_York',
        today: { start: null, end: null },
        seven: { start: null, end: null }
      },
      money: {},
      decisions: [],
      policy: {},
      ...(pagination ? { pagination } : {})
    })
    const page = {
      section: 'statistics',
      offset: 0,
      limit: 20,
      total: 0,
      returned: 0,
      has_more: false,
      campaign_id: campaignId
    }
    reply(decision(page))
    expect((await client.decision(request)).ok).toBe(true)
    expect(requested().url).toBe(
      'https://console.test/api/gtd/hub/api/adops/instances/adops-omnirogue/decision?section=statistics&offset=0&limit=20&campaign_id=120000001'
    )
    for (const pagination of [
      { ...page, campaign_id: '120000002' },
      { ...page, campaign_id: null },
      undefined
    ]) {
      reply(decision(pagination))
      expect(await client.decision(request)).toMatchObject({
        ok: false,
        error: { code: 'invalid_response' }
      })
    }
  })

  it.each(['1234', '1'.repeat(31), '../120000001', '120000001&company=betacorp'])(
    'refuses an invalid native campaign filter before fetching: %s',
    async (campaignId) => {
      expect(
        await client.decision({
          instanceId: 'adops-omnirogue',
          section: 'statistics',
          offset: 0,
          limit: 20,
          campaignId
        })
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } })
      expect(fetchMock).not.toHaveBeenCalled()
    }
  )

  it('refuses a limit above the contract maximum before any request is made', async () => {
    const result = await client.decision({
      instanceId: 'omnirogue-omnirogue-ad-monitor',
      section: 'decisions',
      offset: 0,
      limit: 500 as never
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('invalid_request')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses every read when nobody is signed in', async () => {
    reply({ detail: 'Sign in to OmniOS.' }, 401)
    const result = await client.adOps()
    expect(!result.ok && result.error.code).toBe('signed_in_required')
  })

  it('says a capability is unavailable rather than empty when the route is not served', async () => {
    reply({}, 404)
    const result = await client.webinar({ window: 'today' })
    expect(!result.ok && result.error.code).toBe('capability_unavailable')
  })

  it('refuses the answer when the signed-in person changed under the request', async () => {
    reply(adsReport())
    // Why: a report fetched as one person must never paint for another.
    current.mockReturnValue(false)
    const result = await client.salesAds({
      company: 'omnirogue',
      rangeDays: 1,
      level: 'campaign',
      state: 'all'
    })
    expect(!result.ok && result.error.code).toBe('connection_changed')
  })

  it('says the backoffice is unreachable rather than reporting a day with no spend', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED https://console.test/secret?token=abc'))
    const result = await client.salesAds({
      company: 'omnirogue',
      rangeDays: 1,
      level: 'campaign',
      state: 'all'
    })
    expect(!result.ok && result.error.code).toBe('backoffice_unavailable')
    // The message must not carry the URL or the credential the exception held.
    expect(!result.ok && result.error.message).not.toContain('token')
  })

  it('refuses a window the Sales relay does not serve, before any request is made', async () => {
    const result = await client.salesAds({
      company: 'omnirogue',
      rangeDays: 14 as never,
      level: 'campaign',
      state: 'all'
    })
    expect(!result.ok && result.error.code).toBe('invalid_request')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('counts a shared campaign budget once, because each provider object appears once', async () => {
    // Two ad sets under one campaign carry the campaign's budget; the campaign
    // level is read separately so the allowance is never added twice.
    reply(
      adsReport({
        rows: [
          adRow({ level: 'adset', id: 'a1', platform_id: 'as1', daily_budget: 50 }),
          adRow({ level: 'adset', id: 'a2', platform_id: 'as2', daily_budget: 50 })
        ]
      })
    )
    const result = await client.salesAds({
      company: 'omnirogue',
      rangeDays: 1,
      level: 'adset',
      state: 'all'
    })
    expect(result.ok && result.data.rows).toHaveLength(2)
    expect(result.ok && result.data.rows.every((row) => row.daily_budget === 50)).toBe(true)
  })

  it('relays the console refusal the web app would get, rather than inventing an empty report', async () => {
    reply(
      { detail: 'Sign in with an approved employee account.', tag: 'sales-identity-required' },
      403
    )
    const result = await client.salesAds({
      company: 'omnirogue',
      rangeDays: 1,
      level: 'campaign',
      state: 'all'
    })
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.code).toBe('sales-identity-required')
    expect(!result.ok && result.error.status).toBe(403)
  })
})
