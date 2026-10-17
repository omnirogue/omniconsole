import { describe, expect, it } from 'vitest'
import {
  fleetAccountUsageReceiptSchema,
  sanitizeFleetAccountUsage,
  selectedAccountUsageRequestSchema,
  type FleetAccountUsageReceipt
} from './fleet-account-usage'
import type { ProviderRateLimits } from './rate-limit-types'

const observedAt = 1_789_225_000_000
function usage(): ProviderRateLimits {
  return {
    provider: 'codex',
    status: 'ok',
    updatedAt: observedAt,
    error: null,
    session: {
      usedPercent: 12.5,
      windowMinutes: 300,
      resetsAt: observedAt + 300_000,
      resetDescription: null
    },
    weekly: null
  }
}
function receipt(): FleetAccountUsageReceipt {
  return {
    version: 1,
    selected_account_ref: '11111111-1111-4111-8111-111111111111',
    account_generation: '22222222-2222-4222-8222-222222222222',
    usage: sanitizeFleetAccountUsage(usage(), 'codex') as NonNullable<
      FleetAccountUsageReceipt['usage']
    >
  }
}

describe('selected fleet account usage contract', () => {
  it('preserves exact live observation and quota values while removing account metadata', () => {
    const raw = usage()
    raw.planType = 'private-plan'
    raw.rateLimitResetCredits = { availableCount: 7 }
    raw.session!.resetDescription = 'Private response text'
    raw.usageMetadata = {
      source: 'oauth',
      credentialSource: '/private/account',
      authProvenance: 'person@example.com',
      attemptedSources: ['oauth'],
      retryAtMs: observedAt + 60_000
    }
    const sanitized = sanitizeFleetAccountUsage(raw, 'codex')
    expect(sanitized).toEqual({
      ...usage(),
      usageMetadata: { source: 'oauth', retryAtMs: observedAt + 60_000 }
    })
    expect(JSON.stringify(sanitized)).not.toMatch(/private|example\.com|Credits/)
    expect(
      fleetAccountUsageReceiptSchema.parse({ ...receipt(), usage: sanitized }).usage?.updatedAt
    ).toBe(observedAt)
  })

  it('keeps unknown usage explicit without inferring zero quota', () => {
    expect(fleetAccountUsageReceiptSchema.parse({ ...receipt(), usage: null }).usage).toBeNull()
    expect(
      sanitizeFleetAccountUsage(
        { ...usage(), status: 'error', error: 'token private detail' },
        'codex'
      )
    ).toMatchObject({
      status: 'unavailable',
      error: 'usage-unavailable',
      session: null,
      weekly: null
    })
  })

  it('refuses a provider mismatch and malformed successful quota without retaining success', () => {
    expect(sanitizeFleetAccountUsage(usage(), 'claude').status).toBe('unavailable')
    expect(
      sanitizeFleetAccountUsage({ ...usage(), error: 'contradictory failure' }, 'codex').status
    ).toBe('unavailable')
    const malformed = usage()
    malformed.session!.usedPercent = Number.NaN
    expect(sanitizeFleetAccountUsage(malformed, 'codex').status).toBe('unavailable')
  })

  it.each([
    (value: Record<string, unknown>) => {
      value.selected_account_ref = '/home/private'
    },
    (value: Record<string, unknown>) => {
      value.account_generation = '11111111-1111-1111-8111-111111111111'
    },
    (value: Record<string, unknown>) => {
      value.email = 'private@example.com'
    },
    (value: Record<string, unknown>) => {
      value.usage = { ...usage(), planType: 'private' }
    },
    (value: Record<string, unknown>) => {
      value.usage = { ...usage(), usageMetadata: { authProvenance: 'private' } }
    },
    (value: Record<string, unknown>) => {
      value.usage = { ...usage(), error: 'provider raw response' }
    },
    (value: Record<string, unknown>) => {
      value.usage = { ...usage(), session: { ...usage().session, windowMinutes: 525_601 } }
    },
    (value: Record<string, unknown>) => {
      value.usage = { ...usage(), buckets: [{ ...usage().session, name: '../private' }] }
    }
  ])('rejects invalid or private public receipt fields (%#)', (mutate) => {
    const value: Record<string, unknown> = receipt()
    mutate(value)
    expect(fleetAccountUsageReceiptSchema.safeParse(value).success).toBe(false)
  })

  it('requires exact selected credentials and rejects ambient account request fields', () => {
    expect(
      selectedAccountUsageRequestSchema.parse({
        version: 1,
        provider: 'codex',
        configRoot: '/selected/codex'
      })
    ).toEqual({
      version: 1,
      provider: 'codex',
      configRoot: '/selected/codex'
    })
    for (const invalid of [
      { version: 1, provider: 'codex' },
      { version: 1, provider: 'codex', configRoot: 'relative' },
      { version: 1, provider: 'codex', configRoot: '/selected', accountId: 'ambient' },
      { version: 1, provider: 'claude', configRoot: '/selected', token: '' },
      { version: 1, provider: 'kimi', baseUrl: 'https://api.kimi.com/coding/v1' }
    ]) {
      expect(selectedAccountUsageRequestSchema.safeParse(invalid).success).toBe(false)
    }
  })
})
