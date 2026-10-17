import { describe, expect, it } from 'vitest'
import type { AdvertisingTarget } from '../../shared/typesafe-advertising'
import {
  localMetaInsightFields,
  parseLocalMetaMetrics
} from './typesafe-advertising-local-meta-metrics'

const date = '2026-09-20'
const target: AdvertisingTarget = {
  company: 'omnirogue',
  accountId: 'act_1000000000000001',
  objectType: 'adset',
  nativeId: '123456',
  campaignId: '234567',
  adsetId: '123456'
}
const event = (name: string, value: unknown) => ({
  action_type: `offsite_conversion.fb_pixel_${name}`,
  value
})
const row = (overrides: Record<string, unknown> = {}) => ({
  account_id: '1000000000000001',
  campaign_id: '234567',
  adset_id: '123456',
  date_start: date,
  date_stop: date,
  ...overrides
})
const parse = (overrides: Record<string, unknown> = {}) =>
  parseLocalMetaMetrics([row(overrides)], target, date)

describe('strict local Meta metric projection', () => {
  it('requests typed native scope, date, measures and action arrays at the selected level', () => {
    const fields = localMetaInsightFields('adset').split(',')
    expect(fields).toEqual([
      'account_id',
      'campaign_id',
      'adset_id',
      'date_start',
      'date_stop',
      'spend',
      'impressions',
      'inline_link_clicks',
      'actions',
      'action_values'
    ])
    expect(localMetaInsightFields('ad').split(',')).toEqual([
      ...fields.slice(0, 3),
      'ad_id',
      ...fields.slice(3)
    ])
  })

  it('leaves every missing measure unknown, including empty fully paginated results', () => {
    for (const rows of [[], [row()], [row({ spend: null, actions: null })]]) {
      const result = parseLocalMetaMetrics(rows, target, date)
      expect(Object.values(result.metrics).every((value) => value === null)).toBe(true)
      expect(result.leadEvent).toBeNull()
      expect(result.limitations.join(' ')).toContain('unknown')
    }
    expect(parseLocalMetaMetrics([], target, date).limitations.join(' ')).toContain('no today')
  })

  it('projects exact pixel events and derives costs only from explicit numeric values', () => {
    const result = parse({
      spend: '12.50',
      impressions: '1000',
      inline_link_clicks: '5',
      actions: [
        event('purchase', '2'),
        event('complete_registration', '4'),
        event('lead', '3'),
        event('add_to_cart', '6'),
        event('initiate_checkout', '5')
      ],
      action_values: [event('purchase', '25.00')]
    })
    expect(result.metrics).toEqual({
      spend: 12.5,
      revenue: 25,
      purchases: 2,
      registrations: 4,
      leads: 3,
      addToCarts: 6,
      checkouts: 5,
      linkClicks: 5,
      impressions: 1000,
      dailyBudget: null,
      linkCpc: 2.5,
      roas: 2
    })
    expect(result.leadEvent).toBe('offsite_conversion.fb_pixel_lead')
  })

  it('preserves explicit zero without treating absent values or zero denominators as zero', () => {
    const result = parse({
      spend: 0,
      impressions: '0',
      inline_link_clicks: '0',
      actions: [event('purchase', '0'), event('lead', null)],
      action_values: [event('purchase', '0.00')]
    })
    expect(result.metrics).toMatchObject({
      spend: 0,
      revenue: 0,
      purchases: 0,
      leads: null,
      registrations: null,
      impressions: 0,
      linkClicks: 0,
      linkCpc: null,
      roas: null
    })
    expect(parse({ spend: '10', action_values: [event('purchase', '0')] }).metrics.roas).toBe(0)
    expect(parse({ actions: [event('purchase', '0')] }).metrics.revenue).toBeNull()
  })

  it('never sums or chooses aggregate aliases, including ambiguous aggregate leads', () => {
    const aliases = ['purchase', 'omni_purchase', 'lead', 'complete_registration'].map(
      (action_type) => ({ action_type, value: '999' })
    )
    const result = parse({
      actions: [...aliases, event('purchase', '2')],
      action_values: [...aliases, event('purchase', '12')]
    })
    expect(result.metrics.purchases).toBe(2)
    expect(result.metrics.revenue).toBe(12)
    expect(result.metrics.registrations).toBeNull()
    expect(result.metrics.leads).toBeNull()
    expect(result.leadEvent).toBeNull()
    expect(parse({ actions: aliases, action_values: aliases }).metrics.revenue).toBeNull()
  })

  it.each([
    ['empty', ''],
    ['whitespace', ' 1'],
    ['exponent', '1e3'],
    ['hexadecimal', '0x10'],
    ['leading zero', '01'],
    ['negative string', '-1'],
    ['negative number', -1],
    ['infinity', Infinity],
    ['NaN', Number.NaN],
    ['overflow', '9'.repeat(400)],
    ['boolean', true],
    ['object', {}]
  ])('rejects a %s explicit measure', (_label, value) => {
    expect(() => parse({ spend: value })).toThrow('malformed measure')
    expect(() => parse({ actions: [event('purchase', value)] })).toThrow('malformed measure')
    expect(() => parse({ action_values: [event('purchase', value)] })).toThrow('malformed measure')
  })

  it('rejects derived overflow instead of returning a non-finite cost', () => {
    expect(() => parse({ spend: Number.MAX_VALUE, inline_link_clicks: Number.MIN_VALUE })).toThrow(
      'unrepresentable derived measure'
    )
  })

  it.each(['actions', 'action_values'])('rejects duplicate or malformed %s', (field) => {
    for (const value of [
      [event('purchase', '1'), event('purchase', '2')],
      [
        { action_type: 'lead', value: '1' },
        { action_type: 'lead', value: '2' }
      ],
      [{ action_type: '', value: '1' }],
      [{ value: '1' }],
      [null],
      {},
      'purchase 2'
    ]) {
      expect(() => parse({ [field]: value })).toThrow('Local Meta insights')
    }
  })

  it.each([
    { account_id: '999999' },
    { account_id: 'act_1000000000000001' },
    { account_id: undefined },
    { campaign_id: '999999' },
    { adset_id: '999999' },
    { ad_id: '345678' }
  ])('rejects a mismatched or incomplete native hierarchy: %j', (overrides) => {
    expect(() => parse(overrides)).toThrow('exact native target hierarchy')
  })

  it('requires the selected ad itself in addition to every parent', () => {
    const ad: AdvertisingTarget = { ...target, objectType: 'ad', nativeId: '345678' }
    expect(parseLocalMetaMetrics([row({ ad_id: ad.nativeId })], ad, date).metrics.spend).toBeNull()
    for (const overrides of [{}, { ad_id: '456789' }, { ad_id: ad.nativeId, adset_id: '999999' }]) {
      expect(() => parseLocalMetaMetrics([row(overrides)], ad, date)).toThrow('hierarchy')
    }
  })

  it('rejects mismatched dates, invalid selectors and unexpected or duplicate rows', () => {
    for (const overrides of [
      { date_start: '2026-09-19' },
      { date_stop: '2026-09-21' },
      { date_start: undefined }
    ]) {
      expect(() => parse(overrides)).toThrow('account date')
    }
    for (const rows of [[row(), row()], [null], ['Spend 20, purchases 3']]) {
      expect(() => parseLocalMetaMetrics(rows, target, date)).toThrow('Local Meta insights')
    }
    expect(() => parseLocalMetaMetrics([], target, '2026-02-30')).toThrow('valid ad')
    expect(() => parseLocalMetaMetrics([], { ...target, nativeId: '999999' }, date)).toThrow(
      'valid ad'
    )
    expect(() =>
      parseLocalMetaMetrics(
        [],
        { ...target, objectType: 'campaign', nativeId: target.campaignId, adsetId: null },
        date
      )
    ).toThrow('valid ad')
  })
})
