import { describe, expect, it } from 'vitest'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import {
  describeWorkflow,
  planWorkflowCalls,
  workflowFinishReserve
} from '../../../../shared/workflow-graph-topology'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { decideOneAnswerRoute } from '../../../../shared/workflow-one-answer'
import { createWorkflowProgramContext } from '../workflow-program-context'
import { runWorkflowGraphProgram } from './graph-program'
import { planWorkflowGraph } from './graph-plan'
import type { GraphCall } from './graph-plan-types'
import { configFor, drive, task, text } from './graph-test-harness'

const ROUTED: WorkflowSpec = {
  version: 1,
  title: 'Routed',
  template: 'custom',
  oneAnswer: { step: 'direct' },
  steps: [
    {
      id: 'direct',
      kind: 'do',
      title: 'One answer',
      instruction: 'Answer it.',
      agents: [{ route: 'claude' }],
      inputs: []
    },
    {
      id: 'answer',
      kind: 'do',
      title: 'Opinions',
      instruction: '',
      agents: [{ route: 'claude' }, { route: 'codex' }],
      inputs: []
    },
    {
      id: 'final',
      kind: 'synthesize',
      title: 'Final',
      instruction: '',
      agents: [{ route: 'claude' }],
      inputs: ['answer']
    }
  ]
}

const answering = (route: unknown) => (call: GraphCall) =>
  call.route ? route : text(call.stepId === 'direct' ? 'Direct' : `From ${call.id}`)
const agentCalls = (calls: GraphCall[]) => calls.filter((call) => !call.route && !call.jev)

