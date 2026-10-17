import { describe, expect, it } from 'vitest'
import { conversationFleetInventory } from './console-conversation-fleet-responses'

function inventory() {
  return {
    ok: true,
    providers: ['codex'],
    models: [],
    people: [],
    repositories: [],
    models_fallback: false,
    machines: [
      {
        host: 'mw0003',
        allowed: true,
        ready: true,
        last_beat: '2026-09-12T18:00:00Z',
        slots: 4,
        running: 1,
        execution_capabilities: [
          {
            provider: 'codex',
            models: ['test-model'],
            efforts: ['high'],
            available: true,
            resume: true,
            readonly: true,
            native_execution: true,
            pinned_task_inputs: true,
            source_snapshot: true,
            account_usage: {
              version: 1,
              selected_account_ref: '11111111-1111-4111-8111-111111111111',
              account_generation: '22222222-2222-4222-8222-222222222222',
              usage: {
                provider: 'codex',
                status: 'ok',
                updatedAt: 1_789_225_000_000,
                error: null,
                session: {
                  usedPercent: 25,
                  windowMinutes: 300,
                  resetsAt: null,
                  resetDescription: null
                },
                weekly: null
              }
            }
          }
        ]
      }
    ]
  }
}

describe('signed fleet inventory account receipts', () => {
  it('preserves selected account scope, generation and original observation beside source snapshot support', () => {
    const input = inventory()
    expect(conversationFleetInventory.parse(input)).toEqual(input)
  })

  it('refuses usage from another provider on a route', () => {
    const input = inventory()
    input.machines[0]!.execution_capabilities[0]!.account_usage.usage.provider = 'claude'
    expect(conversationFleetInventory.safeParse(input).success).toBe(false)
  })

  it('accepts legacy and explicitly unknown receipts without inventing quota', () => {
    const input = inventory()
    const capability = input.machines[0]!.execution_capabilities[0]!
    const unknown = { ...capability, account_usage: null }
    const legacy = Object.fromEntries(
      Object.entries(capability).filter(([key]) => key !== 'account_usage')
    )
    for (const value of [
      unknown,
      legacy,
      { ...capability, account_usage: { ...capability.account_usage, usage: null } }
    ]) {
      expect(
        conversationFleetInventory.parse({
          ...input,
          machines: [{ ...input.machines[0], execution_capabilities: [value] }]
        }).machines[0]!.execution_capabilities[0]
      ).toEqual(value)
    }
  })
})
