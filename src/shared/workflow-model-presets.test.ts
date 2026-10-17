import { describe, expect, it } from 'vitest'
import { modelLineage, mayIssueVerdict } from './model-lineage'
import { applyWorkflowModelPreset, workflowCurrentModels } from './workflow-model-presets'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { validateWorkflowSpec } from './workflow-graph-validate'
import { workflowTemplate } from './workflow-graph-templates'
import { workflowSetImprove } from './workflow-graph-improve'
import { workflowSetFind } from './workflow-graph-find'

const spec = () =>
  normalizeWorkflowSpec({
    steps: [
      { id: 'make', kind: 'do', agents: [{ route: 'claude' }, { route: 'codex' }], inputs: [] },
      { id: 'judge', kind: 'rank', agents: [{ route: 'grok' }], inputs: ['make'] }
    ]
  })
describe('OpenRouter families and model presets', () => {
  it.each([
    ['deepseek/deepseek-r1-distill-qwen-32b', 'deepseek'],
    ['meta-llama/llama', 'meta'],
    ['mistralai/mistral', 'mistral'],
    ['z-ai/glm', 'zhipu'],
    ['minimax/minimax', 'minimax'],
    ['moonshotai/kimi', 'moonshot'],
    ['qwen/qwen3', 'alibaba'],
    ['unknown/claude', 'unknown']
  ])('uses the vendor for %s', (model, lineage) => {
    expect(modelLineage('openrouter', model)).toBe(lineage)
  })
  it('refuses Google and unknown judges', () => {
    expect(mayIssueVerdict('openrouter', 'google/gemini')).toBe(false)
    expect(mayIssueVerdict('openrouter', 'unknown/gpt')).toBe(false)
    expect(mayIssueVerdict('openrouter', 'deepseek/deepseek-r1')).toBe(true)
  })
  it('rotates models and skips ineligible judges while preserving instructions', () => {
    const result = applyWorkflowModelPreset(spec(), [
      { route: 'openrouter', model: 'google/gemini' },
      { route: 'openrouter', model: 'deepseek/chat' }
    ])
    expect(result.spec.steps[0].agents.map((agent) => agent.model)).toEqual([
      'google/gemini',
      'deepseek/chat'
    ])
    expect(result.spec.steps[1].agents[0].model).toBe('deepseek/chat')
    expect(workflowCurrentModels(result.spec)).toHaveLength(2)
    const google = applyWorkflowModelPreset(spec(), [
      { route: 'openrouter', model: 'google/gemini' }
    ])
    expect(google.unchanged).toEqual(['judge'])
    expect(google.spec.steps[1]).toEqual(spec().steps[1])
  })
  it('warns for one family across routes but accepts different families on OpenRouter', () => {
    const same = spec()
    same.steps[0].agents = [{ route: 'claude' }]
    same.steps[1].agents = [{ route: 'openrouter', model: 'anthropic/claude-sonnet' }]
    expect(
      validateWorkflowSpec(same).warnings.some((warning) =>
        warning.message.includes('same model families')
      )
    ).toBe(true)
    same.steps[0].agents = [{ route: 'openrouter', model: 'deepseek/chat' }]
    expect(
      validateWorkflowSpec(same).warnings.some((warning) =>
        warning.message.includes('same model families')
      )
    ).toBe(false)
    same.steps[1].agents = [{ route: 'openrouter', model: 'google/gemini' }]
    expect(validateWorkflowSpec(normalizeWorkflowSpec(same)).problems.length).toBeGreaterThan(0)
  })
})

it('keeps the selected OpenRouter rotation when candidate counts change', () => {
  const models = [
    { route: 'openrouter' as const, model: 'deepseek/chat' },
    { route: 'openrouter' as const, model: 'qwen/chat' }
  ]
  const improve = applyWorkflowModelPreset(
    workflowTemplate('improve', ['claude', 'codex'], { count: 2 }),
    models
  ).spec
  const expanded = workflowSetImprove(improve, { candidates: 3 }, ['claude', 'codex', 'openrouter'])
  expect(
    expanded.steps[0].agents.every((agent) => agent.route === 'openrouter' && !!agent.model)
  ).toBe(true)
  const find = applyWorkflowModelPreset(workflowTemplate('find', ['claude', 'codex']), models).spec
  const more = workflowSetFind(find, { count: 120 }, ['claude', 'codex', 'openrouter'])
  expect(more.steps[0].agents.every((agent) => agent.route === 'openrouter' && !!agent.model)).toBe(
    true
  )
})
