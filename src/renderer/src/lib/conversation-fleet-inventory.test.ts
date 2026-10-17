import { describe, expect, it, vi } from 'vitest'
import { conversationFleetAgents } from './conversation-fleet-inventory'
import type { ConsoleConversationFleetInventory } from '../../../shared/console-conversation-fleet-types'
import type { FleetAccountUsageReceipt } from '../../../shared/fleet-account-usage'

vi.mock('./agent-catalog', () => ({
  getAgentCatalog: () => [
    { id: 'codex', name: 'Codex' },
    { id: 'omp', name: 'OMP' }
  ]
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const now = Date.parse('2026-09-12T12:00:00Z')

function receipt(index: number): FleetAccountUsageReceipt {
  return {
    version: 1,
    selected_account_ref: `11111111-1111-4111-8111-11111111111${index}`,
    account_generation: `22222222-2222-4222-8222-22222222222${index}`,
    usage: {
      provider: 'codex',
      status: 'ok',
      updatedAt: now - 1_000,
      error: null,
      session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null
    }
  }
}

function inventory(verified = false): ConsoleConversationFleetInventory {
  return {
    providers: ['codex'],
    people: [],
    repositories: [],
    models_fallback: false,
    models: [
      {
        id: 'codex:chosen',
        provider: 'codex',
        model: 'chosen',
        default: true,
        supported_efforts: ['low', 'high', 'max'],
        seat_ready: null,
        aliases: []
      }
    ],
    machines: ['first', 'second'].map((host, index) => ({
      host,
      allowed: true,
      ready: true,
      slots: 1,
      running: 0,
      last_beat: new Date(now).toISOString(),
      execution_capabilities: [
        {
          provider: 'codex',
          available: true,
          resume: true,
          readonly: true,
          native_execution: true,
          pinned_task_inputs: true,
          source_snapshot: true,
          models: ['chosen'],
          efforts: index ? ['high'] : ['low'],
          ...(verified ? { account_usage: receipt(index) } : {})
        }
      ]
    }))
  }
}

function agents(offered: ConsoleConversationFleetInventory, machine?: string) {
  return conversationFleetAgents(offered, machine, now)
}

function efforts(offered: ConsoleConversationFleetInventory, machine?: string): string[] {
  const option = agents(offered, machine)[0]?.models[0]?.options.find(
    (entry) => entry.id === 'effort'
  )
  return option?.kind.type === 'select' ? option.kind.choices.map((choice) => choice.value) : []
}

describe('fleet model and effort inventory', () => {
  it.each([undefined, 'first', 'second'])(
    'does not promote advertised routes to usable agents for %s',
    (machine) => {
      const offered = inventory()
      offered.models[0]!.seat_ready = true
      const original = structuredClone(offered)
      expect(agents(offered, machine)).toEqual([])
      expect(offered).toEqual(original)
    }
  )

  it('unions only models and efforts verified on their owning account and host', () => {
    const offered = inventory(true)
    const original = structuredClone(offered)
    expect(efforts(offered)).toEqual(['low', 'high'])
    expect(efforts(offered, 'first')).toEqual(['low'])
    expect(efforts(offered, 'second')).toEqual(['high'])
    expect(agents(offered)[0]).toMatchObject({ status: 'usable', checkedAt: now })
    expect(offered).toEqual(original)
  })

  it('keeps a busy host available only when explicitly selected and independently verified', () => {
    const offered = inventory(true)
    offered.machines[1]!.ready = false
    expect(efforts(offered)).toEqual(['low'])
    expect(efforts(offered, 'second')).toEqual(['high'])
    delete offered.machines[1]!.execution_capabilities[0]!.account_usage
    expect(agents(offered, 'second')).toEqual([])
    offered.machines[0]!.allowed = false
    expect(agents(offered, 'first')).toEqual([])
    expect(agents(offered, 'unknown')).toEqual([])
  })

  it('does not treat fallback model catalogs as verified availability', () => {
    const offered = inventory(true)
    offered.models_fallback = true
    expect(agents(offered)).toEqual([])
  })

  it.each([undefined, false] as const)(
    'excludes a pinned-input runner with source_snapshot=%s',
    (flag) => {
      const offered = inventory(true)
      const capability = offered.machines[0]!.execution_capabilities[0]!
      if (flag === undefined) {
        delete capability.source_snapshot
      } else {
        capability.source_snapshot = flag
      }
      expect(agents(offered, 'first')).toEqual([])
      expect(efforts(offered)).toEqual(['high'])
      capability.source_snapshot = true
      expect(efforts(offered, 'first')).toEqual(['low'])
      expect(efforts(offered)).toEqual(['low', 'high'])
    }
  )

  it.each(['resume', 'readonly', 'native_execution', 'pinned_task_inputs', 'available'] as const)(
    'requires %s before offering a model for uploaded conversation inputs',
    (flag) => {
      const offered = inventory(true)
      offered.machines.forEach((host) => {
        host.execution_capabilities[0]![flag] = false
      })
      expect(agents(offered)).toEqual([])
    }
  )

  it.each(['missing', 'unknown', 'stale', 'future', 'provider-mismatch', 'error', 'quota'])(
    'does not borrow a healthy host account receipt for a %s host',
    (condition) => {
      const offered = inventory(true)
      const capability = offered.machines[0]!.execution_capabilities[0]!
      const usage = capability.account_usage!.usage!
      if (condition === 'missing') {
        delete capability.account_usage
      }
      if (condition === 'unknown') {
        capability.account_usage!.usage = null
      }
      if (condition === 'stale') {
        usage.updatedAt = now - 360_001
      }
      if (condition === 'future') {
        usage.updatedAt = now + 1
      }
      if (condition === 'provider-mismatch') {
        usage.provider = 'claude'
      }
      if (condition === 'error') {
        usage.status = 'error'
        usage.error = 'network'
      }
      if (condition === 'quota') {
        usage.session!.usedPercent = 100
      }
      expect(agents(offered, 'first')).toEqual([])
      expect(efforts(offered)).toEqual(['high'])
    }
  )

  it('does not borrow healthy quota from another capability row for model efforts', () => {
    const offered = inventory(true)
    const first = offered.machines[0]!.execution_capabilities[0]!
    first.account_usage!.usage!.session = null
    first.account_usage!.usage!.buckets = [
      {
        name: 'chosen',
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      }
    ]
    offered.machines[0]!.execution_capabilities.push({
      ...first,
      efforts: ['high'],
      account_usage: receipt(2)
    })
    expect(efforts(offered, 'first')).toEqual(['high'])
    first.account_usage!.usage!.buckets[0]!.usedPercent = 40
    expect(efforts(offered, 'first')).toEqual(['low', 'high'])
  })

  it('honors the existing six-minute freshness boundary without refreshing the receipt', () => {
    const offered = inventory(true)
    const usage = offered.machines[0]!.execution_capabilities[0]!.account_usage!.usage!
    usage.updatedAt = now - 360_000
    expect(efforts(offered, 'first')).toEqual(['low'])
    expect(conversationFleetAgents(offered, 'first', now + 1)).toEqual([])
    expect(usage.updatedAt).toBe(now - 360_000)
  })

  it('rejects malformed account identity and unknown quota-to-model mappings', () => {
    const offered = inventory(true)
    const capability = offered.machines[0]!.execution_capabilities[0]!
    capability.account_usage!.selected_account_ref = 'not-an-account-reference'
    expect(agents(offered, 'first')).toEqual([])
    capability.account_usage = receipt(0)
    capability.account_usage.usage!.session = null
    capability.account_usage.usage!.buckets = [
      {
        name: 'unknown',
        usedPercent: 10,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      }
    ]
    expect(agents(offered, 'first')).toEqual([])
    expect(efforts(offered)).toEqual(['high'])
  })

  it('keeps model-specific quota and effort membership on the same capability row', () => {
    const offered = inventory(true)
    offered.models.push({
      ...offered.models[0]!,
      id: 'codex:other',
      model: 'other',
      default: false
    })
    const capability = offered.machines[0]!.execution_capabilities[0]!
    capability.models.push('other')
    capability.account_usage!.usage!.session = null
    capability.account_usage!.usage!.buckets = [
      {
        name: 'chosen',
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      },
      { name: 'other', usedPercent: 10, windowMinutes: 300, resetsAt: null, resetDescription: null }
    ]
    expect(agents(offered, 'first')[0]!.models.map((model) => model.id)).toEqual(['other'])
    expect(agents(offered)[0]!.models.map((model) => model.id)).toEqual(['chosen', 'other'])
    expect(efforts(offered)).toEqual(['high'])
  })

  it('never combines snapshot support and account evidence across capability rows', () => {
    const offered = inventory(true)
    const capability = offered.machines[0]!.execution_capabilities[0]!
    capability.source_snapshot = false
    offered.machines[0]!.execution_capabilities.push({
      ...capability,
      source_snapshot: true,
      account_usage: undefined
    })
    expect(agents(offered, 'first')).toEqual([])
  })

  it('allows verified provider defaults without inventing effort choices', () => {
    const offered = inventory(true)
    offered.machines.forEach((host) => {
      host.execution_capabilities[0]!.efforts = []
    })
    expect(agents(offered)[0]!.models[0]!.options).toEqual([])
    delete offered.machines[0]!.execution_capabilities[0]!.account_usage
    delete offered.machines[1]!.execution_capabilities[0]!.account_usage
    expect(agents(offered)).toEqual([])
  })
})

describe('backend-authorized OMP fleet inventory', () => {
  function ompInventory(): ConsoleConversationFleetInventory {
    return {
      ...inventory(),
      models: [
        {
          id: 'omp:openrouter/x-ai/grok-4.5',
          provider: 'omp',
          model: 'openrouter/x-ai/grok-4.5',
          supported_efforts: [],
          default: false,
          seat_ready: true,
          aliases: [],
          hosts: ['first']
        }
      ]
    }
  }
  it('preserves exact host membership and full selector without desktop usage receipts', () => {
    const offered = ompInventory()
    expect(agents(offered, 'first')[0]?.models).toEqual([
      {
        id: 'openrouter/x-ai/grok-4.5',
        label: 'openrouter/x-ai/grok-4.5',
        isDefault: false,
        options: [],
        hosts: ['first']
      }
    ])
    expect(agents(offered)).toEqual([])
    expect(agents(offered, 'second')).toEqual([])
    expect(agents(offered, 'unknown')).toEqual([])
  })
  it.each(['missing-hosts', 'not-ready', 'not-allowed', 'unknown-seat', 'fallback-catalog'])(
    'refuses %s rather than offering static or sibling-host models',
    (condition) => {
      const offered = ompInventory()
      if (condition === 'missing-hosts') {
        delete offered.models[0]!.hosts
      }
      if (condition === 'not-ready') {
        offered.machines[0]!.ready = false
      }
      if (condition === 'not-allowed') {
        offered.machines[0]!.allowed = false
      }
      if (condition === 'unknown-seat') {
        offered.models[0]!.seat_ready = null
      }
      if (condition === 'fallback-catalog') {
        offered.models_fallback = true
      }
      expect(agents(offered, 'first')).toEqual([])
    }
  )
})
