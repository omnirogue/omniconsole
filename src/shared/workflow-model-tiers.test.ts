import { describe, expect, it } from 'vitest'
import { WORKFLOW_ROUTES, type WorkflowRoute } from './workflow-graph'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import {
  DEFAULT_WORKFLOW_MODEL_TIERS,
  WorkflowModelTiersSchema,
  applyWorkflowModelTier,
  normalizeWorkflowModelTiers,
  withWorkflowAgentModel,
  withWorkflowStepModels,
  workflowSpecTier,
  workflowStepTier
} from './workflow-model-tiers'

const all = WORKFLOW_ROUTES
const tiers = DEFAULT_WORKFLOW_MODEL_TIERS
const defaults = { claude: 'opus', codex: 'gpt-5.6-sol', grok: 'grok-4.6' }
const spec = normalizeWorkflowSpec(
  {
    steps: [
      {
        id: 'research',
        kind: 'do',
        agents: [{ route: 'claude', angle: 'security' }, { route: 'codex' }, { route: 'grok' }],
        inputs: []
      },
      {
        id: 'rank',
        kind: 'rank',
        agents: [{ route: 'claude' }, { route: 'codex' }],
        inputs: ['research']
      },
      {
        id: 'final',
        kind: 'synthesize',
        agents: [{ route: 'claude' }],
        inputs: ['research', 'rank']
      }
    ]
  },
  all
)
const models = (id: string, from = spec) =>
  from.steps
    .find((step) => step.id === id)!
    .agents.map((agent) => `${agent.route}:${agent.model ?? ''}`)

describe('workflow model tiers', () => {
  it('ships valid built-in lineups', () => {
    expect(WorkflowModelTiersSchema.safeParse(tiers).success).toBe(true)
  })

  it('puts a tier on every step: the lineup in order, judges only where a step decides', () => {
    const cheap = applyWorkflowModelTier(spec, { tier: 'cheap', tiers, available: all, defaults })
    expect(cheap.unchanged).toEqual([])
    expect(models('research', cheap.spec)).toEqual([
      'claude:claude-haiku-5-5',
      'codex:gpt-6-luna',
      'gemini:gemini-3.8-flash'
    ])
    // Gemini never ranks or synthesizes, so the judging steps take the other two.
    expect(models('rank', cheap.spec)).toEqual(['claude:claude-haiku-5-5', 'codex:gpt-6-luna'])
    expect(models('final', cheap.spec)).toEqual(['claude:claude-haiku-5-5'])
    expect(cheap.spec.steps[0].agents[0].angle).toBe('security')
    expect(workflowSpecTier(cheap.spec, tiers, defaults)).toBe('cheap')
  })

  it('changes one step and leaves the others, with a default model left unnamed', () => {
    const frontier = applyWorkflowModelTier(spec, {
      tier: 'frontier',
      tiers,
      available: all,
      defaults,
      stepId: 'final'
    })
    expect(models('final', frontier.spec)).toEqual(['claude:'])
    expect(models('research', frontier.spec)).toEqual(models('research'))
    expect(workflowStepTier(frontier.spec.steps[2], tiers, defaults)).toBe('frontier')
    expect(workflowSpecTier(frontier.spec, tiers, defaults)).toBeUndefined()
  })

  it('skips families this computer does not run and names the steps it could not change', () => {
    const only: WorkflowRoute[] = ['gemini']
    const applied = applyWorkflowModelTier(spec, {
      tier: 'cheap',
      tiers,
      available: only,
      defaults
    })
    expect(models('research', applied.spec)).toEqual([
      'gemini:gemini-3.8-flash',
      'gemini:gemini-3.8-flash',
      'gemini:gemini-3.8-flash'
    ])
    expect(applied.unchanged).toEqual(['rank', 'final'])
  })

  it('reads a step tier from its models: mixed steps have none, a shared model is the stronger tier', () => {
    expect(
      workflowStepTier({ agents: [{ route: 'claude', model: 'sonnet' }] }, tiers, defaults)
    ).toBe('standard')
    expect(workflowStepTier({ agents: [{ route: 'grok' }] }, tiers, defaults)).toBe('frontier')
    expect(
      workflowStepTier(
        { agents: [{ route: 'claude', model: 'haiku' }, { route: 'claude' }] },
        tiers,
        defaults
      )
    ).toBeUndefined()
  })

  it('runs a combo: exactly the chosen models, angles carried over, a synthesizer kept at one', () => {
    const combo = [
      { route: 'claude' as const, model: 'opus' },
      { route: 'codex' as const, model: 'gpt-6-astra' },
      { route: 'openrouter' as const, model: 'deepseek/deepseek-v4-flash' },
      { route: 'ollama' as const, model: 'qwen3:8b' }
    ]
    const next = withWorkflowStepModels(spec, 'research', combo, defaults)
    expect(models('research', next)).toEqual([
      'claude:',
      'codex:gpt-6-astra',
      'openrouter:deepseek/deepseek-v4-flash',
      'ollama:qwen3:8b'
    ])
    expect(next.steps[0].agents.map((agent) => agent.angle)).toEqual([
      'security',
      undefined,
      undefined,
      'security'
    ])
    expect(withWorkflowStepModels(spec, 'final', combo, defaults).steps[2].agents).toHaveLength(1)
  })

  it('changes one agent and keeps its angle', () => {
    const next = withWorkflowAgentModel(spec, 'research', 0, { route: 'ollama', model: 'qwen3:8b' })
    expect(next.steps[0].agents[0]).toEqual({
      route: 'ollama',
      model: 'qwen3:8b',
      angle: 'security'
    })
  })

  it('falls back tier by tier when a saved lineup does not parse', () => {
    const saved = normalizeWorkflowModelTiers({
      cheap: [{ route: 'ollama', model: 'qwen3:8b' }],
      standard: [],
      frontier: [{ route: 'openrouter' }]
    })
    expect(saved.cheap).toEqual([{ route: 'ollama', model: 'qwen3:8b' }])
    expect(saved.standard).toEqual(tiers.standard)
    expect(saved.frontier).toEqual(tiers.frontier)
  })
})
