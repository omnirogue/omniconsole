import { describe, expect, it, vi } from 'vitest'
import type { ArtifactReviewSleep } from '../../shared/artifact-review-sleep'
import type { AccountCapacityRow } from '../../shared/provider-account-capacity'
import { reviewWakeCapacity } from './artifact-review-wake-runtime'

const SLEEP: ArtifactReviewSleep = {
  state: 'asleep',
  revision: 1,
  armedAt: 1,
  at: 1,
  provider: 'claude',
  accountHome: '/acc/one',
  model: 'opus'
}

function runtime(row: Partial<AccountCapacityRow> | null) {
  return {
    getAccountsSnapshot: () =>
      ({
        rateLimits: {
          accountCapacity: {
            claude: row
              ? [
                  {
                    provider: 'claude',
                    email: 'a@b.c',
                    state: 'ready',
                    launchEnv: { CLAUDE_CONFIG_DIR: '/acc/one' },
                    fiveHour: { remainingPercent: 50, resetsAt: null, windowMinutes: 300 },
                    weekly: { remainingPercent: 50, resetsAt: null, windowMinutes: 10080 },
                    readingAt: 1_000,
                    limitedUntil: null,
                    ...row
                  }
                ]
              : [],
            codex: []
          }
        }
      }) as never,
    refreshAccountsForMobileSubscriber: vi.fn(async () => {})
  }
}

describe('review wake capacity', () => {
  it('lets a fresh account wake, and an unknown home through unchecked', () => {
    expect(reviewWakeCapacity(runtime({}), new Map(), SLEEP, 2_000)).toEqual({ ok: true })
    expect(reviewWakeCapacity(runtime(null), new Map(), SLEEP, 2_000)).toEqual({ ok: true })
  })

  it('holds a limited account until its reset, never another account', () => {
    const verdict = reviewWakeCapacity(
      runtime({ state: 'limited', limitedUntil: 9_000_000 }),
      new Map(),
      SLEEP,
      2_000
    )
    expect(verdict).toMatchObject({ ok: false, retryAfter: 9_000_000 })
    expect(verdict.ok ? '' : verdict.reason).toContain('capacity: waiting for a@b.c')
  })

  it('refreshes a stale reading and goes after a grace', () => {
    const host = runtime({ readingAt: 1 })
    const stale = new Map<string, number>()
    expect(reviewWakeCapacity(host, stale, SLEEP, 100_000).ok).toBe(false)
    expect(host.refreshAccountsForMobileSubscriber).toHaveBeenCalled()
    expect(reviewWakeCapacity(host, stale, SLEEP, 100_000 + 6 * 60_000).ok).toBe(true)
  })
})
