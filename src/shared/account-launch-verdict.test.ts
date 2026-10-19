import { describe, expect, it } from 'vitest'
import type { AccountCapacityRow } from './provider-account-capacity'
import {
  chooseVerifiedLaunchAccount,
  classifyLaunchAccountRow,
  isKnownNonFableClaudeModel,
  launchAccountReceipt,
  launchFableRule,
  launchRefusalText,
  LAUNCH_ACCOUNT_FRESH_MS,
  type LaunchFableRule
} from './account-launch-verdict'

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

const system = (change: Partial<AccountCapacityRow> = {}) =>
  row({
    accountId: null,
    choiceId: 'system',
    email: 'sys@example.com',
    isSystem: true,
    launchEnv: { CLAUDE_CONFIG_DIR: '/home/.claude' },
    ...change
  })

const classify = (
  change: Partial<AccountCapacityRow>,
  fable: LaunchFableRule = 'ignore',
  fableReadingAt?: number | null
) =>
  classifyLaunchAccountRow(row(change), {
    now: NOW,
    freshMs: LAUNCH_ACCOUNT_FRESH_MS,
    fable,
    fableReadingAt
  })

describe('launch account verdict', () => {
  it('is fresh only for a ready reading at most 60 s old with room in every known window', () => {
    expect(classify({ readingAt: NOW - 60_000 })).toEqual({
      state: 'fresh',
      remainingPercent: 60,
      boundBy: 'weekly',
      fableVerified: false
    })
    expect(
      classify({ fiveHour: { remainingPercent: 20, resetsAt: null, windowMinutes: 300 } })
    ).toMatchObject({ state: 'fresh', remainingPercent: 20, boundBy: 'five-hour' })
  })

  it('reports stale at 61 s and for a reading paused by Retry-After, never as 0%', () => {
    const old = classify({ readingAt: NOW - 61_000 })
    expect(old).toMatchObject({ state: 'stale', reason: 'reading 61 s old' })
    expect(old).not.toHaveProperty('remainingPercent')
    const paused = classify({ state: 'usable', readingPausedUntil: NOW + 30_000 })
    expect(paused).toMatchObject({ state: 'stale', reason: expect.stringContaining('paused') })
    expect(paused).not.toHaveProperty('remainingPercent')
  })

  it('reports unknown for checking rows, rows without windows and rows without a reading', () => {
    expect(classify({ state: 'checking', launchEnv: null }).state).toBe('unknown')
    expect(classify({ fiveHour: null, weekly: null }).state).toBe('unknown')
    expect(classify({ readingAt: null, state: 'usable' }).state).toBe('unknown')
  })

  it('reports limited when any counted window is at 0', () => {
    expect(
      classify({ fiveHour: { remainingPercent: 0, resetsAt: NOW + 1, windowMinutes: 300 } })
    ).toMatchObject({ state: 'limited', reason: '5-hour window exhausted' })
    expect(classify({ state: 'limited', limitedUntil: NOW + 5_000 })).toMatchObject({
      state: 'limited',
      until: NOW + 5_000
    })
    expect(classify({ state: 'signed-out', launchEnv: null, signedOutReason: 'revoked' })).toEqual({
      state: 'signed-out',
      reason: 'sign-in revoked'
    })
  })

  it('passes a weekly-only Codex row on its weekly window', () => {
    expect(
      classify({ provider: 'codex', fiveHour: null, launchEnv: { CODEX_HOME: '/home/.codex-a' } })
    ).toMatchObject({ state: 'fresh', remainingPercent: 60, boundBy: 'weekly' })
  })

  it('excludes accounts approaching a 5-hour or weekly 429 before ranking them', () => {
    expect(
      classify({
        fiveHour: { remainingPercent: 15, resetsAt: NOW + 3_600_000 * 3, windowMinutes: 300 }
      })
    ).toMatchObject({
      state: 'limited',
      reason: '5-hour quota may run out in about 22 min at the window-average burn rate'
    })
    expect(
      classify({
        weekly: { remainingPercent: 11, resetsAt: NOW + 86_400_000 * 6, windowMinutes: 10080 }
      })
    ).toMatchObject({
      state: 'limited',
      reason: 'weekly quota may run out in about 178 min at the window-average burn rate'
    })
    expect(
      classify({ weekly: { remainingPercent: 9, resetsAt: null, windowMinutes: 10080 } })
    ).toMatchObject({ state: 'limited', reason: 'weekly quota has 10% or less remaining' })
  })

  it('requires and counts a fresh Fable window for a Fable model', () => {
    expect(launchFableRule('claude', 'fable-1')).toBe('require')
    expect(classify({}, 'require')).toMatchObject({ state: 'unknown', reason: 'no Fable reading' })
    const fable = { remainingPercent: 12, resetsAt: NOW + 86_400_000, windowMinutes: 10080 }
    expect(classify({ fableWeekly: fable }, 'require', NOW - 20_000)).toEqual({
      state: 'fresh',
      remainingPercent: 12,
      boundBy: 'fable-weekly',
      fableVerified: true
    })
    expect(classify({ fableWeekly: { ...fable, remainingPercent: 0 } }, 'require').state).toBe(
      'limited'
    )
  })

  it('verifies a Fable window by its own reading time, not a live post that carried it over', () => {
    const fable = { remainingPercent: 40, resetsAt: NOW + 86_400_000, windowMinutes: 10080 }
    const live = { readingAt: NOW - 1_000, fableWeekly: fable }
    expect(classify(live, 'require', NOW - 10_800_000)).toEqual({
      state: 'stale',
      reason: 'Fable reading 10800 s old'
    })
    expect(classify(live, 'require')).toEqual({
      state: 'stale',
      reason: 'no current Fable reading'
    })
    expect(classify(live, 'gate', NOW - 10_800_000)).toMatchObject({
      state: 'fresh',
      boundBy: 'weekly',
      fableVerified: false
    })
    const rows = [row(live)]
    const choose = (fableReadingAt?: () => number | null) =>
      chooseVerifiedLaunchAccount(rows, {
        provider: 'claude',
        model: 'claude-fable-1',
        now: NOW,
        fableReadingAt
      }).pick?.verdict
    expect(choose()).toBeUndefined()
    expect(choose(() => NOW - 60_000)).toMatchObject({
      boundBy: 'fable-weekly',
      fableVerified: true
    })
  })

  it('gates on an exhausted Fable window for an omitted or unknown Claude model without counting it', () => {
    expect(launchFableRule('claude', undefined)).toBe('gate')
    expect(launchFableRule('claude', 'claude-next')).toBe('gate')
    const fable = { remainingPercent: 0, resetsAt: NOW + 86_400_000, windowMinutes: 10080 }
    expect(classify({ fableWeekly: fable }, 'gate')).toMatchObject({
      state: 'limited',
      reason: 'Fable window exhausted'
    })
    expect(classify({ fableWeekly: { ...fable, remainingPercent: 5 } }, 'gate', NOW)).toEqual({
      state: 'fresh',
      remainingPercent: 60,
      boundBy: 'weekly',
      fableVerified: true
    })
  })

  it('ignores the Fable window for Codex and for known Opus/Sonnet/Haiku models', () => {
    expect(launchFableRule('codex', undefined)).toBe('ignore')
    for (const model of ['opus', 'claude-sonnet-4-5', 'haiku']) {
      expect(isKnownNonFableClaudeModel(model)).toBe(true)
      expect(launchFableRule('claude', model)).toBe('ignore')
    }
    expect(isKnownNonFableClaudeModel('opus-fable')).toBe(false)
    const exhausted = { remainingPercent: 0, resetsAt: NOW + 1, windowMinutes: 10080 }
    expect(classify({ fableWeekly: exhausted }, 'ignore')).toMatchObject({
      state: 'fresh',
      fableVerified: false
    })
  })
})

