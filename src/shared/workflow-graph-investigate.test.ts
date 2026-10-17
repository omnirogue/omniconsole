import { describe, expect, it } from 'vitest'
import { workflowRouteMayJudge, workflowKindJudges, type WorkflowRoute } from './workflow-graph'
import { INVESTIGATE_ANGLES, INVESTIGATE_SPLIT_INSTRUCTION } from './workflow-graph-investigate'
import { workflowTemplate } from './workflow-graph-templates'
import { planWorkflowCalls } from './workflow-graph-topology'
import { validateWorkflowSpec } from './workflow-graph-validate'

const routesOf = (routes: readonly WorkflowRoute[], id: string) =>
  workflowTemplate('investigate', routes)
    .steps.find((step) => step.id === id)!
    .agents.map((agent) => agent.route)

const finalInstruction = (routes: readonly WorkflowRoute[]) =>
  workflowTemplate('investigate', routes).steps.find((step) => step.id === 'answer')!.instruction

describe('the Investigate template', () => {
  it('splits into three angles, then three investigators, one synthesis, two checks and the answer', () => {
    const spec = workflowTemplate('investigate', ['claude', 'codex', 'grok'])
    expect(spec.template).toBe('investigate')
    expect(spec.steps.map((step) => [step.id, step.kind])).toEqual([
      ['split', 'do'],
      ['investigate', 'do'],
      ['synthesis', 'synthesize'],
      ['factcheck', 'review'],
      ['skeptic', 'review'],
      ['answer', 'synthesize']
    ])
    expect(INVESTIGATE_SPLIT_INSTRUCTION).toContain('## Angle 1, ## Angle 2, ## Angle 3')
    const investigate = spec.steps.find((step) => step.id === 'investigate')!
    expect(investigate.agents.map((agent) => agent.angle)).toEqual([...INVESTIGATE_ANGLES])
    expect(investigate.list).toEqual({ maxItems: 5, evidence: true })
    expect(investigate.inputs).toEqual(['split'])
    const factcheck = spec.steps.find((step) => step.id === 'factcheck')!
    expect(factcheck.forEach).toEqual({ step: 'investigate', limit: 15 })
    expect(factcheck.inputs).toContain('synthesis')
    expect(factcheck.escalate).toEqual({ max: 3, crossFamily: true, standIn: true })
    expect(spec.steps.find((step) => step.id === 'skeptic')!.inputs).toContain('synthesis')
    expect(spec.steps.at(-1)!.claimTable).toBe(true)
    expect(validateWorkflowSpec(spec).problems).toEqual([])
    expect(planWorkflowCalls(spec).agentTotal).toBe(28)
  })

  it('takes investigators from three families and checkers from families other than the writer', () => {
    const routes: WorkflowRoute[] = ['claude', 'codex', 'grok', 'gemini']
    expect(routesOf(routes, 'investigate')).toEqual(['claude', 'codex', 'grok'])
    expect(routesOf(routes, 'synthesis')).toEqual(['claude'])
    expect(routesOf(routes, 'factcheck')).toEqual(['codex', 'grok'])
    expect(routesOf(routes, 'skeptic')).toEqual(['grok'])
    expect(finalInstruction(routes)).not.toMatch(/model famil/)
    expect(validateWorkflowSpec(workflowTemplate('investigate', routes)).problems).toEqual([])
  })

  it('falls back with fewer families and says so in the answer', () => {
    expect(routesOf(['claude', 'codex'], 'investigate')).toEqual(['claude', 'codex', 'claude'])
    expect(routesOf(['claude', 'codex'], 'factcheck')).toEqual(['codex', 'claude'])
    expect(finalInstruction(['claude', 'codex'])).toContain(
      'Only 2 model families investigated, so the three angles are less independent'
    )
    const alone = workflowTemplate('investigate', ['claude'])
    expect(routesOf(['claude'], 'investigate')).toEqual(['claude', 'claude', 'claude'])
    expect(alone.steps.find((step) => step.id === 'factcheck')!.escalate).toBeUndefined()
    expect(finalInstruction(['claude'])).toContain('Only one model family investigated')
    expect(finalInstruction(['claude'])).toContain('No second model family could check the work')
    expect(validateWorkflowSpec(alone).problems).toEqual([])
    // The editor warns too: the checks are not independent of the work.
    expect(validateWorkflowSpec(alone).warnings.map((entry) => entry.stepId)).toContain('factcheck')
  })

  it.each([
    [['claude', 'codex', 'grok', 'gemini']],
    [['gemini', 'claude']],
    [['gemini']]
  ] as WorkflowRoute[][][])('never lets Gemini judge (%j)', (routes) => {
    const spec = workflowTemplate('investigate', routes)
    for (const step of spec.steps.filter((entry) => workflowKindJudges(entry.kind))) {
      expect(
        step.agents.every((agent) => workflowRouteMayJudge(agent.route, agent.model)),
        step.id
      ).toBe(true)
    }
  })
})
