import { describe, expect, it } from 'vitest'
import type { AccountCapacityRow } from './provider-account-capacity'
import {
  chooseWorkflowRouteAccount,
  workflowSeatCapacity,
  workflowSeatCapacityNote,
  type LocalWorkflowSeatCapacity
} from './local-workflow-seat-capacity'

const NOW = 1_800_000_000_000

function row(change: Partial<AccountCapacityRow>): AccountCapacityRow {
  return {
    provider: 'codex',
    accountId: null,
    choiceId: 'system',
    email: null,
    detail: null,
    isDefault: false,
    isSystem: true,
    fiveHour: { remainingPercent: 80, resetsAt: NOW + 3_600_000, windowMinutes: 300 },
    weekly: { remainingPercent: 60, resetsAt: NOW + 86_400_000, windowMinutes: 10080 },
    fableWeekly: null,
    state: 'ready',
    signedOutReason: null,
    limitedUntil: null,
    readingAt: NOW - 60_000,
    readingPausedUntil: null,
    sourceLabel: null,
    launchEnv: { CODEX_HOME: '/home/.codex' },
    ...change
  }
}

const capacity = (codex: AccountCapacityRow[]) => ({ claude: [], codex })

describe('a workflow account’s capacity', () => {
  it('is fresh only for a current reading with room left, as the tighter window', () => {
    expect(workflowSeatCapacity(capacity([row({})]), 'codex', 'system:codex', NOW)).toEqual({
      state: 'fresh',
      remainingPercent: 60
    })
  })

  it('never counts limited, stale, signed-out or missing readings as spare', () => {
    const at = (change: Partial<AccountCapacityRow>) =>
      workflowSeatCapacity(capacity([row(change)]), 'codex', 'system:codex', NOW).state
    // ~/.codex at 100% of its 5-hour window, as in the runs that lost every Codex call.
    expect(
      at({
        state: 'limited',
        fiveHour: { remainingPercent: 0, resetsAt: NOW + 1, windowMinutes: 300 }
      })
    ).toBe('limited')
    expect(at({ fiveHour: { remainingPercent: 0, resetsAt: NOW + 1, windowMinutes: 300 } })).toBe(
      'limited'
    )
    expect(at({ readingAt: NOW - 301_000 })).toBe('stale')
    expect(at({ state: 'usable' })).toBe('stale')
    expect(at({ state: 'signed-out', launchEnv: null })).toBe('signed-out')
    expect(at({ state: 'checking' })).toBe('unknown')
    expect(at({ fiveHour: null, weekly: null, readingAt: null, state: 'usable' })).toBe('unknown')
    expect(workflowSeatCapacity(undefined, 'codex', 'system:codex', NOW).state).toBe('unknown')
    expect(workflowSeatCapacity(capacity([row({})]), 'grok', 'system:grok', NOW).state).toBe(
      'unknown'
    )
  })

  it('reads a managed account by its id, and a profile as unknown', () => {
    const managed = row({ accountId: 'm1', choiceId: 'managed:m1', isSystem: false })
    const rows = capacity([row({ state: 'limited' }), managed])
    expect(workflowSeatCapacity(rows, 'codex', 'managed:m1', NOW).state).toBe('fresh')
    expect(workflowSeatCapacity(rows, 'codex', 'system:codex', NOW).state).toBe('limited')
    expect(workflowSeatCapacity(rows, 'codex', 'profile:p1', NOW).state).toBe('unknown')
  })
})

describe('the account a route defaults to', () => {
  const entry = (accountId: string, capacity?: LocalWorkflowSeatCapacity) => ({
    accountId,
    ...(capacity ? { capacity } : {})
  })

  it('takes the most fresh capacity, never the system login just for being first', () => {
    const chosen = chooseWorkflowRouteAccount([
      entry('system:codex', { state: 'limited' }),
      entry('managed:b', { state: 'fresh', remainingPercent: 40 }),
      entry('managed:a', { state: 'fresh', remainingPercent: 94 })
    ])
    expect(chosen).toEqual({
      entry: entry('managed:a', { state: 'fresh', remainingPercent: 94 }),
      verified: true
    })
  })

  it('breaks a tie by account id, whatever the catalog order', () => {
    const fresh = { state: 'fresh', remainingPercent: 50 } as const
    expect(
      chooseWorkflowRouteAccount([entry('system:codex', fresh), entry('managed:z', fresh)])?.entry
        .accountId
    ).toBe('managed:z')
    expect(
      chooseWorkflowRouteAccount([entry('managed:z', fresh), entry('system:codex', fresh)])?.entry
        .accountId
    ).toBe('managed:z')
  })

  it('with nothing verified keeps the first account, skipping known-limited ones, unverified', () => {
    expect(
      chooseWorkflowRouteAccount([entry('system:codex'), entry('managed:a', { state: 'stale' })])
    ).toEqual({ entry: entry('system:codex'), verified: false })
    expect(
      chooseWorkflowRouteAccount([
        entry('system:codex', { state: 'limited' }),
        entry('managed:a', { state: 'unknown' })
      ])?.entry.accountId
    ).toBe('managed:a')
    expect(chooseWorkflowRouteAccount([entry('system:codex', { state: 'limited' })])).toEqual({
      entry: entry('system:codex', { state: 'limited' }),
      verified: false
    })
    expect(chooseWorkflowRouteAccount([])).toBeUndefined()
  })

  it('names an account whose capacity was not verified, and says nothing of a fresh one', () => {
    expect(workflowSeatCapacityNote('Codex', 'System Codex', { state: 'limited' })).toBe(
      'Codex ran on System Codex, which was at its usage limit when the run started; its remaining capacity was not verified.'
    )
    expect(workflowSeatCapacityNote('Codex', 'System Codex', undefined)).toContain(
      'had no usage reading'
    )
    expect(
      workflowSeatCapacityNote('Codex', 'a@b', { state: 'fresh', remainingPercent: 3 })
    ).toBeUndefined()
  })
})
