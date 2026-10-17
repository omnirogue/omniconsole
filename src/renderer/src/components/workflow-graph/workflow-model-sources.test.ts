import { describe, expect, it } from 'vitest'
import type { LocalWorkflowSeatCatalog } from '../../../../shared/local-workflow-seats'
import type { ModelLineage } from '../../../../shared/model-lineage'
import {
  seatableOpenRouterModels,
  workflowModelDefaults,
  workflowModelLabel,
  workflowModelPlanCatalog,
  workflowModelSources
} from './workflow-model-sources'

const model = (
  id: string,
  label: string,
  lineage: ModelLineage,
  isDefault = false,
  note?: string
) => ({
  catalog: { id, label, isDefault, options: [], ...(note ? { description: note } : {}) },
  resolvedModelId: id,
  lineage
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
const catalog = [
  entry('claude', [model('opus', 'Opus', 'anthropic', true), model('haiku', 'Haiku', 'anthropic')]),
  entry('grok', [model('grok-4.6', 'Grok 4.6', 'xai', true)]),
  entry('openrouter', [model('deepseek/chat', 'DeepSeek', 'deepseek')]),
  entry('ollama', [
    model('qwen3:8b', 'qwen3:8b', 'alibaba', false, '5.2 GB'),
    model('phi4:latest', 'phi4:latest', 'unknown')
  ]),
  entry('codex', [model('gpt-5.6-sol', 'GPT-5.6 Sol', 'openai', true)])
]
const team = (['claude', 'grok', 'openrouter', 'ollama'] as const).map((agent) => ({
  id: agent,
  agent,
  accountId: `system:${agent}`
}))
const price = { contextLength: 1, tools: true, structuredOutputs: true }

describe('workflow model sources', () => {
  const sources = workflowModelSources(catalog, team)

  it('lists every seated family with all its models, Ollama without unplaceable ones', () => {
    expect(sources.map((source) => [source.route, source.models.map((entry) => entry.id)])).toEqual(
      [
        ['claude', ['opus', 'haiku']],
        ['grok', ['grok-4.6']],
        ['openrouter', []],
        ['ollama', ['qwen3:8b']]
      ]
    )
    expect(sources[3].models[0].note).toBe('5.2 GB')
    expect(workflowModelDefaults(sources)).toEqual({ claude: 'opus', grok: 'grok-4.6' })
  })

  it('names a model the way a person reads it', () => {
    expect(workflowModelLabel({ route: 'claude' }, sources)).toBe('Opus')
    expect(workflowModelLabel({ route: 'claude', model: 'haiku' }, sources)).toBe('Haiku')
    expect(workflowModelLabel({ route: 'claude', model: 'opus-9' }, sources)).toBe(
      'Claude · opus-9'
    )
    // A family this computer does not seat still reads by its usual name.
    expect(workflowModelLabel({ route: 'gemini', model: 'gemini-3.8-flash' }, sources)).toBe(
      'Gemini 3.8 Flash'
    )
    expect(
      workflowModelLabel({ route: 'openrouter', model: 'deepseek/deepseek-v4-flash' }, sources)
    ).toBe('deepseek-v4-flash')
    expect(workflowModelLabel({ route: 'ollama', model: 'hf.co/org/Qwen3-GGUF:Q4' }, sources)).toBe(
      'org/Qwen3-GGUF:Q4'
    )
    expect(workflowModelLabel({ route: 'codex' }, sources)).toBe('Codex')
  })

  it('offers the plan agent free models first, then the cheapest, and only seatable ones', () => {
    const openrouter = [
      { ...price, id: 'anthropic/opus', name: 'Opus', promptPrice: 5e-6, completionPrice: 2.5e-5 },
      { ...price, id: 'mistralai/nemo', name: 'Nemo', promptPrice: 1.9e-8, completionPrice: 3e-8 },
      { ...price, id: 'qwen/free', name: 'Qwen', promptPrice: 0, completionPrice: 0 },
      { ...price, id: 'mystery/free', name: 'Mystery', promptPrice: 0, completionPrice: 0 },
      {
        ...price,
        id: 'deepseek/text',
        name: 'Text',
        promptPrice: 0,
        completionPrice: 0,
        structuredOutputs: false
      }
    ]
    expect(seatableOpenRouterModels(openrouter).map((entry) => entry.id)).toEqual([
      'anthropic/opus',
      'mistralai/nemo',
      'qwen/free'
    ])
    const plan = workflowModelPlanCatalog(sources, openrouter)
    expect(plan.openrouter.map((entry) => entry.id)).toEqual([
      'qwen/free',
      'mistralai/nemo',
      'anthropic/opus'
    ])
    expect(plan.ollama).toEqual(['qwen3:8b'])
    expect(plan.families.map((family) => family.route)).toEqual(['claude', 'grok'])
  })
})