describe('one-answer routing', () => {
  it('decides only a sure yes for one model, and never fails open', () => {
    // Both ends of the unsure band are unsure: only a reading above it routes.
    expect(decideOneAnswerRoute({ noul: 0.651 }).route).toBe('one-answer')
    expect(decideOneAnswerRoute({ noul: 0.65 })).toMatchObject({ route: 'full', reason: 'unsure' })
    expect(decideOneAnswerRoute({ noul: 0.35 })).toMatchObject({ route: 'full', reason: 'unsure' })
    expect(decideOneAnswerRoute({ noul: 0.349 })).toMatchObject({ route: 'full', reason: 'open' })
    expect(decideOneAnswerRoute({ noul: Number.NaN })).toMatchObject({ reason: 'unavailable' })
    expect(decideOneAnswerRoute({ failed: 'no key' })).toEqual({
      route: 'full',
      reason: 'unavailable',
      detail: 'no key'
    })
  })

  it('ends at the one answer when JEV is sure, and runs nothing else', () => {
    const plan = drive(ROUTED, answering({ noul: 0.92 }))
    expect(plan.route).toEqual({ route: 'one-answer', reason: 'one-answer', noul: 0.92 })
    expect(agentCalls(plan.calls).map((call) => call.id)).toEqual(['direct/a0'])
    expect(plan.outcome).toMatchObject({ state: 'completed', final: { stepId: 'direct' } })
    expect(plan.outcome?.final?.markdown).toBe(
      'Direct\n\nJEV judged that this question has one right answer (92% sure), so one model answered it and the run ended there.'
    )
    expect(plan.runs.answer[0]).toMatchObject({ state: 'not-run' })
    expect(plan.runs.final[0].reason).toContain('one right answer')
  })

  it.each([
    ['open', { noul: 0.1 }, 'needs judgement'],
    ['unsure', { noul: 0.5 }, 'was not sure'],
    ['unavailable', { markdown: 'x', error: 'no TypeSafe API key' }, 'no TypeSafe API key']
  ])('runs the full workflow when JEV reads it %s', (reason, value, note) => {
    const plan = drive(ROUTED, answering(value))
    expect(plan.route?.reason).toBe(reason)
    expect(agentCalls(plan.calls).map((call) => call.stepId)).not.toContain('direct')
    expect(plan.outcome).toMatchObject({ state: 'completed', final: { stepId: 'final' } })
    expect(plan.runs.direct[0]).toMatchObject({ state: 'not-run' })
    expect(plan.notes.join(' ')).toContain(note)
    // Only a reading JEV could not give is a gap; a clear no is the workflow working.
    expect(plan.outcome?.gaps.some((gap) => gap.includes(note))).toBe(reason === 'unavailable')
  })

  it('runs the full workflow when the route call itself fails', () => {
    const plan = drive(ROUTED, answering(undefined))
    expect(plan.route).toMatchObject({ route: 'full', reason: 'unavailable' })
    expect(plan.outcome?.final?.stepId).toBe('final')
  })

  it('fails honestly when the one model fails, never swapping in the full workflow', () => {
    const plan = drive(ROUTED, (call) =>
      call.route ? { noul: 0.9 } : call.stepId === 'direct' ? undefined : text('x')
    )
    expect(plan.outcome?.state).toBe('failed')
    expect(plan.outcome?.error).toContain('One answer')
    expect(agentCalls(plan.calls).map((call) => call.id)).toEqual(['direct/a0'])
  })

  it('waits for the route before planning anything else', () => {
    const plan = planWorkflowGraph(configFor(ROUTED), task, new Map())
    expect(plan.ready.map((call) => [call.id, call.seatId, call.route])).toEqual([
      ['direct/route', 'jev', { question: task.prompt }]
    ])
    expect(plan.runs.answer[0].state).toBe('waiting')
    expect(plan.runs.direct[0].state).toBe('active')
  })

  it('keeps the call bound an upper bound on either path and reserves the final step', () => {
    const bound = planWorkflowCalls(ROUTED).total
    expect(bound).toBe(4)
    for (const noul of [0.9, 0.1]) {
      expect(agentCalls(drive(ROUTED, answering({ noul })).calls).length).toBeLessThanOrEqual(bound)
    }
    expect(workflowFinishReserve(ROUTED)).toEqual({ finalStepId: 'final', reserve: 1 })
  })

  it('reads back as a plain sentence before the steps, without the answer step', () => {
    const lines = describeWorkflow(ROUTED)
    expect(lines[0]).toMatch(/^First, JEV checks whether the question has one right answer/)
    expect(lines.some((line) => line.startsWith('One answer'))).toBe(false)
    expect(lines.at(-1)).toBe('Up to 4 agent calls.')
  })

  it('validates and normalizes the route, and refuses one that cannot stand alone', () => {
    expect(validateWorkflowSpec(ROUTED).problems).toEqual([])
    expect(normalizeWorkflowSpec(ROUTED).oneAnswer).toEqual({ step: 'direct' })
    const consumed = {
      ...ROUTED,
      steps: ROUTED.steps.map((step) =>
        step.id === 'final' ? { ...step, inputs: ['answer', 'direct'] } : step
      )
    }
    expect(validateWorkflowSpec(consumed).problems[0]?.message).toContain('One-answer routing')
    const alone = { ...ROUTED, steps: [ROUTED.steps[0]] }
    expect(validateWorkflowSpec(alone).problems.map((problem) => problem.message)).toContain(
      'One-answer routing needs the rest of the workflow to fall back to.'
    )
  })

  it('asks the host, never an agent, for the route', async () => {
    const asked: string[] = []
    const context = createWorkflowProgramContext({
      agent: async (call) => {
        asked.push(call.id)
        return text(call.id.startsWith('direct') ? 'Direct' : 'Work')
      },
      phase: () => {},
      log: () => {},
      guard: () => {},
      isFatal: () => false
    })
    const routed = await runWorkflowGraphProgram(
      context,
      { ...configFor(ROUTED), routeWithJev: async () => ({ value: { noul: 0.8 } }) },
      task
    )
    expect(routed.final.stepId).toBe('direct')
    expect(asked).toEqual(['direct/a0'])
    // Without a router the reading fails, so the full workflow runs.
    asked.length = 0
    const full = await runWorkflowGraphProgram(context, configFor(ROUTED), task)
    expect(full.final.stepId).toBe('final')
    expect(asked).not.toContain('direct/a0')
    expect(full.gaps.join(' ')).toContain('JEV could not say')
  })
})
