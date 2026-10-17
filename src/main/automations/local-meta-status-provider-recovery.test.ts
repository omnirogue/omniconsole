import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localAdvertisingActionReceipt } from '../../shared/advertising-action-provider-contract'
import {
  localStatusFixture,
  mockLocalStatusAuthority,
  submittedLocalBinding
} from './local-meta-status-fixtures'
import {
  executeLocalStatus,
  prepareLocalStatusPreview,
  verifyLocalStatus
} from './local-meta-status-provider'
import * as localStatusTransport from './local-meta-status-transport'

vi.mock('./local-meta-action-authority', () => ({ authorizeLocalMetaAction: vi.fn() }))

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  mockLocalStatusAuthority()
})

describe('uncertain local status execution and read-only recovery', () => {
  it('never retries an uncertain POST and does not invent acknowledgement during recovery', async () => {
    const value = await localStatusFixture()
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    const binding = submittedLocalBinding(preview)
    value.behavior.postFailure = true
    await expect(executeLocalStatus(value.context, binding, value.options)).rejects.toThrow()
    expect(value.posts()).toHaveLength(1)
    expect(binding).toMatchObject({ submitted: true, receipt: null })
    value.fixture.adset.status = 'PAUSED'
    value.fixture.adset.effective_status = 'PAUSED'

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const receipt = await verifyLocalStatus(value.context, binding, value.options)
      expect(localAdvertisingActionReceipt.safeParse(receipt).success).toBe(true)
      expect(receipt).toMatchObject({
        status: 'verified',
        execution: {
          outcome: null,
          dispatched_at: null,
          verification: { claim: 'target_state_observed', causality: 'unproven' }
        }
      })
      expect(value.posts()).toHaveLength(1)
    }
  })

  it('fails execution after expiry but still permits read-only recovery', async () => {
    const value = await localStatusFixture()
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    const binding = submittedLocalBinding(preview)
    value.setTime(Date.parse(preview.expires_at) + 1)
    await expect(executeLocalStatus(value.context, binding, value.options)).rejects.toThrow()
    expect(value.posts()).toHaveLength(0)
    value.fixture.adset.status = 'PAUSED'
    value.fixture.adset.effective_status = 'PAUSED'
    await expect(verifyLocalStatus(value.context, binding, value.options)).resolves.toMatchObject({
      status: 'verified',
      execution: { outcome: null, dispatched_at: null }
    })
    expect(value.posts()).toHaveLength(0)
  })

  it('does not treat a successful POST as verification when native status disagrees', async () => {
    const value = await localStatusFixture()
    value.behavior.applyStatus = false
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    const receipt = await executeLocalStatus(
      value.context,
      submittedLocalBinding(preview),
      value.options
    )
    expect(localAdvertisingActionReceipt.safeParse(receipt).success).toBe(true)
    expect(receipt).toMatchObject({
      status: 'unverified',
      execution: { outcome: { accepted: true }, verification: { status: 'mismatch' } }
    })
    expect(value.posts()).toHaveLength(1)
  })

  it('fences expiry during the final asynchronous check immediately before POST', async () => {
    const value = await localStatusFixture()
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    value.setTime(Date.parse(preview.expires_at) - 1000)
    const original = localStatusTransport.createLocalMetaStatusWriter
    const fence = vi.fn(async () => value.setTime(Date.parse(preview.expires_at) + 1))
    vi.spyOn(localStatusTransport, 'createLocalMetaStatusWriter').mockImplementationOnce(
      (identity, options) =>
        original(
          {
            ...identity,
            assertCurrent: async () => {
              await identity.assertCurrent()
              await fence()
            }
          },
          options
        )
    )
    await expect(
      executeLocalStatus(value.context, submittedLocalBinding(preview), value.options)
    ).rejects.toThrow()
    expect(fence).toHaveBeenCalledOnce()
    expect(value.posts()).toHaveLength(0)
  })

  it.each(['ancestor status', 'ancestor budget', 'currency'])(
    'keeps a changed %s unverified even when selected status matches',
    async (change) => {
      const value = await localStatusFixture('ad')
      const preview = await prepareLocalStatusPreview(value.context, value.options)
      value.behavior.afterPost = () => {
        if (change === 'ancestor status') {
          value.fixture.campaign.status = 'PAUSED'
        }
        if (change === 'ancestor budget') {
          value.fixture.adset.daily_budget = '6000'
        }
        if (change === 'currency') {
          value.fixture.account.currency = 'JPY'
        }
      }
      const receipt = await executeLocalStatus(
        value.context,
        submittedLocalBinding(preview),
        value.options
      )
      expect(receipt).toMatchObject({
        status: 'unverified',
        execution: { verification: { status: 'mismatch' } }
      })
      expect(value.posts()).toHaveLength(1)
    }
  )

  it('distinguishes configured ACTIVE from effective delivery or causal proof', async () => {
    const value = await localStatusFixture('ad', 'TURN_ON')
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    value.behavior.afterPost = () => {
      value.fixture.ad.effective_status = 'WITH_ISSUES'
    }
    const receipt = await executeLocalStatus(
      value.context,
      submittedLocalBinding(preview),
      value.options
    )
    expect(receipt).toMatchObject({
      status: 'verified',
      execution: {
        verification: {
          claim: 'target_state_observed',
          causality: 'unproven',
          observed: { status: 'ACTIVE', effectiveStatus: 'WITH_ISSUES' }
        }
      }
    })
    expect(value.posts()).toHaveLength(1)
  })

  it('leaves malformed readback unresolved and never repeats the native write', async () => {
    const value = await localStatusFixture()
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    const binding = submittedLocalBinding(preview)
    value.behavior.afterPost = () => {
      value.behavior.malformedRead = true
    }
    await expect(executeLocalStatus(value.context, binding, value.options)).rejects.toThrow()
    expect(value.posts()).toHaveLength(1)
    await expect(verifyLocalStatus(value.context, binding, value.options)).rejects.toThrow()
    expect(value.posts()).toHaveLength(1)
    value.behavior.malformedRead = false
    await expect(verifyLocalStatus(value.context, binding, value.options)).resolves.toMatchObject({
      status: 'verified'
    })
    expect(value.posts()).toHaveLength(1)
  })

  it('does not read or write after owner authority is revoked during recovery', async () => {
    const value = await localStatusFixture()
    const preview = await prepareLocalStatusPreview(value.context, value.options)
    value.fetch.mockClear()
    value.context.assertCurrent = async () => {
      throw new Error('Owner changed')
    }
    await expect(
      verifyLocalStatus(value.context, submittedLocalBinding(preview), value.options)
    ).rejects.toThrow()
    expect(value.fetch).not.toHaveBeenCalled()
  })
})
