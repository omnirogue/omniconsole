import { describe, expect, it } from 'vitest'
import { AutomationCreate, AutomationUpdate } from './automation-schemas'

const create = { name: 'Daily', prompt: 'Work', agentId: 'codex', rrule: 'FREQ=DAILY', dtstart: 1 }
const advertising = {
  provider: 'typesafe',
  contract: 'advertising.v1',
  advertising: { company: 'omnirogue', accountId: 'act_123456' }
} as const

describe('structured decision routine RPC settings', () => {
  it('retains legacy absence and permits explicit removal', () => {
    expect(AutomationCreate.parse(create)).not.toHaveProperty('structuredOutput')
    expect(AutomationUpdate.parse({ id: 'a', updates: {} }).updates).not.toHaveProperty(
      'structuredOutput'
    )
    expect(
      AutomationUpdate.parse({ id: 'a', updates: { structuredOutput: null } }).updates
    ).toEqual({ structuredOutput: null })
  })

  it('accepts explicit classification and binds advertising policy defaults', () => {
    expect(
      AutomationCreate.parse({
        ...create,
        structuredOutput: { provider: 'typesafe', contract: 'classification.v1' }
      }).structuredOutput
    ).toEqual({ provider: 'typesafe', contract: 'classification.v1' })
    expect(
      AutomationCreate.parse({ ...create, structuredOutput: advertising }).structuredOutput
    ).toEqual({
      ...advertising,
      advertising: {
        ...advertising.advertising,
        allowedObjectTypes: ['adset', 'ad'],
        minConfidence: 0.8,
        maxEvidenceAgeSeconds: 300
      }
    })
  })

  it.each([
    { provider: 'unknown', contract: 'classification.v1' },
    { provider: 'typesafe', contract: 'unknown.v1' },
    { provider: 'typesafe', contract: 'advertising.v1' },
    { ...advertising, advertising: { ...advertising.advertising, accountId: 'unbound' } },
    { ...advertising, advertising: { ...advertising.advertising, company: 'other' } },
    { ...advertising, advertising: { ...advertising.advertising, minConfidence: 0.1 } },
    { ...advertising, advertising: { ...advertising.advertising, maxEvidenceAgeSeconds: 3600 } },
    { ...advertising, apiKey: 'secret' },
    { ...advertising, contract: 'classification.v1' }
  ])('rejects unsupported, unbound or secret-bearing settings %#', (structuredOutput) => {
    expect(AutomationCreate.safeParse({ ...create, structuredOutput }).success).toBe(false)
    expect(AutomationUpdate.safeParse({ id: 'a', updates: { structuredOutput } }).success).toBe(
      false
    )
  })
})
