import { describe, expect, it } from 'vitest'
import type { WorkflowCheck, WorkflowSpec } from './workflow-graph'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { workflowTemplate } from './workflow-graph-templates'
import { planWorkflowCalls } from './workflow-graph-topology'
import { validateWorkflowSpec } from './workflow-graph-validate'

const ROUTES = ['claude', 'codex', 'grok'] as const

function improve(population?: number, check?: WorkflowCheck, candidates = 3): WorkflowSpec {
  const spec = workflowTemplate('improve', ROUTES)
  return {
    ...spec,
    steps: spec.steps.map((step) =>
      step.id === 'improve'
        ? { ...step, agents: Array.from({ length: candidates }, () => step.agents[0]!) }
        : step
    ),
    repeat: {
      ...spec.repeat!,
      ...(check ? { check } : {}),
      ...(population !== undefined ? { population } : {})
    }
  }
}

describe('Improve: versions to build on each round', () => {
  it('saves 2 to 4, and never saves the default of one', () => {
    expect(normalizeWorkflowSpec(improve(3), ROUTES).repeat?.population).toBe(3)
    expect(normalizeWorkflowSpec(improve(9), ROUTES).repeat?.population).toBe(4)
    expect(normalizeWorkflowSpec(improve(1), ROUTES).repeat).not.toHaveProperty('population')
    expect(normalizeWorkflowSpec(improve(0), ROUTES).repeat).not.toHaveProperty('population')
    expect(normalizeWorkflowSpec(improve(), ROUTES).repeat).not.toHaveProperty('population')
  })

  it('refuses a number outside 1 to 4 in a spec that skipped normalizing', () => {
    expect(validateWorkflowSpec(improve(5), { available: ROUTES }).problems).toEqual([
      { message: 'Build on 1 to 4 versions each round.' }
    ])
    expect(validateWorkflowSpec(improve(4), { available: ROUTES }).problems).toEqual([])
  })

  it('adds no call: kept versions are neither made, checked nor judged again', () => {
    const check: WorkflowCheck = {
      command: 'npm test',
      cases: ['a'],
      apply: 'patch',
      sealed: { cases: ['z'] }
    }
    const widest = (population?: number): WorkflowSpec => {
      const spec = improve(population, check, 7)
      return { ...spec, repeat: { ...spec.repeat!, maxRounds: 10 } }
    }
    expect(planWorkflowCalls(widest(4))).toEqual(planWorkflowCalls(widest()))
    // Ten rounds of seven versions, "No change" and the two final tests: 73 host calls.
    expect(planWorkflowCalls(widest(4))).toMatchObject({ hostTotal: 73 })
    expect(planWorkflowCalls(widest(4)).total).toBeLessThanOrEqual(200)
    expect(validateWorkflowSpec(widest(4), { available: ROUTES }).problems).toEqual([])
  })
})
