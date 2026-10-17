import { describe, expect, it } from 'vitest'
import { normalizeWorkflowCheck } from './workflow-check-normalize'
import type { WorkflowCheck, WorkflowSpec } from './workflow-graph'
import { normalizeWorkflowSpec } from './workflow-graph-normalize'
import { workflowTemplate } from './workflow-graph-templates'
import { planWorkflowCalls } from './workflow-graph-topology'
import { validateWorkflowSpec } from './workflow-graph-validate'
import { workflowImproveHostCalls } from './workflow-improve-host-calls'

const ROUTES = ['claude', 'codex', 'grok'] as const

function improve(check?: WorkflowCheck, candidates = 1): WorkflowSpec {
  const spec = workflowTemplate('improve', ROUTES)
  return {
    ...spec,
    steps: spec.steps.map((step) =>
      step.id === 'improve'
        ? { ...step, agents: Array.from({ length: candidates }, () => step.agents[0]!) }
        : step
    ),
    repeat: { ...spec.repeat!, ...(check ? { check } : {}) }
  }
}

describe('an Improve check with practice cases', () => {
  it('keeps the cases one line each and clamps the time limit', () => {
    const spec = normalizeWorkflowSpec(
      improve({
        command: ' node t.mjs {case} ',
        cases: [' a ', '', 'b\nc', 7 as unknown as string],
        timeoutSeconds: 1
      }),
      ROUTES
    )
    expect(spec.repeat?.check).toEqual({
      command: 'node t.mjs {case}',
      cases: ['a', 'b c'],
      timeoutSeconds: 5
    })
    expect(
      normalizeWorkflowCheck({ command: 'x', timeoutSeconds: 99_999 }, true).check?.timeoutSeconds
    ).toBe(1_800)
  })

  it('never keeps practice fields on a check that is not Improve', () => {
    expect(
      normalizeWorkflowCheck({ command: 'npm test', cases: ['a'], timeoutSeconds: 30 })
    ).toEqual({ check: { command: 'npm test' } })
  })

  it('asks for a practice case when the command uses {case}', () => {
    const problems = (check: WorkflowCheck) =>
      validateWorkflowSpec(improve(check), { available: ROUTES }).problems.map(
        (problem) => problem.message
      )
    expect(problems({ command: 'node t.mjs {case}' })).toContain(
      'The test command uses {case}: add at least one practice case, one per line.'
    )
    expect(problems({ command: 'node t.mjs {case}', cases: ['a'] })).toEqual([])
  })

  it('counts version checks as host calls only when rules-2 fields are set', () => {
    const plain = planWorkflowCalls(improve({ command: 'npm test' }, 3))
    expect(plain.hostTotal).toBe(0)
    expect(planWorkflowCalls(improve(undefined, 3))).toEqual(plain)
    for (const check of [
      { command: 'npm test', cases: ['a'] },
      { command: 'npm test', timeoutSeconds: 30 }
    ]) {
      const planned = planWorkflowCalls(improve(check, 3))
      expect(workflowImproveHostCalls(improve(check, 3))).toBe(6 * 3)
      expect(planned).toMatchObject({
        hostTotal: 18,
        agentTotal: plain.agentTotal,
        total: plain.total + 18
      })
      expect(planned.perStep.improve).toBe(plain.perStep.improve! + 18)
    }
  })

  it('keeps the largest Improve with practice cases inside the call limit', () => {
    const spec = improve({ command: 'npm test', cases: ['a'] }, 7)
    const widest = { ...spec, repeat: { ...spec.repeat!, maxRounds: 10 } }
    expect(planWorkflowCalls(widest)).toMatchObject({ hostTotal: 70 })
    expect(planWorkflowCalls(widest).total).toBeLessThanOrEqual(200)
    expect(validateWorkflowSpec(widest, { available: ROUTES }).problems).toEqual([])
  })
})
