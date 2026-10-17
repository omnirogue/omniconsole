import { describe, expect, it } from 'vitest'
import { describeWorkflow, planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import {
  WORKFLOW_COMPARE_FIRST_ROUND,
  WORKFLOW_COMPARE_LAST_ROUND
} from '../../../../shared/workflow-graph-decide-fields'
import { ballot, decideAnswer, decideSpec } from './graph-decide-test-fixtures'
import type { GraphCall } from './graph-plan-types'
import { drive, text } from './graph-test-harness'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'

const lines = ['Is it reliable?', 'Is it cheap to run?', 'Is it easy to operate?']
const agentCalls = (calls: GraphCall[]) => calls.filter((c) => !c.jev && !c.screen && !c.route)
/** The comparison's own lines; round 2 is the guard and later rounds its skeptic. */
const lineCalls = (calls: GraphCall[]) =>
  calls.filter(
    (call) =>
      call.stepId === 'compare' &&
      call.round >= WORKFLOW_COMPARE_FIRST_ROUND &&
      call.round <= WORKFLOW_COMPARE_LAST_ROUND
  )
const compareModels = (calls: GraphCall[]) => agentCalls(lineCalls(calls))
/** Rubric line i is judged in round 3+2i as shown, and 4+2i reversed. */
const lineOf = (call: GraphCall) => Math.floor((call.round - 3) / 2)
const unsure = { ...ballot('ABCD'), unsure: true }

/** Line 2: JEV is unsure; both judges put B first in both orders. */
const agree = (call: GraphCall) =>
  lineOf(call) !== 1 ? ballot('ABCD') : call.jev ? unsure : ballot('BACD')

/** The labels in the order a rank prompt shows them. */
const shownOrder = (prompt: string, count: number) =>
  [...prompt.matchAll(/^Response ([A-Z]):?$/gm)].map((match) => match[1]!).slice(0, count)

describe('Decide: compare by criterion, crux', () => {
  it("leaves a Council ranker's rotated order as it was", () => {
    const council = workflowTemplate('council', ['claude', 'codex', 'grok'])
    const plan = drive(council, (call) =>
      call.stepId !== 'rank'
        ? text(`${call.id} answer`)
        : call.jev
          ? { ...ballot('ABC'), unsure: true }
          : ballot('ABC')
    )
    const order = (id: string) => shownOrder(plan.calls.find((call) => call.id === id)!.prompt, 3)
    expect(order('rank/a0')).toEqual(['A', 'B', 'C'])
    expect(order('rank/a1')).toEqual(['B', 'C', 'A'])
    expect(order('rank/a2')).toEqual(['C', 'A', 'B'])
  })

  it('judges each rubric line with JEV in both orders, and no model when JEV is sure', () => {
    const plan = drive(decideSpec(), decideAnswer())
    const jev = lineCalls(plan.calls).filter((call) => call.jev)
    expect(jev.map((call) => call.id)).toEqual([
      'compare/r3/jev',
      'compare/r5/jev',
      'compare/r7/jev'
    ])
    expect(jev.map((call) => call.jev!.method)).toEqual(['pairwise', 'pairwise', 'pairwise'])
    jev.forEach((call, index) => expect(call.jev!.instruction).toContain(lines[index]))
    expect(compareModels(plan.calls)).toEqual([])
    const overall = plan.runs.compare[0]
    expect(overall.round).toBe(1)
    expect(overall.criteria?.map((entry) => entry.judgedBy)).toEqual([['jev'], ['jev'], ['jev']])
    const first = overall.candidates![0].name
    expect(overall.criteria?.every((entry) => entry.leaders[0] === first)).toBe(true)
    expect(plan.runs.crux[0]).toMatchObject({ state: 'empty' })
    expect(plan.runs.crux[0].reason).toMatch(
      /^Not needed: .+ led .+ clearly \(by 1\.00 places\)\.$/
    )
    expect(plan.outcome).toMatchObject({ state: 'completed', gaps: [] })
    const memo = plan.calls.find((call) => call.stepId === 'memo')!
    expect(memo.dependencies).toEqual(expect.arrayContaining(jev.map((call) => call.id)))
    expect(memo.prompt).toContain('Leader on each rubric line')
  })

  it('has the judges rank an unsure line in both orders, and finds the crux when it is close', () => {
    const plan = drive(decideSpec(), decideAnswer(agree))
    expect(compareModels(plan.calls).map((call) => call.id)).toEqual([
      'compare/r5/a0',
      'compare/r5/a1',
      'compare/r6/a0',
      'compare/r6/a1'
    ])
    // Every judge sees exactly the reverse of its own first order, under the same labels.
    const order = (id: string) => shownOrder(plan.calls.find((call) => call.id === id)!.prompt, 4)
    expect(order('compare/r5/a0')).toEqual(['A', 'B', 'C', 'D'])
    expect(order('compare/r5/a1')).toEqual(['B', 'C', 'D', 'A'])
    for (const agent of ['a0', 'a1']) {
      expect(order(`compare/r6/${agent}`)).toEqual(order(`compare/r5/${agent}`).toReversed())
    }
    const overall = plan.runs.compare[0]
    expect(overall.criteria?.map((entry) => entry.judgedBy)).toEqual([['jev'], ['models'], ['jev']])
    expect(overall.criteria?.[1].leaders).toEqual([overall.candidates![1].name])
    // A averages 1.33 and B 1.67: close, so the crux runs and reads the comparison.
    const crux = agentCalls(plan.calls).filter((call) => call.stepId === 'crux')
    expect(crux).toHaveLength(1)
    expect(crux[0].prompt).toContain('Overall order (mean place over the settled lines')
    expect(plan.outcome).toMatchObject({ state: 'completed', gaps: [] })
  })

  it('leaves a line out as a gap when a judge flips with the order, and runs the crux', () => {
    const flip = (call: GraphCall) =>
      lineOf(call) !== 1
        ? ballot('ABCD')
        : call.jev
          ? unsure
          : ballot(call.round === 5 ? 'BACD' : 'ABCD')
    const plan = drive(decideSpec(), decideAnswer(flip))
    const entry = plan.runs.compare[0].criteria?.[1]
    expect(entry).toMatchObject({ leaders: [], judgedBy: [] })
    expect(entry?.unsettled).toBe(
      'JEV was not sure, and a model judge put a different option first when the order was reversed'
    )
    expect(plan.runs.compare[0].state).toBe('gaps')
    expect(plan.outcome?.gaps.join(' ')).toContain('1 rubric line of 3 was not settled')
    // A led B clearly on the settled lines, but an unsettled line keeps the question open.
    expect(agentCalls(plan.calls).filter((call) => call.stepId === 'crux')).toHaveLength(1)
  })

  it('never credits an unsure JEV ballot when the judges cannot settle the line', () => {
    const plan = drive(
      decideSpec(),
      decideAnswer((call) => (lineOf(call) !== 2 ? ballot('ABCD') : call.jev ? unsure : undefined))
    )
    const entry = plan.runs.compare[0].criteria?.[2]
    expect(entry).toEqual({
      criterion: lines[2],
      leaders: [],
      judgedBy: [],
      unsettled: 'JEV was not sure and no model judge answered'
    })
    expect(plan.outcome?.gaps.join(' ')).toContain('Is it easy to operate? (JEV was not sure')
    expect(agentCalls(plan.calls).filter((call) => call.stepId === 'crux')).toHaveLength(1)
  })

  it('keeps a real tie a tie, and a tie at the top runs the crux', () => {
    // Every line: JEV unsure; one judge puts A first and the other B, each in both orders.
    const tie = (call: GraphCall) =>
      call.jev ? unsure : ballot(call.agentIndex === 0 ? 'ABCD' : 'BACD')
    const plan = drive(decideSpec(), decideAnswer(tie))
    const overall = plan.runs.compare[0]
    const places = (overall.standings ?? []).filter((row) => row.place === 1)
    expect(places.map((row) => row.label)).toEqual(['Response A', 'Response B'])
    expect(overall.criteria?.every((entry) => entry.leaders.length === 2)).toBe(true)
    expect(overall.texts?.[0]?.markdown).toContain('(tied)')
    expect(agentCalls(plan.calls).filter((call) => call.stepId === 'crux')).toHaveLength(1)
  })

  it('goes on without a failed comparison, and never calls the crux unneeded', () => {
    const plan = drive(
      decideSpec(),
      decideAnswer(() => undefined)
    )
    expect(plan.runs.compare[0].state).toBe('failed')
    expect(plan.runs.crux[0].reason).toBe(
      'Not run: Compare did not finish, so whether the top two are close is unknown.'
    )
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.outcome?.gaps.join(' ')).toContain('Compare failed: no rubric line was settled')
  })

  it('keeps every run within the call bound, even when JEV fails on every line', () => {
    const bound = planWorkflowCalls(decideSpec()).total
    expect(bound).toBe(1 + 2 + 4 + 24 + 1 + 1 + 2 + 2)
    const worst = drive(
      decideSpec(),
      decideAnswer((call) => (call.jev ? undefined : ballot('BACD')))
    )
    expect(compareModels(worst.calls)).toHaveLength(3 * 2 * 2)
    expect(agentCalls(worst.calls).length).toBeLessThanOrEqual(bound)
    expect(worst.runs.compare[0].criteria?.every((entry) => entry.judgedBy[0] === 'models')).toBe(
      true
    )
  })

  it('replays the same calls and prompts from the same outcomes', () => {
    const digest = () =>
      JSON.stringify(drive(decideSpec(), decideAnswer(agree)).calls.map((c) => [c.id, c.prompt]))
    expect(digest()).toBe(digest())
  })

  it('reads back plainly and refuses a comparison or crux it cannot run', () => {
    const read = describeWorkflow(decideSpec())
    expect(read).toContain(
      'Compare: JEV compares the answers from Develop on each rubric line of Frame, in both orders; 2 agents rank a line, also in both orders, only where JEV is unsure, and a line they still disagree on is left out as a gap.'
    )
    expect(read).toContain(
      'Crux: 1 agent works using Frame and Develop and Compare, only when the top two of Compare are close.'
    )
    const spec = decideSpec()
    const broken = {
      ...spec,
      steps: spec.steps.map((step) =>
        step.id === 'compare'
          ? { ...step, inputs: ['frame'] }
          : step.id === 'crux'
            ? { ...step, whenClose: 'frame' }
            : step
      )
    }
    expect(validateWorkflowSpec(broken).problems.map((problem) => problem.message)).toEqual(
      expect.arrayContaining([
        'Compare compares the answers of a for-each Do step; connect one.',
        'Crux runs only when a ranking is close, so it needs a Rank step to read.'
      ])
    )
  })
})
