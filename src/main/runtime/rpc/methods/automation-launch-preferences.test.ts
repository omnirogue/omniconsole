import { describe, expect, it } from 'vitest'
import { AutomationCreate, AutomationUpdate } from './automation-schemas'
const create = { name: 'Daily', prompt: 'Work', agentId: 'codex', rrule: 'FREQ=DAILY', dtstart: 1 }

describe('automation launch RPC schemas', () => {
  it('accepts catalog efforts, partial preferences and explicit clears', () => {
    expect(
      AutomationCreate.parse({
        ...create,
        launchPreferences: { model: 'gpt-6-astra', effort: 'ultra', codexAccountId: 'a' }
      }).launchPreferences?.effort
    ).toBe('ultra')
    expect(
      AutomationCreate.safeParse({ ...create, launchPreferences: { effort: 'xhigh' } }).success
    ).toBe(true)
    expect(
      AutomationUpdate.parse({ id: 'a', updates: { launchPreferences: null } }).updates
        .launchPreferences
    ).toBeNull()
  })
  it.each(['model', 'effort', 'codexAccountId'])('rejects oversized %s', (key) => {
    expect(
      AutomationCreate.safeParse({ ...create, launchPreferences: { [key]: 'a'.repeat(121) } })
        .success
    ).toBe(false)
  })
  it('rejects invalid effort and a Codex account for Claude', () => {
    expect(
      AutomationCreate.safeParse({ ...create, launchPreferences: { effort: 'bogus' } }).success
    ).toBe(false)
    expect(
      AutomationUpdate.safeParse({
        id: 'a',
        updates: { agentId: 'claude', launchPreferences: { effort: 'ultra' } }
      }).success
    ).toBe(false)
    expect(
      AutomationCreate.safeParse({
        ...create,
        agentId: 'claude',
        launchPreferences: { codexAccountId: 'a' }
      }).success
    ).toBe(false)
  })
})