describe('verified launch account choice', () => {
  const choose = (rows: AccountCapacityRow[], model?: string) =>
    chooseVerifiedLaunchAccount(rows, { provider: 'claude', model, now: NOW })

  it('drops the System row when a managed account is the default and keeps it when System is the default', () => {
    const managedDefault = choose([
      system({ weekly: { remainingPercent: 90, resetsAt: null, windowMinutes: 10080 } }),
      row({ isDefault: true })
    ])
    expect(managedDefault.pick?.row.choiceId).toBe('managed:a')
    expect(managedDefault.verdicts[0]!.verdict).toEqual({
      state: 'not-considered',
      reason: 'not considered: same login as the selected default'
    })
    const systemDefault = choose([
      system({
        isDefault: true,
        weekly: { remainingPercent: 90, resetsAt: null, windowMinutes: 10080 }
      }),
      row()
    ])
    expect(systemDefault.pick?.row.choiceId).toBe('system')
  })

  it('breaks ties by default account, then choice id', () => {
    const at = (id: string, isDefault = false) =>
      row({ accountId: id, choiceId: `managed:${id}`, isDefault })
    expect(choose([at('c'), at('b', true), at('a')]).pick?.row.choiceId).toBe('managed:b')
    expect(choose([at('c'), at('a')]).pick?.row.choiceId).toBe('managed:a')
  })

  it('chooses a safe account over a higher-balance account on pace to hit 429', () => {
    const risky = row({
      isDefault: true,
      fiveHour: { remainingPercent: 25, resetsAt: NOW + 4 * 3_600_000, windowMinutes: 300 },
      weekly: { remainingPercent: 90, resetsAt: NOW + 86_400_000, windowMinutes: 10080 }
    })
    const safe = row({
      accountId: 'b',
      choiceId: 'managed:b',
      email: 'b@x',
      fiveHour: { remainingPercent: 20, resetsAt: NOW + 3_600_000, windowMinutes: 300 },
      weekly: { remainingPercent: 20, resetsAt: NOW + 86_400_000, windowMinutes: 10080 }
    })
    const choice = choose([risky, safe])
    expect(choice.pick?.row.choiceId).toBe('managed:b')
    expect(choice.verdicts[0]?.verdict).toMatchObject({
      state: 'limited',
      reason: '5-hour quota may run out in about 20 min at the window-average burn rate'
    })
  })

  it('never picks usable, checking, limited or signed-out rows and names each in the refusal', () => {
    const rows = [
      row({ accountId: 'u', choiceId: 'managed:u', email: 'u@x', state: 'usable' }),
      row({ accountId: 'c', choiceId: 'managed:c', email: 'c@x', state: 'checking' }),
      row({ accountId: 'l', choiceId: 'managed:l', email: 'l@x', state: 'limited' }),
      row({
        accountId: 's',
        choiceId: 'managed:s',
        email: 's@x',
        state: 'signed-out',
        launchEnv: null
      })
    ]
    const choice = choose(rows)
    expect(choice.pick).toBeNull()
    const text = launchRefusalText('claude', 'studio', choice.verdicts)
    expect(text).toMatch(/^No claude account on studio has fresh verified capacity/)
    for (const label of [
      'u@x: ',
      'c@x: first reading',
      'l@x: at its usage limit',
      's@x: not signed in'
    ]) {
      expect(text).toContain(label)
    }
    expect(text.endsWith('Nothing launched.')).toBe(true)
  })

  it('reports the pick, what was verified and why in the receipt', () => {
    const choice = choose([
      system(),
      row({ isDefault: true, sourceLabel: '~/.claude-accounts/pool/slot-3' }),
      row({ accountId: 'b', choiceId: 'managed:b', email: 'b@x', state: 'limited' })
    ])
    expect(
      launchAccountReceipt({
        hostId: 'local',
        provider: 'claude',
        choice: { ...choice, pick: choice.pick! },
        now: NOW
      })
    ).toEqual({
      policy: 'best-verified',
      hostId: 'local',
      provider: 'claude',
      label: 'a@example.com · ~/.claude-accounts/pool/slot-3',
      choiceId: 'managed:a',
      remainingPercent: 60,
      boundBy: 'weekly',
      readingAt: NOW - 10_000,
      readingAgeMs: 10_000,
      fableVerified: false,
      verified: 1,
      considered: 2,
      excluded: [
        { label: 'System login', reason: 'not considered: same login as the selected default' },
        { label: 'b@x', reason: 'at its usage limit' }
      ],
      why: 'the only account with fresh verified headroom (60%, weekly)'
    })
  })
})
