import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ConsoleConversationFleetInventory,
  ConsoleConversationFleetMachine
} from './console-conversation-fleet-types'
import { resolveConversationFleetFolderMachine } from './conversation-fleet-machine'
import { emptyNextStepDraft, type NextStepDraft } from './next-step-draft'

const now = Date.parse('2026-09-12T12:00:00Z')

function machine(host: string): ConsoleConversationFleetMachine {
  return {
    host,
    allowed: true,
    ready: true,
    slots: 2,
    running: 0,
    last_beat: '2026-09-12T12:00:00Z',
    execution_capabilities: (['codex', 'claude'] as const).map((provider, index) => ({
      provider,
      available: true,
      resume: true,
      readonly: true,
      native_execution: true,
      pinned_task_inputs: true,
      source_snapshot: true,
      folder_workspace: true,
      retained_outputs: true,
      models: [`${provider}-model`],
      efforts: ['high'],
      account_usage: {
        version: 1,
        selected_account_ref: `11111111-1111-4111-8111-00000000${host.slice(2)}`,
        account_generation: `22222222-2222-4222-8222-22222222222${index}`,
        usage: {
          provider,
          status: 'ok',
          updatedAt: now - 1_000,
          error: null,
          session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
          weekly: null
        }
      }
    }))
  }
}

function inventory(): ConsoleConversationFleetInventory {
  return {
    providers: ['codex', 'claude'],
    models_fallback: false,
    people: [],
    repositories: [],
    models: ['codex', 'claude'].map((provider) => ({
      provider,
      model: `${provider}-model`,
      id: `${provider}:${provider}-model`,
      supported_efforts: ['high'],
      default: true,
      seat_ready: true,
      aliases: []
    })),
    machines: [machine('mw0004'), machine('mw0003')]
  }
}

function draft(): NextStepDraft {
  return {
    ...emptyNextStepDraft(),
    recipients: [
      {
        key: 'one',
        kind: 'agent',
        agent: 'codex',
        presetId: 'improve',
        instructions: 'Improve this.',
        rounds: 1
      }
    ]
  }
}

