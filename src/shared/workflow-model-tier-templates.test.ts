import { describe, expect, it, vi } from 'vitest'
import { createLocalWorkflowGraphDraft } from './local-workflow-draft'
import { localWorkflowAnchorSchema } from './local-workflow-session-schema'
import { WORKFLOW_ROUTES, type WorkflowSpec } from './workflow-graph'
import { findWorkflow, workflowSetFind } from './workflow-graph-find'
import { families, improveWorkflow, workflowSetImprove } from './workflow-graph-improve'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { validateWorkflowSpec } from './workflow-graph-validate'
import { applyWorkflowModelPlan, compileWorkflowModelPlan } from './workflow-model-plan'
import {
  DEFAULT_WORKFLOW_MODEL_TIERS as tiers,
  applyWorkflowModelTier,
  withWorkflowStepModels
} from './workflow-model-tiers'
import { workflowModelsFlagPlan } from './workflow-models-flag'

const all = WORKFLOW_ROUTES
const defaults = { claude: 'opus', codex: 'gpt-5.6-sol', grok: 'grok-4.6' }
const models = (spec: WorkflowSpec, id: string) =>
  spec.steps
    .find((step) => step.id === id)!
    .agents.map((agent) => `${agent.route}:${agent.model ?? ''}`)
const find = () => normalizeWorkflowSpec(findWorkflow(all), all)
const improve = () => normalizeWorkflowSpec(improveWorkflow(all), all)

describe('tiers and combos on the templates', () => {
  it('never rotates a template onto a family that has no default model', () => {
    expect(families(all)).toEqual(['claude', 'codex', 'grok', 'gemini'])
    expect(find().steps.flatMap((step) => step.agents.map((agent) => agent.route))).not.toContain(
      'ollama'
    )
    // Improve asked for one candidate from each family: Ollama is not a family to rotate onto.
    const multi = workflowSetImprove(improve(), { candidates: 6, models: { mode: 'multi' } }, all)
    expect(models(multi, 'improve')).toEqual([
      'claude:',
      'codex:',
      'grok:',
      'gemini:',
      'claude:',
      'codex:'
    ])
  })

  it('keeps a tier and a combo on Find the best when another option changes', () => {
    const cheap = applyWorkflowModelTier(find(), {
      tier: 'cheap',
      tiers,
      available: all,
      defaults
    }).spec
    const before = models(cheap, 'options')
    expect(before).toContain('claude:claude-haiku-5-5')
    expect(models(workflowSetFind(cheap, { keep: 20 }, all), 'options')).toEqual(before)
    const combo = withWorkflowStepModels(
      find(),
      'options',
      [
        { route: 'claude', model: 'opus' },
        { route: 'ollama', model: 'qwen3:8b' },
        { route: 'openrouter', model: 'qwen/qwen3.8-27b:free' }
      ],
      defaults
    )
    // The batches come back (one list call each) and cycle the combo: no other family slips in.
    expect(models(workflowSetFind(combo, { top: 3 }, all), 'options')).toEqual([
      'claude:',
      'ollama:qwen3:8b',
      'openrouter:qwen/qwen3.8-27b:free',
      'claude:',
      'ollama:qwen3:8b'
    ])
  })

  it('puts a one-agent judge on another family than the work it judges, on the same tier', () => {
    const cheap = applyWorkflowModelTier(improve(), {
      tier: 'cheap',
      tiers,
      available: all,
      defaults
    })
    expect(models(cheap.spec, 'improve')).toEqual(['claude:claude-haiku-5-5'])
    expect(models(cheap.spec, 'judge')).toEqual(['codex:gpt-6-luna'])
    expect(validateWorkflowSpec(cheap.spec, { available: all }).warnings).toEqual([])
    // The same through --models and through a described plan: Frontier leads with Argon on work
    // and puts the first non-author judge (Opus) on the Judge step.
    const planned = applyWorkflowModelPlan(improve(), workflowModelsFlagPlan('frontier'), {
      tiers,
      available: all,
      defaults
    })
    expect('spec' in planned && models(planned.spec, 'improve')).toEqual(['gemini:gemini-4-argon'])
    expect('spec' in planned && models(planned.spec, 'judge')).toEqual(['claude:'])
  })

  it('refuses web pages with a local model, as with OpenRouter', () => {
    const spec = normalizeWorkflowSpec(
      {
        steps: [
          {
            id: 'read',
            kind: 'do',
            agents: [{ route: 'ollama', model: 'qwen3:8b' }],
            inputs: [],
            web: { urls: ['https://example.com/a'] }
          }
        ]
      },
      all
    )
    expect(
      validateWorkflowSpec(spec, { available: all }).problems.map((entry) => entry.message)
    ).toContain("Reading web pages isn't available with Ollama models yet.")
  })

  it('keeps a workflow tab whose team has an Ollama seat', () => {
    const team = [
      { id: 'claude', agent: 'claude' as const, accountId: 'system:claude' },
      { id: 'ollama', agent: 'ollama' as const, accountId: 'system:ollama' }
    ]
    const anchor = {
      preset: 'council',
      prompt: 'p',
      draft: createLocalWorkflowGraphDraft({ prompt: 'p', graph: { spec: find(), team } })
    }
    const parsed = localWorkflowAnchorSchema.safeParse(anchor)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.draft?.graph?.team.map((seat) => seat.agent)).toEqual([
      'claude',
      'ollama'
    ])
  })
})

describe('plan and flag edge cases', () => {
  const context = { tiers, available: all, defaults }
  it('does not shrink a step when "exact" comes with no agents', () => {
    const plan = applyWorkflowModelPlan(
      find(),
      { steps: { options: { tier: 'cheap', agents: [], exact: true } } },
      context
    )
    expect('spec' in plan && plan.spec.steps[0].agents).toHaveLength(find().steps[0].agents.length)
  })
  it('treats a step named like an object property as a step', () => {
    expect(workflowModelsFlagPlan('constructor=cheap;__proto__=frontier').steps).toEqual({
      constructor: { tier: 'cheap' },
      ['__proto__']: { tier: 'frontier' }
    })
    const plan = applyWorkflowModelPlan(
      find(),
      workflowModelsFlagPlan('constructor=cheap'),
      context
    )
    expect('problems' in plan && plan.problems[0]).toContain(
      'not steps of this workflow: constructor'
    )
  })
  it('does not ask again when the agent gave no answer at all', async () => {
    const ask = vi.fn().mockResolvedValue('')
    const result = await compileWorkflowModelPlan({
      description: 'cheap',
      spec: find(),
      context,
      ask
    })
    expect(ask).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ error: 'The answer was not a JSON object with "steps".' })
  })
})
