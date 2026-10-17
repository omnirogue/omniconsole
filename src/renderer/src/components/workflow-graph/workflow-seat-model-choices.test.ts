import { describe, expect, it } from 'vitest'
import type { LocalWorkflowSeatCatalog } from '../../../../shared/local-workflow-seats'
import { workflowSeatModelChoices, workflowSeatModelOptions } from './workflow-seat-model-choices'

const model = (id: string, label: string, isDefault = false) => ({
  catalog: { id, label, isDefault, options: [] },
  resolvedModelId: id,
  lineage: 'anthropic' as const
})

const entry = (
  agent: LocalWorkflowSeatCatalog['agent'],
  models: LocalWorkflowSeatCatalog['models']
): LocalWorkflowSeatCatalog => ({
  agent,
  accountId: `system:${agent}`,
  accountLabel: agent,
  accountHome: '/home',
  policyRevision: 'rev',
  models
})

describe('workflow seat model choices', () => {
  const catalog = [
    entry('claude', [
      model('opus', 'Opus', true),
      model('sonnet', 'Sonnet'),
      model('claude-opus-5-5[1m]', 'Opus 5.5 (1M context)')
    ]),
    entry('grok', [model('grok-4.6', 'Grok 4.6', true)])
  ]
  const team = [
    { id: 'claude', agent: 'claude' as const, accountId: 'system:claude' },
    { id: 'grok', agent: 'grok' as const, accountId: 'system:grok' }
  ]

  it('offers the 1M Opus in the Claude picker and no picker for one-model families', () => {
    const choices = workflowSeatModelChoices(catalog, team)
    expect(choices.claude?.map((choice) => choice.id)).toEqual([
      'opus',
      'sonnet',
      'claude-opus-5-5[1m]'
    ])
    expect(choices.grok).toBeUndefined()
  })

  it('shows the default when unnamed and keeps a spec-named model it does not offer', () => {
    const claude = workflowSeatModelChoices(catalog, team).claude!
    expect(workflowSeatModelOptions(claude, undefined).value).toBe('opus')
    expect(workflowSeatModelOptions(claude, 'claude-opus-5-5[1m]').options).toHaveLength(3)
    expect(workflowSeatModelOptions(claude, 'haiku').options.at(-1)).toEqual({
      value: 'haiku',
      label: 'haiku'
    })
  })
})
