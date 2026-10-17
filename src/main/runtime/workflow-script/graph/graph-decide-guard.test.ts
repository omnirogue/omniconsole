import { describe, expect, it } from 'vitest'
import {
  describeWorkflow,
  planWorkflowCalls,
  workflowFinishReserve
} from '../../../../shared/workflow-graph-topology'
import { councilFinalCheckSteps } from '../../../../shared/workflow-council-final-check'
import {
  DECIDE_FALLBACK_SKEPTIC_ROUND,
  DECIDE_SKEPTIC_ROUND
} from '../../../../shared/workflow-decide-guard'
import { decideWorkflow } from '../../../../shared/workflow-graph-decide'
import { WORKFLOW_COMPARE_LAST_ROUND } from '../../../../shared/workflow-graph-decide-fields'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { ballot, decideAnswer, decideSpec, FRAME, memoFirst } from './graph-decide-test-fixtures'
import type { GraphCall } from './graph-plan-types'
import { graphCallSuperseded } from './graph-supersede'
import { drive, text } from './graph-test-harness'

const MEMO = 'memo answer from memo/a0'
const S1 = `compare/r${DECIDE_SKEPTIC_ROUND}/a0`
const S2 = `compare/r${DECIDE_FALLBACK_SKEPTIC_ROUND}/a0`
const agentCalls = (calls: GraphCall[]) => calls.filter((c) => !c.jev && !c.screen && !c.route)
const guardCalls = (calls: GraphCall[]) =>
  calls.filter(
    (call) => call.stepId === 'compare' && (call.round === 2 || call.round >= DECIDE_SKEPTIC_ROUND)
  )
const PASS = text('It keeps every limit.\nVERDICT: PASS')
const FAIL = text('It needs $900 a month and runs only in the US.\nVERDICT: FAIL')

/** The finalist first: the label JEV was not given the memo under. */
const finalistFirst = (call: GraphCall) => {
  const order = memoFirst(call)
    .markdown.match(/Response ([A-Z])/g)!
    .map((entry) => entry.at(-1))
  return ballot(order.toReversed().join(''))
}
/** The skeptic fails the memo and judges any finalist with `finalist`. */
const memoFails = (finalist: unknown) => (call: GraphCall) =>
  call.prompt.includes(MEMO) ? FAIL : finalist
const run = (more: Parameters<typeof decideAnswer>[2], change = {}) =>
  drive(decideSpec(), decideAnswer(undefined, undefined, more), change)
const best = (plan: ReturnType<typeof run>) => plan.runs.compare[0].candidates![0]

