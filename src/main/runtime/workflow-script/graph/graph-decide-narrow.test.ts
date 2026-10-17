import { describe, expect, it } from 'vitest'
import { describeWorkflow, planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import type { GraphCall } from './graph-plan-types'
import { decideAnswer, decideSpec, screened } from './graph-decide-test-fixtures'
import { drive } from './graph-test-harness'
import { GRAPH_HARD_LIMIT_PREFIX } from './graph-frame-limits'

const decide = decideSpec
const answer = (screen: (call: GraphCall) => unknown) => decideAnswer(undefined, screen)

describe('Decide: frame, go wide, narrow', () => {
  it('is a valid workflow with an exact call bound and a plain read-back', () => {
    expect(validateWorkflowSpec(decide()).problems).toEqual([])
    expect(validateWorkflowSpec(decide(true)).problems).toEqual([])
    // Frame, two option lists, four finalists, two judges in both orders on up to six lines, crux,
    // memo, and the guard: its two judges and two skeptic calls.
    expect(planWorkflowCalls(decide()).total).toBe(1 + 2 + 4 + 24 + 1 + 1 + 2 + 2)
    expect(planWorkflowCalls(decide(true)).total).toBe(1 + 1 + 2 + 4 + 24 + 1 + 1 + 2 + 2)
    const lines = describeWorkflow(decide())
    expect(lines).toContain(
      "Develop: 1 agent works for each item from Options using Frame, on a varied shortlist JEV picks: options that break a hard limit are dropped, then the best overall, each rubric line's leader and one wildcard."
    )
    expect(
      decide()
        .steps.find((step) => step.id === 'options')
        ?.agents.map((a) => a.route)
    ).toEqual(['claude', 'codex'])
  })

  it("screens with the frame's hard limits first, then its rubric", () => {
    const plan = drive(decide(), answer(screened))
    const call = plan.calls.find((entry) => entry.screen)!
    expect(call.id).toBe('develop/screen')
    expect(call.screen!.rubric).toBe(
      `${GRAPH_HARD_LIMIT_PREFIX} Under $500 a month?\n${GRAPH_HARD_LIMIT_PREFIX} Runs in the EU?\n- Is it reliable?\n- Is it cheap to run?\n- Is it easy to operate?`
    )
    expect(call.screen!.candidates).toHaveLength(10)
  })

  it('develops only the shortlist, and carries no over-the-limit gap for the rest', () => {
    const plan = drive(decide(), answer(screened))
    const developed = plan.calls.filter((call) => call.stepId === 'develop' && !call.screen)
    expect(developed).toHaveLength(4)
    const keys = developed.map((call) => call.id.split('/')[1])
    // Item 0 broke a limit; 1 is best, 7 and 9 lead on cheap and easy, 2 spikes: the wildcard.
    expect(keys).toEqual(['options.r1.2', 'options.r1.8', 'options.r1.10', 'options.r1.3'])
    expect(plan.notes.join(' ')).toContain('1 option broke a hard limit and was dropped')
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.outcome?.gaps).toEqual([])
    expect(developed.every((call) => call.prompt.includes('Hard limits'))).toBe(true)
    // The screen's own summary is never read as a developed option.
    expect(plan.runs.develop[0].texts?.map((entry) => entry.callId)).toEqual(
      developed.map((call) => call.id)
    )
    expect(plan.outcome?.final?.markdown).not.toContain('screened')
  })

  it('says why nothing was developed when every option breaks a hard limit', () => {
    const broken = drive(
      decide(),
      answer((call) => {
        const result = screened(call)
        const zero = Object.fromEntries(Object.keys(result.scores).map((id) => [id, 0]))
        return {
          ...result,
          criteria: [{ ...result.criteria[0]!, scores: zero }, ...result.criteria.slice(1)]
        }
      })
    )
    expect(broken.runs.develop[0]).toMatchObject({
      state: 'empty',
      reason: 'Nothing to develop: JEV judged that all 10 options break a hard limit.'
    })
  })

  it('names a failed screen as a gap, and still develops a varied set', () => {
    const plan = drive(
      decide(),
      answer(() => ({ markdown: 'x', error: 'JEV is turned off' }))
    )
    expect(plan.calls.filter((call) => call.stepId === 'develop' && !call.screen)).toHaveLength(4)
    expect(plan.outcome?.gaps.join(' ')).toContain(
      'Develop: JEV could not screen the options (JEV is turned off)'
    )
  })

  it('replays the same calls and prompts from the same outcomes', () => {
    const digest = () =>
      JSON.stringify(drive(decide(), answer(screened)).calls.map((c) => [c.id, c.prompt]))
    expect(digest()).toBe(digest())
  })
})