describe('folder fleet machine selection', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('refuses fallback catalog membership even when a host has a usage receipt', () => {
    const offered = inventory()
    offered.models_fallback = true
    expect(() => resolveConversationFleetFolderMachine(draft(), offered)).toThrow(
      'Fleet model availability is unverified'
    )
  })

  it.each(['missing', 'unknown', 'stale', 'future', 'provider-mismatch', 'error', 'quota'])(
    'does not borrow another host account receipt when selected account evidence is %s',
    (condition) => {
      const offered = inventory()
      const capability = offered.machines[1]!.execution_capabilities[0]!
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
      expect(resolveConversationFleetFolderMachine(draft(), offered)).toBe('mw0004')
      expect(() =>
        resolveConversationFleetFolderMachine(draft(), offered, { selectedMachine: 'mw0003' })
      ).toThrow('mw0003 cannot run')
    }
  )

  it('does not join quota evidence to a selected effort on a different account row', () => {
    const offered = inventory()
    const plan = draft()
    const recipient = plan.recipients[0]!
    if (recipient.kind !== 'agent') {
      throw new Error('fixture')
    }
    recipient.effort = 'high'
    const capability = offered.machines[1]!.execution_capabilities[0]!
    const healthyAccount = structuredClone(capability.account_usage!)
    healthyAccount.selected_account_ref = '33333333-3333-4333-8333-333333333333'
    capability.account_usage!.usage!.session!.usedPercent = 100
    offered.machines[1]!.execution_capabilities.push({
      ...capability,
      efforts: ['low'],
      account_usage: healthyAccount
    })
    expect(resolveConversationFleetFolderMachine(plan, offered)).toBe('mw0004')
    expect(() =>
      resolveConversationFleetFolderMachine(plan, offered, { selectedMachine: 'mw0003' })
    ).toThrow('mw0003 cannot run')
  })

  it('requires fresh evidence for every parallel and follow-on provider on the chosen host', () => {
    const offered = inventory()
    const plan = draft()
    plan.after = [
      {
        key: 'review',
        kind: 'agent',
        actor: { agent: 'claude', effort: 'high' },
        presetId: 'verify',
        instructions: 'Verify result.',
        rounds: 1
      }
    ]
    delete offered.machines[1]!.execution_capabilities[1]!.account_usage
    expect(resolveConversationFleetFolderMachine(plan, offered)).toBe('mw0004')
    delete offered.machines[0]!.execution_capabilities[0]!.account_usage
    expect(() => resolveConversationFleetFolderMachine(plan, offered)).toThrow(
      'No ready fleet machine'
    )
  })

  it('filters a selected model by its account-specific quota bucket', () => {
    const offered = inventory()
    const usage = offered.machines[1]!.execution_capabilities[0]!.account_usage!.usage!
    usage.session = null
    usage.buckets = [
      {
        name: 'codex-model',
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      }
    ]
    expect(resolveConversationFleetFolderMachine(draft(), offered)).toBe('mw0004')
    usage.buckets[0]!.usedPercent = 10
    expect(resolveConversationFleetFolderMachine(draft(), offered)).toBe('mw0003')
  })

  it('chooses seats only for agents when people receive initial or follow-on deliveries', () => {
    const plan = draft()
    plan.recipients.push({ key: 'person', kind: 'person', id: 'emp_one', name: 'One' })
    plan.after = [{ key: 'after-person', kind: 'person', id: 'emp_two', name: 'Two' }]
    const sourceSummaryFile = {
      kind: 'task_file' as const,
      task_id: 'btk_source',
      file: {
        rel: 'summary.md',
        name: 'summary.md',
        sha256: 'a'.repeat(64),
        size_bytes: 12
      }
    }
    expect(resolveConversationFleetFolderMachine(plan, inventory(), { sourceSummaryFile })).toBe(
      'mw0003'
    )
  })

  it('requires retained-output capability only on routes that feed person delivery', () => {
    const offered = inventory()
    offered.machines.forEach((host) => {
      host.execution_capabilities[0]!.retained_outputs = false
    })
    expect(resolveConversationFleetFolderMachine(draft(), offered)).toBe('mw0003')
    const plan = draft()
    plan.after = [{ key: 'person', kind: 'person', id: 'emp_one', name: 'One' }]
    expect(() => resolveConversationFleetFolderMachine(plan, offered)).toThrow(
      'No ready fleet machine'
    )
    offered.machines[0]!.execution_capabilities[0]!.retained_outputs = true
    expect(resolveConversationFleetFolderMachine(plan, offered)).toBe('mw0004')
  })

  it('selects deterministically from capable allowed ready hosts', () => {
    const offered = inventory()
    expect(resolveConversationFleetFolderMachine(draft(), offered)).toBe('mw0003')
    offered.machines[1]!.ready = false
    expect(resolveConversationFleetFolderMachine(draft(), offered)).toBe('mw0004')
    offered.machines[0]!.allowed = false
    expect(() => resolveConversationFleetFolderMachine(draft(), offered)).toThrow(
      'No ready fleet machine'
    )
  })

  it.each([false, undefined])(
    'refuses unsupported source snapshots (%s) and selects a host after its capability upgrade',
    (sourceSnapshot) => {
      const offered = inventory()
      offered.machines.forEach((host) => {
        if (sourceSnapshot === undefined) {
          delete host.execution_capabilities[0]!.source_snapshot
        } else {
          host.execution_capabilities[0]!.source_snapshot = sourceSnapshot
        }
      })
      expect(() => resolveConversationFleetFolderMachine(draft(), offered)).toThrow(
        'No ready fleet machine'
      )
      expect(() =>
        resolveConversationFleetFolderMachine(draft(), offered, { selectedMachine: 'mw0003' })
      ).toThrow('mw0003 cannot run')
      offered.machines[0]!.execution_capabilities[0]!.source_snapshot = true
      expect(resolveConversationFleetFolderMachine(draft(), offered)).toBe('mw0004')
    }
  )

  it('requires snapshot and pinned-input support on the same exact capability row', () => {
    const offered = inventory()
    offered.machines.forEach((host) => {
      const capability = host.execution_capabilities[0]!
      capability.source_snapshot = false
      host.execution_capabilities.push({
        ...capability,
        source_snapshot: true,
        pinned_task_inputs: false
      })
    })
    expect(() => resolveConversationFleetFolderMachine(draft(), offered)).toThrow(
      'No ready fleet machine'
    )
  })

  it('allows an explicitly selected capable busy host to queue, preserving the selection', () => {
    const offered = inventory()
    offered.machines[1]!.ready = false
    expect(
      resolveConversationFleetFolderMachine(draft(), offered, { selectedMachine: 'mw0003' })
    ).toBe('mw0003')
    offered.machines[1]!.allowed = false
    expect(() =>
      resolveConversationFleetFolderMachine(draft(), offered, { selectedMachine: 'mw0003' })
    ).toThrow('mw0003 cannot run')
  })

  it.each([
    'available',
    'resume',
    'readonly',
    'native_execution',
    'pinned_task_inputs',
    'folder_workspace'
  ] as const)('requires %s support for folder jobs', (flag) => {
    const offered = inventory()
    offered.machines.forEach((host) => {
      host.execution_capabilities[0]![flag] = false
    })
    expect(() => resolveConversationFleetFolderMachine(draft(), offered)).toThrow(
      'No ready fleet machine'
    )
  })

  it('requires every parallel and follow-on provider to fit on the same host', () => {
    const plan = draft()
    plan.after = [
      {
        key: 'review',
        kind: 'agent',
        actor: { agent: 'claude', effort: 'high' },
        presetId: 'verify',
        instructions: 'Verify result.',
        rounds: 1
      }
    ]
    const offered = inventory()
    offered.machines[1]!.execution_capabilities[1]!.readonly = false
    expect(resolveConversationFleetFolderMachine(plan, offered)).toBe('mw0004')
    offered.machines[0]!.execution_capabilities[1]!.efforts = []
    expect(() => resolveConversationFleetFolderMachine(plan, offered)).toThrow(
      'No ready fleet machine'
    )
  })

  it('uses the same workspace preset actor defaults as workflow compilation', () => {
    const offered = inventory()
    offered.models.push({
      ...offered.models[0]!,
      id: 'codex:custom-model',
      model: 'custom-model',
      default: false
    })
    offered.machines[0]!.execution_capabilities[0]!.models.push('custom-model')
    const options = {
      sourceWorkspacePath: '/source',
      settings: {
        sessionActionPresetsByWorkspace: {
          '/source': {
            improve: { actor: { agent: 'codex' as const, model: 'custom-model', effort: 'high' } }
          }
        }
      }
    }
    expect(resolveConversationFleetFolderMachine(draft(), offered, options)).toBe('mw0004')
  })

  it('refuses unknown models and efforts without substituting defaults', () => {
    const plan = draft()
    const first = plan.recipients[0]!
    if (first.kind !== 'agent') {
      throw new Error('fixture')
    }
    first.model = 'unknown'
    expect(() => resolveConversationFleetFolderMachine(plan, inventory())).toThrow('not advertised')
    delete first.model
    first.effort = 'unsupported'
    expect(() => resolveConversationFleetFolderMachine(plan, inventory())).toThrow(
      'does not support'
    )
  })

  it('uses the exact ready machine capability when the global seat summary is unavailable', () => {
    const offered = inventory()
    offered.models[0]!.seat_ready = null
    expect(resolveConversationFleetFolderMachine(draft(), offered)).toBe('mw0003')
    offered.machines.forEach((host) => {
      host.execution_capabilities[0]!.available = false
    })
    expect(() => resolveConversationFleetFolderMachine(draft(), offered)).toThrow(
      'No ready fleet machine'
    )
  })
})