describe('Decide: recommend and guard', () => {
  it('keeps the memo when JEV judges it at least as good and an independent skeptic passes it', () => {
    const plan = run({ skeptic: () => PASS })
    const calls = guardCalls(plan.calls)
    expect(calls.map((call) => [call.id, call.seatId])).toEqual([
      ['compare/r2/jev', 'jev'],
      [S1, 'codex']
    ])
    expect(calls[1].prompt).toContain('Under $500 a month')
    expect(calls[1].prompt).toContain(MEMO)
    expect(plan.runs.memo[0].finalCheck).toEqual({
      result: 'chair',
      judgedBy: ['jev'],
      subject: 'decide',
      skeptic: { shipped: 'memo', status: 'kept', against: 'limits' }
    })
    expect(plan.outcome).toMatchObject({ state: 'completed', gaps: [] })
    expect(plan.outcome?.final?.markdown).toBe(
      `${MEMO}\n\nGuard: the memo was compared blind with the best finalist and kept. A skeptic from another model family checked what is shown against every hard limit in the frame.`
    )
  })

  it('checks the best finalist too when it wins the guard, and shows it only if it passes', () => {
    const plan = run({ guard: finalistFirst, skeptic: () => PASS })
    const skeptic = plan.calls.find((call) => call.id === S1)!
    expect(skeptic.prompt).toContain(best(plan).markdown)
    expect(skeptic.prompt).not.toContain(MEMO)
    expect(plan.runs.memo[0].finalCheck?.skeptic).toEqual({
      shipped: 'finalist',
      status: 'kept',
      against: 'limits'
    })
    expect(plan.outcome?.final?.markdown).toMatch(new RegExp(`^## ${best(plan).name}\\n`))
  })

  it('withholds the recommendation when the winning finalist breaks a hard limit', () => {
    const plan = run({ guard: finalistFirst, skeptic: () => FAIL })
    const markdown = plan.outcome!.final!.markdown
    expect(markdown).toMatch(/^## No recommendation passed the checks\n/)
    expect(markdown).toContain('It needs $900 a month and runs only in the US.')
    expect(markdown).toContain(`### ${best(plan).name}`)
    expect(markdown).not.toContain(MEMO)
    expect(plan.outcome?.gaps.join(' ')).toContain(
      'No recommendation passed the checks: the best finalist was judged better than the memo'
    )
  })

  it('stands in the best finalist for a rejected memo only once it passes the same check', () => {
    const plan = run({ skeptic: memoFails(PASS) })
    expect(guardCalls(plan.calls).map((call) => call.id)).toEqual(['compare/r2/jev', S1, S2])
    expect(plan.calls.find((call) => call.id === S2)!.prompt).toContain(best(plan).markdown)
    expect(plan.runs.memo[0].finalCheck?.skeptic).toEqual({
      shipped: 'finalist',
      status: 'kept',
      against: 'limits',
      memoRejected: true
    })
    expect(plan.outcome?.final?.markdown).toMatch(
      /\n\nGuard: the memo held up against the best finalist\. A skeptic then found that the memo breaks a hard limit in the frame, so the best finalist is shown instead\. A skeptic from another model family checked what is shown against every hard limit in the frame\.$/
    )
    expect(plan.outcome?.gaps).toEqual([])
  })

  it('says what the comparison found, apart from the skeptic, when every comparison call failed', () => {
    const plan = run({ guard: () => undefined, skeptic: memoFails(PASS) })
    expect(plan.runs.memo[0].finalCheck).toMatchObject({
      result: 'failed',
      skeptic: { shipped: 'finalist', status: 'kept', memoRejected: true }
    })
    const note = plan.outcome!.final!.markdown
    expect(note).toContain(
      'The guard could not compare the memo with the best finalist. A skeptic then found that the memo breaks a hard limit in the frame, so the best finalist is shown instead.'
    )
    expect(note).not.toContain('held up')
  })

  it('never ships a fallback that breaks a limit: US-only and $900 against EU-only and $500', () => {
    const plan = run({ skeptic: () => FAIL })
    expect(plan.runs.memo[0].finalCheck?.skeptic).toMatchObject({
      shipped: 'none',
      status: 'withheld',
      memoRejected: true,
      finalistRejected: true
    })
    expect(plan.outcome?.final?.markdown).toMatch(/^## No recommendation passed the checks/)
    expect(plan.outcome?.gaps.join(' ')).toContain('and so does the best finalist')
  })

  it('withholds a rejected memo when no finalist was placed to stand in', () => {
    const plan = run({ skeptic: () => FAIL }, {})
    const none = drive(
      decideSpec(),
      decideAnswer(() => undefined, undefined, { skeptic: () => FAIL })
    )
    expect(plan.runs.memo[0].finalCheck?.result).toBe('chair')
    expect(none.runs.memo[0].finalCheck?.result).toBe('no-peer-votes')
    expect(none.runs.memo[0].finalCheck?.skeptic).toMatchObject({
      shipped: 'none',
      memoRejected: true
    })
    expect(none.runs.memo[0].finalCheck?.skeptic?.finalistRejected).toBeUndefined()
    expect(none.outcome?.gaps.join(' ')).toContain('and no finalist was placed to stand in')
  })

  it.each([
    ['no answer', undefined],
    ['an unsure verdict', text('I cannot tell from the frame.\nVERDICT: UNSURE')],
    ['no verdict at all', text('Looks fine to me.')]
  ])('shows the memo clearly unchecked, as a gap, when the skeptic gives %s', (_name, answer) => {
    const plan = run({ skeptic: () => answer })
    expect(plan.runs.memo[0].finalCheck?.skeptic).toEqual({
      shipped: 'memo',
      status: 'unchecked',
      against: 'limits',
      why: 'failed'
    })
    expect(plan.outcome?.gaps.join(' ')).toContain(
      'The skeptic could not check what is shown against the hard limits, so it is shown unchecked.'
    )
  })

  it("never lets a skeptic of the writer's own family check it: no independent seat is a gap", () => {
    const alone = normalizeWorkflowSpec(decideWorkflow(['claude']), ['claude'])
    const plan = drive(alone, decideAnswer(undefined, undefined, { skeptic: () => PASS }))
    expect(plan.calls.some((call) => call.round >= DECIDE_SKEPTIC_ROUND)).toBe(false)
    expect(plan.runs.memo[0].finalCheck?.skeptic).toMatchObject({
      status: 'unchecked',
      why: 'no-seat'
    })
    expect(plan.outcome?.gaps.join(' ')).toContain('No model family independent of its writer')
  })

  it.each([
    [
      'prose',
      FRAME.replace('- Under $500 a month\n- Runs in the EU.', 'Keep it cheap and in Europe.')
    ],
    ['no heading', FRAME.replace('## Hard limits', '## Constraints')]
  ])('reviews the whole frame, never skips, when its limits are %s', (_name, frame) => {
    const plan = run({ frame, skeptic: () => PASS })
    const skeptic = plan.calls.find((call) => call.id === S1)!
    expect(skeptic.prompt).toContain('does not list its hard limits clearly')
    expect(plan.runs.memo[0].finalCheck?.skeptic).toMatchObject({
      status: 'kept',
      against: 'frame'
    })
    expect(plan.outcome?.final?.markdown).toContain('against the frame as a whole')
  })

  it('asks no skeptic only when the frame states there are no hard limits', () => {
    const frame = FRAME.replace('- Under $500 a month\n- Runs in the EU.', 'None stated.')
    const plan = run({ frame })
    expect(guardCalls(plan.calls).map((call) => call.id)).toEqual(['compare/r2/jev'])
    expect(plan.runs.memo[0].finalCheck?.skeptic).toEqual({ shipped: 'memo', status: 'no-limits' })
    expect(plan.outcome?.gaps).toEqual([])
  })

  it('marks the skeptic finished early with the guard, or on its own, and says so', () => {
    expect(workflowFinishReserve(decideSpec())).toEqual({ finalStepId: 'memo', reserve: 1 })
    const own = run({}, { refused: (id: string) => id === S1 })
    expect(own.runs.memo[0].finalCheck?.skeptic).toMatchObject({ why: 'finished-early' })
    const both = run({}, { refused: (id: string) => id.startsWith('compare/r2/') || id === S1 })
    expect(both.runs.memo[0].finalCheck).toMatchObject({
      result: 'finished-early',
      skeptic: { shipped: 'memo', status: 'unchecked', why: 'finished-early' }
    })
    expect(both.outcome?.gaps.join(' ')).toContain(
      'The skeptic was skipped because the run finished early'
    )
  })

  it('keeps an invalid skeptic a loud validation problem, never a disabled guard', () => {
    const spec = decideSpec()
    const bad = { ...spec, finalCheck: { rank: 'compare', chair: 'memo', skeptic: 'nope' } }
    expect(councilFinalCheckSteps(bad)).toBeDefined()
    expect(validateWorkflowSpec(bad).problems.map((problem) => problem.message)).toContain(
      "The guard's skeptic must read the frame from a Do step that the final step also reads."
    )
    const odd = normalizeWorkflowSpec({
      ...spec,
      finalCheck: { rank: 'compare', chair: 'memo', skeptic: 7 }
    })
    expect(odd.finalCheck).toEqual({ rank: 'compare', chair: 'memo', skeptic: '' })
    expect(validateWorkflowSpec(odd).problems.length).toBeGreaterThan(0)
  })

  it('stays within the call bound, reads back plainly, and keeps the guard admissible', () => {
    const spec = decideSpec()
    expect(DECIDE_SKEPTIC_ROUND).toBe(WORKFLOW_COMPARE_LAST_ROUND + 1)
    const bound = planWorkflowCalls(spec).total
    expect(bound).toBe(1 + 2 + 4 + 24 + 1 + 1 + 2 + 2)
    const worst = run({
      guard: (call) => (call.jev ? undefined : ballot('AB')),
      skeptic: memoFails(PASS)
    })
    expect(agentCalls(worst.calls).length).toBeLessThanOrEqual(bound)
    expect(describeWorkflow(spec)).toContain(
      'A guard compares the memo blind with the best finalist and keeps the finalist only if it is judged better; a skeptic from another model family then checks what would be shown against every hard limit, and a result that breaks one is never shown as the recommendation.'
    )
    expect(validateWorkflowSpec(spec).problems).toEqual([])
    // The guard reads the memo, so the memo's record never makes it stale.
    for (const id of [S1, S2, 'compare/r2/a0']) {
      expect(graphCallSuperseded(spec, id, ['memo/a0'])).toBe(false)
    }
    expect(graphCallSuperseded(spec, 'compare/r3/a0', ['memo/a0'])).toBe(true)
    // A Council spec never gains the skeptic's rounds.
    const council = { ...spec, finalCheck: { rank: 'compare', chair: 'memo' } }
    expect(graphCallSuperseded(council, S1, ['memo/a0'])).toBe(true)
  })
})
