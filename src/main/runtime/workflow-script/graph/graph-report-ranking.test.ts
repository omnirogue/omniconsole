import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { describeWorkflow } from '../../../../shared/workflow-graph-topology'
import { planWorkflowGraph, type GraphCall, type GraphOutcome } from './graph-plan'
import { configFor, task, text } from './graph-test-harness'

const found = (title: string) => ({
  title,
  detail: `How ${title} breaks.`,
  location: `src/${title.replace(/\s+/g, '-')}.ts:1`,
  severity: 'high'
})

function spec(rankItems: boolean, rankEstimates = false) {
  return normalizeWorkflowSpec({
    title: 'Ranked report',
    steps: [
      {
        id: 'find',
        kind: 'do',
        title: 'Find',
        agents: [{ route: 'claude' }],
        list: { maxItems: 8 }
      },
      {
        id: 'verify',
        kind: 'review',
        title: 'Verify',
        agents: [{ route: 'codex' }],
        inputs: ['find'],
        forEach: { step: 'find', limit: 8 }
      },
      {
        id: 'report',
        kind: 'synthesize',
        title: 'Report',
        agents: [{ route: 'claude' }],
        inputs: ['verify'],
        ...(rankItems ? { rankItems: true, ...(rankEstimates ? { rankEstimates: true } : {}) } : {})
      }
    ]
  })
}

const block = (keys: string[]) =>
  `\`\`\`ranking\n${JSON.stringify(keys.map((key, index) => ({ key, rank: index + 1, why: `why ${key}`, next: `next ${key}` })))}\n\`\`\``

/** a and c pass review, b fails it. */
function run(rankItems: boolean, report: string, failVerify = false, rankEstimates = false) {
  const config = configFor(spec(rankItems, rankEstimates))
  const outcomes = new Map<string, GraphOutcome>()
  const answer = (call: GraphCall) =>
    call.id === 'find/a0'
      ? { items: [found('lost write'), found('noisy log'), found('stale read')] }
      : call.stepId === 'verify'
        ? text(call.id.includes('find.r1.2') ? 'No.\nVERDICT: FAIL' : 'Yes.\nVERDICT: PASS')
        : text(report)
  let plan = planWorkflowGraph(config, task, outcomes)
  for (let pass = 0; pass < 10 && plan.ready.length; pass++) {
    for (const call of plan.ready) {
      outcomes.set(
        call.id,
        failVerify && call.stepId === 'verify' ? { failed: true } : { value: answer(call) }
      )
    }
    plan = planWorkflowGraph(config, task, outcomes)
  }
  return plan
}

describe('a report that ranks the reviewed results', () => {
  it('shows the writer each key, asks for the ranking, and hides it from the report', () => {
    const plan = run(true, `# Report\n\n${block(['find.r1.3', 'find.r1.1'])}`)
    const prompt = plan.calls.find((call) => call.id === 'report/a0')!.prompt
    expect(prompt).toContain('[find.r1.1]')
    expect(prompt).toContain('fenced block tagged `ranking`')
    expect(plan.outcome).toMatchObject({
      state: 'completed',
      gaps: [],
      final: {
        markdown: '# Report',
        ranking: [
          { key: 'find.r1.3', rank: 1, why: 'why find.r1.3', next: 'next find.r1.3' },
          { key: 'find.r1.1', rank: 2 }
        ]
      }
    })
  })

  it('asks for estimates only when the frozen spec opted in', () => {
    const old = run(true, 'Report').calls.find((call) => call.id === 'report/a0')!.prompt
    const current = run(true, 'Report', false, true).calls.find(
      (call) => call.id === 'report/a0'
    )!.prompt
    expect(old).not.toContain('In every ranking row also include effort')
    expect(current).toContain('In every ranking row also include effort')
    expect(
      workflowTemplate('discover').steps.find((step) => step.id === 'report')?.rankEstimates
    ).toBe(true)
  })

  it('names confirmed results the ranking left out, and ignores keys it made up', () => {
    const plan = run(true, `Report\n${block(['find.r9.9', 'find.r1.3'])}`)
    expect(plan.outcome?.final?.ranking?.map((row) => row.key)).toEqual(['find.r1.3'])
    expect(plan.outcome?.gaps).toEqual([
      'Report left 1 confirmed result out of its ranking; they follow the ranked ones by impact.'
    ])
    const unranked = run(true, 'Report without a block')
    expect(unranked.outcome).toMatchObject({
      state: 'completed',
      final: { markdown: 'Report without a block' },
      gaps: ['Report did not rank the results, so they are listed by impact.']
    })
    expect(unranked.outcome?.final?.ranking).toBeUndefined()
  })

  it('keeps the ranking of results whose review failed, since the writer saw their keys', () => {
    const plan = run(true, `Report\n${block(['find.r1.2', 'find.r1.1'])}`, true)
    expect(plan.calls.find((call) => call.id === 'report/a0')!.prompt).toContain('[find.r1.2]')
    expect(plan.outcome?.final?.ranking?.map((row) => row.key)).toEqual(['find.r1.2', 'find.r1.1'])
  })

  it('leaves a report without the option exactly as before', () => {
    const plan = run(false, `Report\n${block(['find.r1.1'])}`)
    const prompt = plan.calls.find((call) => call.id === 'report/a0')!.prompt
    expect(prompt).not.toContain('[find.r1.1]')
    expect(prompt).not.toContain('`ranking`')
    expect(plan.outcome?.final).toEqual({
      stepId: 'report',
      markdown: `Report\n${block(['find.r1.1'])}`
    })
  })

  it('is only accepted on a write-up that reads a per-item review, and Discover uses it', () => {
    const bad = normalizeWorkflowSpec({
      title: 'Bad',
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft', agents: [{}] },
        { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['draft'], rankItems: true }
      ]
    })
    expect(validateWorkflowSpec(bad).problems.map((problem) => problem.message)).toContain(
      'Final ranks reviewed results, so it must read a step that reviews each item.'
    )
    const discover = workflowTemplate('discover')
    expect(discover.steps.find((step) => step.id === 'report')?.rankItems).toBe(true)
    expect(describeWorkflow(discover).join('\n')).toContain(
      'ranks the results by value, each with why and a next step'
    )
  })
})
