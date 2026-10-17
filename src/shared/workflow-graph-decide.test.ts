import { describe, expect, it } from 'vitest'
import { workflowSetOneAnswer } from './workflow-graph-decide'
import { workflowTemplate } from './workflow-graph-templates'
import { describeWorkflow, planWorkflowCalls } from './workflow-graph-topology'
import { validateWorkflowSpec } from './workflow-graph-validate'

const ROUTES = ['claude', 'codex', 'grok'] as const

describe('the Decide template', () => {
  it('ships with one-answer routing off, as a valid workflow with a plain read-back', () => {
    const spec = workflowTemplate('decide', ROUTES)
    expect(spec.template).toBe('decide')
    expect(spec.oneAnswer).toBeUndefined()
    expect(spec.steps.map((step) => step.id)).toEqual([
      'frame',
      'options',
      'develop',
      'compare',
      'crux',
      'memo'
    ])
    expect(validateWorkflowSpec(spec).problems).toEqual([])
    expect(planWorkflowCalls(spec).total).toBe(37)
    expect(describeWorkflow(spec)[0]).toMatch(/^Frame: 1 agent works\.$/)
  })

  it('turns the one-answer route on and off without leaving anything behind', () => {
    const off = workflowTemplate('decide', ROUTES)
    const on = workflowSetOneAnswer(off, true, ROUTES)
    expect(on.oneAnswer).toEqual({ step: 'direct' })
    expect(on.steps[0]).toMatchObject({ id: 'direct', kind: 'do', agents: [{ route: 'claude' }] })
    expect(validateWorkflowSpec(on).problems).toEqual([])
    expect(describeWorkflow(on)[0]).toMatch(/^First, JEV checks whether the question has one/)
    expect(planWorkflowCalls(on).total).toBe(38)
    expect(workflowSetOneAnswer(on, false, ROUTES)).toEqual(off)
  })

  it('keeps the judges and the guard in families other than the developer where it can', () => {
    const spec = workflowTemplate('decide', ROUTES)
    const develop = spec.steps.find((step) => step.id === 'develop')!
    const compare = spec.steps.find((step) => step.id === 'compare')!
    expect(develop.agents.map((agent) => agent.route)).toEqual(['claude'])
    expect(compare.agents.map((agent) => agent.route)).toEqual(['codex', 'grok'])
    expect(spec.finalCheck).toEqual({ rank: 'compare', chair: 'memo', skeptic: 'frame' })
    // One family only: it still runs, and the editor warns that the judging is not independent.
    const alone = workflowTemplate('decide', ['claude'])
    expect(validateWorkflowSpec(alone).problems).toEqual([])
    expect(validateWorkflowSpec(alone).warnings.map((entry) => entry.stepId)).toContain('compare')
  })
})
