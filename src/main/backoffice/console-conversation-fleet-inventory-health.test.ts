import { describe, expect, it } from 'vitest'
import { conversationFleetInventory } from './console-conversation-fleet-responses'

/**
 * The console reports machine health from the runner heartbeat. This desktop ships before
 * every console has that release, so each field must survive both ways: carried through
 * when sent, and simply absent when not — never defaulted to a number nobody measured.
 */
function inventory(machine: Record<string, unknown>) {
  return {
    ok: true,
    providers: [],
    models: [],
    people: [],
    repositories: [],
    models_fallback: false,
    machines: [
      {
        host: 'mw0002',
        allowed: true,
        ready: true,
        last_beat: '2026-09-13T10:00:00Z',
        slots: 4,
        running: 1,
        execution_capabilities: [],
        ...machine
      }
    ]
  }
}

describe('fleet inventory machine health', () => {
  it('carries cores, load, ratio, free slots and memory through untouched', () => {
    const input = inventory({
      cores: 10,
      load1: 1.25,
      ratio: 0.125,
      free_slots: 3,
      mem_total_bytes: 68_719_476_736,
      mem_used_bytes: 40_802_189_312
    })
    expect(conversationFleetInventory.parse(input)).toEqual(input)
  })

  it('accepts a console that reports no health at all', () => {
    const input = inventory({})
    const parsed = conversationFleetInventory.parse(input)
    expect(parsed).toEqual(input)
    expect(parsed.machines[0]!.cores).toBeUndefined()
    expect(parsed.machines[0]!.mem_total_bytes).toBeUndefined()
  })

  it('accepts an explicitly unknown reading without turning it into zero', () => {
    const parsed = conversationFleetInventory.parse(
      inventory({ cores: null, load1: null, ratio: null, free_slots: null })
    )
    expect(parsed.machines[0]!.cores).toBeNull()
    expect(parsed.machines[0]!.load1).toBeNull()
  })

  it('refuses a negative or unusable reading', () => {
    for (const bad of [{ cores: -1 }, { load1: -0.5 }, { free_slots: 1.5 }, { load1: 'high' }]) {
      expect(conversationFleetInventory.safeParse(inventory(bad)).success).toBe(false)
    }
  })
})
