import { describe, expect, it } from 'vitest'
import {
  buildProviderAccountCapacity,
  type AccountCapacityFacts
} from './provider-account-capacity-builder'
import type { ProviderRateLimits } from './rate-limit-types'

const now = 10_000
const reading = (overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits => ({
  provider: 'claude',
  session: { usedPercent: 20, windowMinutes: 300, resetsAt: now + 1000, resetDescription: null },
  weekly: null,
  status: 'ok',
  error: null,
  updatedAt: now - 100,
  ...overrides
})
const facts: AccountCapacityFacts[] = [
  {
    accountId: 'a',
    email: 'a@example.com',
    launchEnv: { CLAUDE_CONFIG_DIR: '/a' },
    reading: reading()
  },
  { accountId: 'b', email: 'b@example.com', launchEnv: null },
  { accountId: null, email: 'system@example.com', launchEnv: { CLAUDE_CONFIG_DIR: '/system' } }
]

describe('provider capacity', () => {
  it('includes managed and System rows with one default and source environment', () => {
    const rows = buildProviderAccountCapacity('claude', facts, 'a', now)
    expect(rows.map((row) => [row.choiceId, row.state, row.isDefault])).toEqual([
      ['managed:a', 'ready', true],
      ['managed:b', 'signed-out', false],
      ['system', 'usable', false]
    ])
    expect(rows[0].fiveHour?.remainingPercent).toBe(80)
    expect(rows[0].launchEnv).toEqual({ CLAUDE_CONFIG_DIR: '/a' })
    expect(buildProviderAccountCapacity('claude', facts, null, now)[2].isDefault).toBe(true)
  })
  it('keeps last-known exhausted quota limited while a usage read is throttled', () => {
    const row = buildProviderAccountCapacity(
      'claude',
      [
        {
          ...facts[0],
          reading: reading({
            status: 'error',
            session: {
              usedPercent: 100,
              windowMinutes: 300,
              resetsAt: now + 1000,
              resetDescription: null
            },
            usageMetadata: { failureKind: 'rate-limited', retryAtMs: now + 500 }
          })
        }
      ],
      'a',
      now
    )[0]
    expect(row.state).toBe('limited')
    expect(row.limitedUntil).toBe(now + 1000)
    expect(row.readingPausedUntil).toBe(now + 500)
  })
  it('does not treat a throttled read or Fable-only exhaustion as exhausted account quota', () => {
    const row = buildProviderAccountCapacity(
      'claude',
      [
        {
          ...facts[0],
          reading: reading({
            status: 'error',
            fableWeekly: {
              usedPercent: 100,
              windowMinutes: 10080,
              resetsAt: now + 1000,
              resetDescription: null
            },
            usageMetadata: { failureKind: 'rate-limited', retryAtMs: now + 500 }
          })
        }
      ],
      'a',
      now
    )[0]
    expect(row.state).toBe('usable')
    expect(row.fiveHour?.remainingPercent).toBe(80)
    expect(row.limitedUntil).toBeNull()
  })
  it('leaves the absent Codex Pro five-hour window null and identifies revoked tokens', () => {
    const pro = {
      ...facts[0],
      reading: reading({
        provider: 'codex',
        session: null,
        weekly: {
          usedPercent: 40,
          windowMinutes: 10080,
          resetsAt: now + 1000,
          resetDescription: null
        }
      })
    }
    expect(buildProviderAccountCapacity('codex', [pro], 'a', now)[0].fiveHour).toBeNull()
    pro.reading.error = 'token_revoked'
    const row = buildProviderAccountCapacity('codex', [pro], 'a', now)[0]
    expect(row.signedOutReason).toBe('revoked')
    expect(row.launchEnv).toBeNull()
  })
})

describe('capacity reading recovery', () => {
  it.each(['auth', 'token_revoked', 'Access token could not be refreshed', 'Sign in with ChatGPT'])(
    'blocks launch for %s',
    (error) => {
      const [row] = buildProviderAccountCapacity(
        'codex',
        [{ ...facts[0], reading: reading({ error }) }],
        'a',
        now
      )
      expect(row.state).toBe('signed-out')
      expect(row.launchEnv).toBeNull()
    }
  )
  it('normalizes expired windows while retaining the reading timestamp', () => {
    const [row] = buildProviderAccountCapacity(
      'claude',
      [
        {
          ...facts[0],
          reading: reading({
            session: { usedPercent: 100, resetsAt: now, windowMinutes: 300, resetDescription: null }
          })
        }
      ],
      'a',
      now
    )
    expect(row.fiveHour).toEqual({ remainingPercent: 100, resetsAt: null, windowMinutes: 300 })
    expect(row.readingAt).toBe(now - 100)
  })
  it('shows live usage as ready without discarding the OAuth retry gate', () => {
    const [row] = buildProviderAccountCapacity(
      'claude',
      [
        {
          ...facts[0],
          reading: reading({
            usageMetadata: { source: 'live-session', retryAtMs: now + 1000 }
          })
        }
      ],
      'a',
      now
    )
    expect(row.state).toBe('ready')
    expect(row.readingPausedUntil).toBeNull()
  })
})

it.each([0, 1, 3, undefined, -1, 1.5, Number.NaN])(
  'preserves only reported valid Codex reset counts: %s',
  (count) => {
    const fact = {
      ...facts[0],
      reading: reading({
        provider: 'codex',
        rateLimitResetCredits: count === undefined ? undefined : { availableCount: count }
      })
    }
    const row = buildProviderAccountCapacity('codex', [fact], 'a', now)[0]
    expect(row.availableResetCredits).toBe(
      count !== undefined && Number.isSafeInteger(count) && count >= 0 ? count : null
    )
    expect(
      buildProviderAccountCapacity('claude', [fact], 'a', now)[0].availableResetCredits
    ).toBeNull()
  }
)
