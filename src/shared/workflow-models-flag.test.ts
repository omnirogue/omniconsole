import { describe, expect, it } from 'vitest'
import { localWorkflowRunSpec } from './local-workflow-run-request'
import { WORKFLOW_ROUTES } from './workflow-graph'
import { workflowModelsFlagPlan } from './workflow-models-flag'

const run = (models: string, template: 'discover' | 'council' = 'discover') =>
  localWorkflowRunSpec({ template, prompt: 'p', models }, WORKFLOW_ROUTES)
const agents = (spec: ReturnType<typeof run>, id: string) =>
  spec.steps
    .find((step) => step.id === id)!
    .agents.map((agent) => `${agent.route}:${agent.model ?? ''}`)

describe('--models', () => {
  it('reads a tier for every step, per-step tiers and combos', () => {
    expect(workflowModelsFlagPlan('cheap')).toEqual({ steps: { '*': { tier: 'cheap' } } })
    expect(workflowModelsFlagPlan('*=cheap; report=frontier')).toEqual({
      steps: { '*': { tier: 'cheap' }, report: { tier: 'frontier' } }
    })
    expect(
      workflowModelsFlagPlan(
        'find=claude:opus,codex,openrouter:deepseek/deepseek-v4-flash,ollama:qwen3:8b,cheap'
      )
    ).toEqual({
      steps: {
        find: {
          exact: true,
          agents: [
            { route: 'claude', model: 'opus' },
            { route: 'codex' },
            { route: 'openrouter', model: 'deepseek/deepseek-v4-flash' },
            { route: 'ollama', model: 'qwen3:8b' },
            { tier: 'cheap' }
          ]
        }
      }
    })
  })

  it('names what is wrong with the flag', () => {
    expect(() => workflowModelsFlagPlan('find=')).toThrow('is not <step>=<models>')
    expect(() => workflowModelsFlagPlan('find=gpt')).toThrow('"gpt" is not a tier')
    expect(() => workflowModelsFlagPlan('find=claude:')).toThrow('"claude:" is not a tier')
    expect(() => workflowModelsFlagPlan('find=cheap;find=frontier')).toThrow('named twice')
    expect(() => workflowModelsFlagPlan(' ; ')).toThrow('Name a tier')
  })

  it('lays tiers and a multi-provider combo over Discover, changing only models', () => {
    const plain = localWorkflowRunSpec({ template: 'discover', prompt: 'p' }, WORKFLOW_ROUTES)
    const spec = run(
      '*=cheap;find=claude:opus,codex,grok,openrouter:deepseek/deepseek-v4-flash,ollama:qwen3:8b;report=frontier'
    )
    expect(agents(spec, 'find')).toEqual([
      'claude:opus',
      'codex:',
      'grok:',
      'openrouter:deepseek/deepseek-v4-flash',
      'ollama:qwen3:8b'
    ])
    expect(agents(spec, 'brief')).toEqual(['claude:claude-haiku-5-5'])
    expect(agents(spec, 'report')).toEqual(['claude:opus'])
    // Lenses repeat over the larger combo; everything that is not a model is the template's.
    expect(spec.steps[2].agents.map((agent) => agent.angle)).toEqual([
      'lens 1 from the brief',
      'lens 2 from the brief',
      'lens 3 from the brief',
      'lens 1 from the brief',
      'lens 2 from the brief'
    ])
    expect(spec.steps.map((step) => step.instruction)).toEqual(
      plain.steps.map((step) => step.instruction)
    )
    expect(spec.repeat).toEqual(plain.repeat)
  })

  it('refuses a step the template does not have and a model that may not decide', () => {
    expect(() => run('nope=cheap')).toThrow('--models: These are not steps of this workflow: nope')
    expect(() => run('report=gemini')).toThrow('never review, rank or synthesize')
    expect(() => run('chair=ollama:gemma4:e2b', 'council')).toThrow(
      'never review, rank or synthesize'
    )
  })
})
