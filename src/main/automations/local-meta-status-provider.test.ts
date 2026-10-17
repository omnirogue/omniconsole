import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  localAdvertisingActionPreview,
  localAdvertisingActionReceipt
} from '../../shared/advertising-action-provider-contract'
import { authorizeLocalMetaAction } from './local-meta-action-authority'
import { META_IDS } from './local-meta-fixtures'
import {
  localStatusFixture,
  mockLocalStatusAuthority,
  submittedLocalBinding
} from './local-meta-status-fixtures'
import { executeLocalStatus, prepareLocalStatusPreview } from './local-meta-status-provider'
import { localPreviewRevision } from './local-meta-status-binding'

vi.mock('./local-meta-action-authority', () => ({ authorizeLocalMetaAction: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  mockLocalStatusAuthority()
})

describe('human-approved local native status provider', () => {
  it.each([
    ['adset', 'PAUSE'],
    ['ad', 'PAUSE'],
    ['adset', 'TURN_ON'],
    ['ad', 'TURN_ON']
  ] as const)('executes %s %s once and verifies an independent native read', async (type, kind) => {
    const value = await localStatusFixture(type, kind)
    const { context, fetch, options } = value
    const preview = await prepareLocalStatusPreview(context, options)
    expect(localAdvertisingActionPreview.safeParse(preview).success).toBe(true)
    expect(preview).toMatchObject({
      provider: 'local.meta.graph',
      protocol_version: 'local-human-action.v1',
      principal: context.envelope.principal,
      routine_id: context.envelope.routineId,
      run_id: context.envelope.runId,
      decision_id: context.decision.id,
      source_revision: context.envelope.sourceRevision,
      authority_revision: 'a'.repeat(64),
      target: { type, id: META_IDS[type] },
      transition: {
        field: 'status',
        from: kind === 'PAUSE' ? 'active' : 'paused',
        to: kind === 'PAUSE' ? 'paused' : 'active'
      },
      parameters: {},
      risk: { requires_confirmation: true },
      undo: { requires_new_approval: true },
      financial_impact: { profit_effect: 'unproven', daily_budget_ceiling: 50 }
    })
    expect(value.posts()).toHaveLength(0)
    const receipt = await executeLocalStatus(context, submittedLocalBinding(preview), options)
    expect(localAdvertisingActionReceipt.safeParse(receipt).success).toBe(true)
    expect(receipt).toMatchObject({
      status: 'verified',
      execution: {
        outcome: { accepted: true },
        verification: {
          status: 'verified',
          claim: 'target_state_observed',
          causality: 'unproven',
          observed: { objectId: META_IDS[type], status: context.decision.parameters.status }
        }
      }
    })
    expect(value.posts()).toHaveLength(1)
    const [input, request] = value.posts()[0]
    expect(String(input)).toBe(`https://graph.facebook.com/v21.0/${META_IDS[type]}`)
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' })
    expect(Object.fromEntries(new URLSearchParams(String(request?.body)))).toEqual({
      status: context.decision.parameters.status
    })
    const postIndex = fetch.mock.calls.findIndex(([, init]) => init?.method === 'POST')
    const readbacks = fetch.mock.calls.slice(postIndex + 1)
    expect(readbacks.length).toBeGreaterThanOrEqual(type === 'ad' ? 8 : 6)
    expect(readbacks.every(([, init]) => init?.method === 'GET')).toBe(true)
  })

  it.each([
    'from-state',
    'effective-status',
    'ancestor-status',
    'ancestor-effective-status',
    'daily-budget',
    'lifetime-budget',
    'budget-owner',
    'currency',
    'account',
    'campaign',
    'adset'
  ])('refuses changed %s before any native write', async (change) => {
    const value = await localStatusFixture('ad')
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    const { fixture } = value
    if (change === 'from-state') {
      fixture.ad.status = 'PAUSED'
    }
    if (change === 'effective-status') {
      fixture.ad.effective_status = 'WITH_ISSUES'
    }
    if (change === 'ancestor-status') {
      fixture.campaign.status = 'PAUSED'
    }
    if (change === 'ancestor-effective-status') {
      fixture.adset.effective_status = 'CAMPAIGN_PAUSED'
    }
    if (change === 'daily-budget') {
      fixture.adset.daily_budget = '6000'
    }
    if (change === 'lifetime-budget') {
      fixture.adset.lifetime_budget = '50000'
    }
    if (change === 'budget-owner') {
      fixture.campaign.daily_budget = '5000'
      fixture.adset.daily_budget = '0'
    }
    if (change === 'currency') {
      fixture.account.currency = 'JPY'
    }
    if (change === 'account') {
      fixture.ad.account_id = '1903710316835413'
    }
    if (change === 'campaign') {
      fixture.ad.campaign_id = '120000000000009'
    }
    if (change === 'adset') {
      fixture.ad.adset_id = '120000000000008'
    }
    await expect(
      executeLocalStatus(value.context, submittedLocalBinding(preview), value.options)
    ).rejects.toThrow()
    expect(value.posts()).toHaveLength(0)
  })

  it('does not treat names or provider timestamps as native control versions', async () => {
    const value = await localStatusFixture()
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    for (const key of ['campaign', 'adset'] as const) {
      value.fixture[key].name = 'Renamed after approval'
      value.fixture[key].updated_time = '2026-09-20T16:00:01+0000'
    }
    await expect(
      executeLocalStatus(value.context, submittedLocalBinding(preview), value.options)
    ).resolves.toMatchObject({ status: 'verified' })
    expect(value.posts()).toHaveLength(1)
  })

  it('refuses a no-op proposal instead of presenting a reversible mutation', async () => {
    const value = await localStatusFixture()
    value.context.decision.kind = 'TURN_ON'
    value.context.decision.parameters.status = 'ACTIVE'
    await expect(prepareLocalStatusPreview(value.context, value.options)).rejects.toThrow()
    expect(value.posts()).toHaveLength(0)
  })

  it('requires the durable submitted fence before sending', async () => {
    const value = await localStatusFixture()
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    const binding = { ...submittedLocalBinding(preview), submitted: false }
    await expect(executeLocalStatus(value.context, binding, value.options)).rejects.toThrow()
    expect(value.posts()).toHaveLength(0)
  })

  it('refuses a replaced local authority revision after preview', async () => {
    const value = await localStatusFixture()
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    const authority = mockLocalStatusAuthority()
    authority.revision = 'b'.repeat(64)
    vi.mocked(authorizeLocalMetaAction).mockResolvedValue(authority)
    await expect(
      executeLocalStatus(value.context, submittedLocalBinding(preview), value.options)
    ).rejects.toThrow()
    expect(value.posts()).toHaveLength(0)
  })

  it.each([undefined, 'not-a-date', '2026-09-20T16:00:00+00:00'])(
    'refuses a missing or noncanonical journal timestamp %s',
    async (submittedAt) => {
      const value = await localStatusFixture()
      const preview = await prepareLocalStatusPreview(value.context, value.options)
      const binding = { ...submittedLocalBinding(preview), submittedAt }
      await expect(executeLocalStatus(value.context, binding, value.options)).rejects.toThrow()
      expect(value.posts()).toHaveLength(0)
    }
  )

  it.each([
    'principal',
    'routine_id',
    'run_id',
    'decision_id',
    'source_revision',
    'expected_version'
  ] as const)('rejects a syntactically valid preview with a different %s', async (field) => {
    const value = await localStatusFixture()
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    preview[field] = 'b'.repeat(64)
    preview.revision = localPreviewRevision(preview)
    value.fetch.mockClear()
    await expect(
      executeLocalStatus(value.context, submittedLocalBinding(preview), value.options)
    ).rejects.toThrow()
    expect(value.fetch).not.toHaveBeenCalled()
  })

  it('refuses a retargeted owner scope before native reads', async () => {
    const value = await localStatusFixture()
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    value.context.scope.target = { ...value.context.scope.target, nativeId: '120000000000009' }
    value.fetch.mockClear()
    await expect(
      executeLocalStatus(value.context, submittedLocalBinding(preview), value.options)
    ).rejects.toThrow()
    expect(value.fetch).not.toHaveBeenCalled()
  })

  it.each(['kill switch', 'owner changed'])(
    'rechecks %s during the pre-send read',
    async (reason) => {
      const value = await localStatusFixture()
      const preview = await prepareLocalStatusPreview(value.context, value.options)
      let current = true
      value.context.assertCurrent = async () => {
        if (!current) {
          throw new Error(reason)
        }
      }
      value.behavior.onGet = () => {
        current = false
      }
      await expect(
        executeLocalStatus(value.context, submittedLocalBinding(preview), value.options)
      ).rejects.toThrow()
      expect(value.posts()).toHaveLength(0)
    }
  )

  it('refuses malformed native reads without sending', async () => {
    const value = await localStatusFixture()
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    value.behavior.malformedRead = true
    await expect(
      executeLocalStatus(value.context, submittedLocalBinding(preview), value.options)
    ).rejects.toThrow()
    expect(value.posts()).toHaveLength(0)
  })
})
