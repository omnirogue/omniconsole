import { describe, expect, it, vi } from 'vitest'
import { WORKFLOW_ROUTES } from './workflow-graph'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import {
  applyWorkflowModelPlan,
  compileWorkflowModelPlan,
  workflowModelPlanPrompt,
  type WorkflowModelPlanContext
} from './workflow-model-plan'
import { DEFAULT_WORKFLOW_MODEL_TIERS } from './workflow-model-tiers'

const spec = normalizeWorkflowSpec(
  {
    steps: [
      {
        id: 'find',
        kind: 'do',
        title: 'Find',
        agents: [{ route: 'claude' }, { route: 'codex' }, { route: 'grok' }],
        inputs: []
      },
      {
        id: 'verify',
        kind: 'review',
        agents: [{ route: 'codex' }, { route: 'grok' }],
        inputs: ['find']
      },
      {
        id: 'report',
        kind: 'synthesize',
        agents: [{ route: 'claude' }],
        inputs: ['find', 'verify']
      }
    ]
  },
  WORKFLOW_ROUTES
)
const context: WorkflowModelPlanContext = {
  tiers: DEFAULT_WORKFLOW_MODEL_TIERS,
  available: WORKFLOW_ROUTES,
  defaults: { claude: 'opus', codex: 'gpt-5.6-sol', grok: 'grok-4.6', gemini: 'gemini-3.8-flash' },
  catalog: {
    families: [
      {
        route: 'claude',
        models: [
          { id: 'opus', label: 'Opus', isDefault: true },
          { id: 'sonnet', label: 'Sonnet' },
          { id: 'haiku', label: 'Haiku' },
          { id: 'claude-haiku-5-5', label: 'Haiku 5.5' }
        ]
      },
      { route: 'codex', models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', isDefault: true }] },
      {
        route: 'gemini',
        models: [{ id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', isDefault: true }]
      }
    ],
    openrouter: [{ id: 'qwen/qwen3.8-27b:free', promptPrice: 0, completionPrice: 0 }],
    ollama: ['qwen3:8b', 'gemma4:e2b']
  }
}
const agents = (plan: ReturnType<typeof applyWorkflowModelPlan>, id: string) =>
  'spec' in plan
    ? plan.spec.steps
        .find((step) => step.id === id)!
        .agents.map((agent) => `${agent.route}:${agent.model ?? ''}`)
    : plan.problems

describe('workflow model plan', () => {
  it('tells the agent the steps, the tiers and what this computer offers', () => {
    const prompt = workflowModelPlanPrompt({ description: 'make it cheap', spec, context })
    expect(prompt).toContain('- find (do, "Find", 3 agents): claude, codex, grok')
    expect(prompt).toContain(
      '- cheap: claude:claude-haiku-5-5, codex:gpt-6-luna, gemini:gemini-3.8-flash'
    )
    expect(prompt).toContain('- qwen/qwen3.8-27b:free: free / free')
    expect(prompt).toContain('- qwen3:8b')
    expect(prompt).toContain('Request:\nmake it cheap')
  })

  it('applies tiers by step with "*" for the rest, and only reports steps that changed', () => {
    const plan = applyWorkflowModelPlan(
      spec,
      { steps: { '*': { tier: 'cheap' }, report: { tier: 'frontier' } }, assumptions: ['x', 3] },
      context
    )
    // Gemini's only model is its default, so it stays unnamed.
    expect(agents(plan, 'find')).toEqual(['claude:claude-haiku-5-5', 'codex:gpt-6-luna', 'gemini:'])
    expect(agents(plan, 'verify')).toEqual(['claude:claude-haiku-5-5', 'codex:gpt-6-luna'])
    expect(agents(plan, 'report')).toEqual(['claude:'])
    expect('spec' in plan && plan.changed).toEqual(['find', 'verify'])
    expect('spec' in plan && plan.assumptions).toEqual(['x'])
  })

  it('runs a combo of providers on one step and leaves the others alone', () => {
    const plan = applyWorkflowModelPlan(
      spec,
      {
        steps: {
          find: {
            exact: true,
            agents: [
              { route: 'claude', model: 'Sonnet' },
              { route: 'codex' },
              { route: 'openrouter', model: 'qwen/qwen3.8-27b:free' },
              { route: 'ollama', model: 'qwen3:8b' },
              { tier: 'frontier' }
            ]
          }
        }
      },
      context
    )
    expect(agents(plan, 'find')).toEqual([
      'claude:sonnet',
      'codex:',
      'openrouter:qwen/qwen3.8-27b:free',
      'ollama:qwen3:8b',
      'gemini:gemini-4-argon'
    ])
    expect(agents(plan, 'verify')).toEqual(['codex:', 'grok:'])
  })

  it('refuses what cannot run, names why, and applies nothing', () => {
    const problems = (steps: Record<string, unknown>) => {
      const plan = applyWorkflowModelPlan(spec, { steps }, context)
      return 'problems' in plan ? plan.problems.join(' ') : ''
    }
    expect(problems({ nope: { tier: 'cheap' } })).toContain('not steps of this workflow: nope')
    expect(problems({ report: { agents: [{ route: 'gemini' }] } })).toContain(
      'never review, rank or synthesize'
    )
    expect(problems({ verify: { agents: [{ route: 'ollama', model: 'gemma4:e2b' }] } })).toContain(
      'never review, rank or synthesize'
    )
    expect(problems({ find: { agents: [{ route: 'ollama', model: 'llama9:1b' }] } })).toContain(
      'not an Ollama model installed'
    )
    expect(
      problems({ find: { agents: [{ route: 'openrouter', model: 'mystery/model' }] } })
    ).toContain('known family')
    expect(problems({ find: { agents: [{ route: 'claude', model: 'opus-9' }] } })).toContain(
      'does not offer "opus-9"'
    )
    expect(problems({ find: { tier: 'budget' } })).toContain('not a tier')
    expect(
      problems({ report: { exact: true, agents: [{ route: 'claude' }, { route: 'codex' }] } })
    ).toContain('at most 1 agent')
    expect(applyWorkflowModelPlan(spec, undefined, context)).toEqual({
      problems: ['The answer was not a JSON object with "steps".']
    })
  })

  it('leaves model ids to the host when no catalog is known (the CLI)', () => {
    const { catalog: _catalog, ...bare } = context
    const plan = applyWorkflowModelPlan(
      spec,
      {
        steps: {
          find: {
            exact: true,
            agents: [
              { route: 'ollama', model: 'llama9:1b' },
              { route: 'claude', model: 'opus-9' }
            ]
          }
        }
      },
      bare
    )
    expect(agents(plan, 'find')).toEqual(['ollama:llama9:1b', 'claude:opus-9'])
  })

  it('asks once more with the problems, then gives up with the first one', async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('{"steps":{"report":{"agents":[{"route":"gemini"}]}}}')
      .mockResolvedValueOnce('```json\n{"steps":{"report":{"tier":"standard"}}}\n```')
    const fixed = await compileWorkflowModelPlan({
      description: 'gemini writes the report',
      spec,
      context,
      ask
    })
    expect(ask.mock.calls[1][0]).toContain('never review, rank or synthesize')
    expect('spec' in fixed && fixed.spec.steps[2].agents).toEqual([
      { route: 'claude', model: 'sonnet' }
    ])
    const failing = await compileWorkflowModelPlan({
      description: 'x',
      spec,
      context,
      ask: async () => 'no json here'
    })
    expect(failing).toEqual({ error: 'The answer was not a JSON object with "steps".' })
  })
})
