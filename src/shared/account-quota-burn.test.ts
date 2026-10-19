import { describe, expect, it } from 'vitest'
import {
  accountQuotaBurnRisk,
  accountQuotaBurnRiskFromUsage,
  quotaMinutesToExhaustion
} from './account-quota-burn'

const NOW = 1_800_000_000_000
const hour = 60 * 60_000
const day = 24 * hour
const fiveHour = (remainingPercent: number, resetsAt: number | null) => ({
  remainingPercent,
  resetsAt,
  windowMinutes: 300
})
const weekly = (remainingPercent: number, resetsAt: number | null) => ({
  remainingPercent,
  resetsAt,
  windowMinutes: 10080
})

describe('per-account quota burn forecast', () => {
  it('estimates exhaustion from the elapsed part of the 5-hour and weekly windows', () => {
    expect(quotaMinutesToExhaustion(fiveHour(15, NOW + 3 * hour), NOW, NOW)).toBeCloseTo(21.18, 1)
    expect(quotaMinutesToExhaustion(weekly(11, NOW + 6 * day), NOW, NOW)).toBeCloseTo(178, 0)
    expect(quotaMinutesToExhaustion(fiveHour(100, NOW + 3 * hour), NOW, NOW)).toBeNull()
    expect(quotaMinutesToExhaustion(fiveHour(20, null), NOW, NOW)).toBeNull()
  })

  it('flags either window when its burn reaches 429 soon, even above the reserve floor', () => {
    expect(
      accountQuotaBurnRisk(
        { fiveHour: fiveHour(15, NOW + 3 * hour), weekly: weekly(80, NOW + day) },
        NOW,
        NOW
      )?.window
    ).toBe('5-hour')
    expect(
      accountQuotaBurnRisk(
        { fiveHour: fiveHour(80, NOW + hour), weekly: weekly(11, NOW + 6 * day) },
        NOW,
        NOW
      )?.window
    ).toBe('weekly')
  })

  it('keeps a reserve with unknown reset time and ignores a reset due before projected exhaustion', () => {
    expect(accountQuotaBurnRisk({ fiveHour: fiveHour(9, null), weekly: null }, NOW, NOW)).toEqual({
      window: '5-hour',
      reason: 'low-reserve',
      minutesToExhaustion: null
    })
    expect(
      accountQuotaBurnRisk({ fiveHour: fiveHour(15, NOW + 10 * 60_000), weekly: null }, NOW, NOW)
    ).toBeNull()
    expect(
      accountQuotaBurnRisk({ fiveHour: fiveHour(5, NOW - 1), weekly: null }, NOW, NOW)
    ).toBeNull()
  })

  it('does not forecast from old or failed raw readings', () => {
    const usage = {
      provider: 'codex' as const,
      status: 'ok' as const,
      error: null,
      updatedAt: NOW,
      session: {
        usedPercent: 85,
        resetsAt: NOW + 3 * hour,
        windowMinutes: 300,
        resetDescription: null
      },
      weekly: null
    }
    expect(accountQuotaBurnRiskFromUsage(usage, NOW)?.window).toBe('5-hour')
    expect(accountQuotaBurnRiskFromUsage({ ...usage, updatedAt: NOW - 300_001 }, NOW)).toBeNull()
    expect(accountQuotaBurnRiskFromUsage({ ...usage, status: 'error' }, NOW)).toBeNull()
  })
})
