import { describe, expect, it } from 'vitest'
import {
  localWorkflowFindRequestSchema,
  localWorkflowFindSpec
} from '../../../../shared/local-workflow-find-request'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { workflowFindScreeningText } from '../../../../shared/workflow-find-trail'
import { planWorkflowGraph } from './graph-plan'
import { graphFindRules, type GraphCall, type GraphOutcome } from './graph-plan-types'
import { configFor, drive, task, text } from './graph-test-harness'

function specFor(count: number) {
  return localWorkflowFindSpec(
    localWorkflowFindRequestSchema.parse({
      prompt: 'Choose',
      items: Array.from({ length: count }, (_, n) => `Option ${n + 1}`),
      top: 2,
      good: '- Low cost\n- High quality'
    }),
    ['claude', 'codex'],
    []
  )
}

function answer(call: GraphCall) {
  if (call.screen) {
    const scores = (score: (index: number) => number) =>
      Object.fromEntries(
        call.screen!.candidates.map((candidate) => [
          candidate.id,
          score(Number(candidate.id.split('.')[1]))
        ])
      )
    return {
      scores: scores((n) => (n <= 2 ? 4 : 1)),
      criteria: [
        { id: 'c1', label: 'Low cost', scores: scores((n) => (n === 150 ? 4 : 0)) },
        { id: 'c2', label: 'High quality', scores: scores((n) => (n === 1 ? 4 : 0)) }
      ]
    }
  }
  if (call.jev) {
    return text(
      `FINAL RANKING:\n${call.jev.candidates.map((c, n) => `${n + 1}. ${c.label}`).join('\n')}`
    )
  }
  return undefined
}

describe('paged Find replay', () => {
  it('replays a rules-2 snapshot with its original calls, stages and report', () => {
    const snapshot = { host: { findRules: 2 }, spec: specFor(200) }
    const plan = drive(snapshot.spec, answer, graphFindRules(snapshot))
    expect(plan.calls.filter((call) => call.screen).map((call) => call.id)).toEqual([
      'judge/screen'
    ])
    expect(plan.find!.overall.map((pick) => pick.key)).toEqual(['list.1', 'list.2'])
    expect(drive(snapshot.spec, answer, { findRules: undefined }).find).toEqual(plan.find)
    expect(plan.find).not.toHaveProperty('screening')
    expect(plan.find).not.toHaveProperty('criterionLeaders')
    expect(
      JSON.stringify({ runs: plan.runs, find: plan.find, outcome: plan.outcome })
    ).toMatchSnapshot()
  })

  it('replays pages byte-identically even when saved outcomes arrive in reverse order', () => {
    const snapshot = { host: { findRules: 3 }, spec: specFor(2000) }
    const config = { ...configFor(snapshot.spec), ...graphFindRules(snapshot) }
    const outcomes = new Map<string, GraphOutcome>()
    let plan = planWorkflowGraph(config, task, outcomes)
    expect(plan.ready).toHaveLength(20)
    expect(plan.ready.every((call) => call.screen?.candidates.length === 100)).toBe(true)
    const saved = [...plan.ready].toReversed()
    for (const call of saved) {
      outcomes.set(call.id, { value: answer(call) })
    }
    plan = planWorkflowGraph(config, task, outcomes)
    expect(plan.find!.overall.map((pick) => pick.key)).toEqual(['list.1', 'list.2', 'list.150'])
    expect(plan.find!.criterionLeaders).toEqual([
      { key: 'list.150', title: 'Option 150', criterion: 'Low cost', status: 'kept' },
      { key: 'list.1', title: 'Option 1', criterion: 'High quality', status: 'already' }
    ])
    const replay = planWorkflowGraph(config, task, new Map([...outcomes].toReversed()))
    expect(JSON.stringify(replay)).toBe(JSON.stringify(plan))
    const completed = drive(snapshot.spec, answer, graphFindRules(snapshot))
    expect(completed.outcome?.state).toBe('completed')
    expect(planWorkflowCalls(snapshot.spec).total).toBeGreaterThanOrEqual(completed.calls.length)
    expect(workflowFindScreeningText(completed.find!)).toEqual([
      'Screened 2000 options across 20 pages; 3 advanced to the shortlist.',
      'Kept "Option 150" in the shortlist because it scored highest for "Low cost".',
      '"Option 1" also scored highest for "High quality"; it was already in the shortlist.'
    ])
    expect(completed.outcome!.final!.markdown).toContain('Screened 2000 options across 20 pages')
  })

  it('keeps one leader for tied criteria and deduplicates leaders across criteria', () => {
    const plan = drive(specFor(201), (call) => {
      const result = answer(call)
      if (!call.screen) {
        return result
      }
      return {
        scores: {},
        criteria: [
          {
            id: 'c1',
            label: 'Low cost',
            scores: Object.fromEntries(call.screen.candidates.map((c) => [c.id, 4]))
          },
          {
            id: 'c2',
            label: 'High quality',
            scores: Object.fromEntries(call.screen.candidates.map((c) => [c.id, 4]))
          }
        ]
      }
    })
    expect(plan.find!.overall.map((p) => p.key)).toEqual(['list.1'])
    expect(plan.find!.criterionLeaders).toHaveLength(2)
  })

  it('reserves enough calls when every final model must rank after JEV fails', () => {
    const spec = specFor(2000)
    let actual = 0
    const plan = drive(spec, (call) => {
      actual++
      return call.jev ? undefined : answer(call)
    })
    expect(plan.outcome?.state).toBe('completed')
    expect(planWorkflowCalls(spec).total).toBeGreaterThanOrEqual(actual)
    expect(plan.calls.filter((call) => !call.screen && !call.jev).length).toBeGreaterThan(0)
  })

  it('fails a page explicitly and never judges a partial pool', () => {
    const plan = drive(specFor(201), (call) =>
      call.id.endsWith('page.2') ? undefined : answer(call)
    )
    expect(plan.outcome?.state).toBe('failed')
    expect(plan.calls.some((call) => call.jev)).toBe(false)
  })
})
