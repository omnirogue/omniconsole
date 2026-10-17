import { vi } from 'vitest'
import type { AdvertisingTarget } from '../../shared/typesafe-advertising'

export const META_NOW = Date.parse('2026-09-20T16:00:00.000Z')
export const META_ACCOUNT_ID = 'act_1000000000000001'
export const META_IDS = {
  campaign: '120000000000001',
  adset: '120000000000002',
  ad: '120000000000003'
} as const

export function metaTarget(objectType: 'ad' | 'adset' = 'adset'): AdvertisingTarget {
  return {
    company: 'omnirogue',
    accountId: META_ACCOUNT_ID,
    objectType,
    nativeId: META_IDS[objectType],
    campaignId: META_IDS.campaign,
    adsetId: META_IDS.adset
  }
}

type Fixture = Record<'account' | 'campaign' | 'adset' | 'ad' | 'insight', Record<string, unknown>>
type Context = { path: string; visit: number; url: URL }

export function metaFixture(): Fixture {
  const base = {
    account_id: META_ACCOUNT_ID.slice(4),
    status: 'ACTIVE',
    effective_status: 'ACTIVE',
    updated_time: '2026-09-20T15:00:00+0000'
  }
  return {
    account: {
      id: META_ACCOUNT_ID,
      account_id: META_ACCOUNT_ID.slice(4),
      currency: 'USD',
      timezone_name: 'America/Panama'
    },
    campaign: { ...base, id: META_IDS.campaign, name: 'Campaign', daily_budget: '0' },
    adset: {
      ...base,
      id: META_IDS.adset,
      campaign_id: META_IDS.campaign,
      name: 'Observed ad set',
      daily_budget: '5000'
    },
    ad: {
      ...base,
      id: META_IDS.ad,
      campaign_id: META_IDS.campaign,
      adset_id: META_IDS.adset,
      name: 'Observed ad'
    },
    insight: {
      account_id: META_ACCOUNT_ID.slice(4),
      campaign_id: META_IDS.campaign,
      adset_id: META_IDS.adset,
      date_start: '2026-09-20',
      date_stop: '2026-09-20',
      spend: '25',
      impressions: '1000',
      inline_link_clicks: '10',
      actions: [
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' },
        { action_type: 'offsite_conversion.fb_pixel_complete_registration', value: '4' },
        { action_type: 'offsite_conversion.fb_pixel_lead', value: '3' },
        { action_type: 'offsite_conversion.fb_pixel_add_to_cart', value: '6' },
        { action_type: 'offsite_conversion.fb_pixel_initiate_checkout', value: '5' },
        { action_type: 'purchase', value: '200' },
        { action_type: 'lead', value: '300' }
      ],
      action_values: [
        { action_type: 'offsite_conversion.fb_pixel_purchase', value: '100' },
        { action_type: 'purchase', value: '10000' }
      ]
    }
  }
}

export function mockMetaFetch(
  fixture = metaFixture(),
  transform?: (body: Record<string, unknown>, context: Context) => unknown,
  responseHeaders: Record<string, string> = {}
) {
  const visits = new Map<string, number>()
  return vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const path = url.pathname.replace(/^\/v21\.0\//, '')
    const visit = (visits.get(path) ?? 0) + 1
    visits.set(path, visit)
    let body: Record<string, unknown>
    if (path === META_ACCOUNT_ID) {
      body = fixture.account
    } else if (path === `${META_IDS.adset}/insights` || path === `${META_IDS.ad}/insights`) {
      const row = { ...fixture.insight }
      if (path === `${META_IDS.ad}/insights`) {
        row.ad_id = META_IDS.ad
      }
      body = { data: [row] }
    } else {
      const type = (Object.keys(META_IDS) as (keyof typeof META_IDS)[]).find(
        (key) => META_IDS[key] === path
      )
      if (!type) {
        throw new Error('Unexpected fixture request path.')
      }
      body = fixture[type]
    }
    const copy = structuredClone(body)
    const value = transform ? transform(copy, { path, visit, url }) : copy
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...responseHeaders }
    })
  })
}
