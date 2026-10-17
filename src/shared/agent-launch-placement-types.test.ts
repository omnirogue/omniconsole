import { describe, expect, it } from 'vitest'
import { chooseVerifiedLaunchAccount } from './account-launch-verdict'
import { agentLaunchLoadFromReading, type AgentLaunchAccountReceipt } from './agent-launch-account'
import {
  launchCapacityFromChoice,
  launchCapacityFromReadiness,
  launchWorktreeClientMutationId
} from './agent-launch-placement-types'
import type { HostResourceReading } from './host-resource-model'
import type { AccountCapacityRow } from './provider-account-capacity'

const NOW = 1_800_000_000_000

function row(change: Partial<AccountCapacityRow> = {}): AccountCapacityRow {
  return {
    provider: 'claude',
    accountId: 'a',
    choiceId: 'managed:a',
    email: 'a@example.com',
    detail: null,
    isDefault: false,
    isSystem: false,
    fiveHour: { remainingPercent: 80, resetsAt: NOW + 3_600_000, windowMinutes: 300 },
    weekly: { remainingPercent: 60, resetsAt: NOW + 86_400_000, windowMinutes: 10080 },
    fableWeekly: null,
    state: 'ready',
    signedOutReason: null,
    limitedUntil: null,
    readingAt: NOW - 10_000,
    readingPausedUntil: null,
    sourceLabel: null,
    launchEnv: { CLAUDE_CONFIG_DIR: '/home/.claude-a' },
    ...change
  }
}

function reading(change: Partial<HostResourceReading> = {}): HostResourceReading {
  return {
    hostKey: 'local',
    state: 'ok',
    readAt: NOW - 2_000,
    memory: { totalMemory: 16, availableMemory: 8, cpuCoreCount: 10, loadAverage1m: 4 },
    liveSessions: 3,
    ...change
  }
}

const receipt: AgentLaunchAccountReceipt = {
  policy: 'best-verified',
  hostId: 'local',
  provider: 'claude',
  label: 'b@example.com',
  choiceId: 'managed:b',
  remainingPercent: 72,
  boundBy: 'weekly',
  readingAt: NOW - 5_000,
  readingAgeMs: 5_000,
  fableVerified: false,
  verified: 2,
  considered: 3,
  excluded: [],
  why: 'most fresh verified headroom'
}

describe('agentLaunchLoadFromReading', () => {
  it('bands a timed reading with its live sessions', () => {
    expect(agentLaunchLoadFromReading(reading(), NOW)).toEqual({
      freeBytes: 8,
      totalBytes: 16,
      loadPerCore: 0.4,
      band: 'ok',
      liveSessions: 3,
      observedAt: NOW - 2_000
    })
    expect(
      agentLaunchLoadFromReading(
        reading({ memory: { ...reading().memory!, loadAverage1m: 9 } }),
        NOW
      )?.band
    ).toBe('hot')
  })

  it('is null, never idle, without an answered and timed reading', () => {
    expect(agentLaunchLoadFromReading(null, NOW)).toBeNull()
    expect(agentLaunchLoadFromReading(reading({ state: 'unavailable' }), NOW)).toBeNull()
    expect(agentLaunchLoadFromReading(reading({ memory: null }), NOW)).toBeNull()
    expect(agentLaunchLoadFromReading(reading({ readAt: null }), NOW)).toBeNull()
  })
})

describe('launchCapacityFromReadiness', () => {
  it('summarises a verified preview from its receipt', () => {
    expect(launchCapacityFromReadiness({ verified: true, receipt })).toEqual({
      freshness: 'fresh',
      bestRemainingPercent: 72,
      boundBy: 'weekly',
      readingAgeMs: 5_000,
      verifiedCount: 2,
      consideredCount: 3,
      source: 'readiness'
    })
  })

  it('names the most useful unavailable state and the earliest reset', () => {
    const summary = launchCapacityFromReadiness({
      verified: false,
      refusal: 'No claude account …',
      accounts: [
        { label: 'a', state: 'stale', reason: 'reading 90 s old' },
        { label: 'b', state: 'limited', reason: '5-hour window exhausted', until: NOW + 60_000 },
        { label: 'c', state: 'limited', reason: 'at its usage limit', until: NOW + 30_000 },
        { label: 'System login', state: 'not-considered', reason: 'same login' }
      ]
    })
    expect(summary).toMatchObject({
      freshness: 'limited',
      bestRemainingPercent: null,
      verifiedCount: 0,
      consideredCount: 3,
      limitedUntil: NOW + 30_000
    })
  })

  it('reads a refusal without account rows as unknown, not as no accounts', () => {
    expect(
      launchCapacityFromReadiness({ verified: false, refusal: 'relay error', accounts: [] })
        .freshness
    ).toBe('unknown')
  })
})

describe('launchCapacityFromChoice (older runtime, accounts.list rows)', () => {
  it('shows the best fresh headroom read-only', () => {
    const choice = chooseVerifiedLaunchAccount(
      [
        row(),
        row({
          accountId: 'b',
          choiceId: 'managed:b',
          readingAt: NOW - 20_000,
          weekly: { remainingPercent: 90, resetsAt: NOW + 86_400_000, windowMinutes: 10080 }
        }),
        row({ accountId: 'c', choiceId: 'managed:c', readingAt: NOW - 600_000 })
      ],
      { provider: 'claude', model: 'claude-sonnet-4-5', now: NOW }
    )
    expect(launchCapacityFromChoice(choice, NOW)).toEqual({
      freshness: 'fresh',
      bestRemainingPercent: 80,
      boundBy: 'five-hour',
      readingAgeMs: 20_000,
      verifiedCount: 2,
      consideredCount: 3,
      source: 'accounts-list'
    })
  })

  it('is limited until the earliest reset when nothing is fresh, and none without rows', () => {
    const limited = chooseVerifiedLaunchAccount(
      [row({ state: 'limited', limitedUntil: NOW + 90_000 }), row({ readingAt: null })],
      { provider: 'claude', model: 'claude-sonnet-4-5', now: NOW }
    )
    expect(launchCapacityFromChoice(limited, NOW)).toMatchObject({
      freshness: 'limited',
      bestRemainingPercent: null,
      readingAgeMs: null,
      verifiedCount: 0,
      limitedUntil: NOW + 90_000
    })
    const empty = chooseVerifiedLaunchAccount([], { provider: 'codex', now: NOW })
    expect(launchCapacityFromChoice(empty, NOW).freshness).toBe('none')
  })
})

it('derives the worktree create mutation id from the launch operation', () => {
  expect(launchWorktreeClientMutationId('op-1')).toBe('launch-op-1')
})
