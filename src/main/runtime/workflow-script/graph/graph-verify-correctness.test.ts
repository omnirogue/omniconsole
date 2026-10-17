import { describe, expect, it } from 'vitest'
import { validateJsonSchema } from '../../../../shared/json-schema-validate'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { GraphInputBudget } from './graph-prompts'
import { graphImpactProblem, graphMergeRootCauses } from './graph-impact-answer'
import { graphImpactOrder } from './graph-verify-order'
import { graphItemsProblem, graphListSchema, sameGraphClaim, type GraphItem } from './graph-items'
import { graphMergedVerdict } from './graph-merged-verdict'
import { graphPreVerifyItem } from './graph-pre-verify'
import { renderGraphReportEvidence } from './graph-report-evidence'
import { configFor, task, text } from './graph-test-harness'
import {
  planWorkflowGraph,
  type GraphCall,
  type GraphOutcome,
  type GraphConfig
} from './graph-plan'

const row = (title: string, severity = 'high') => ({
  title,
  severity,
  detail: `Concrete evidence for ${title} and the next step.`,
  location: `src/${title}.ts:10`,
  excerpt: 'const result = await run()',
  trigger: 'After an update',
  fix: 'Await the result'
})
const item = (key: string, title = key): GraphItem => ({
  ...row(title),
  severity: 'high',
  key,
  round: 1,
  sourceCallId: 'find/r1/a0',
  repeats: 0
})
function workflow(limit = 1) {
  return normalizeWorkflowSpec({
    title: 'Verification',
    template: 'discover',
    steps: [
      {
        id: 'find',
        kind: 'do',
        title: 'Find',
        agents: [{ route: 'claude' }],
        list: { maxItems: 6, evidence: true }
      },
      {
        id: 'verify',
        kind: 'review',
        title: 'Verify',
        agents: [{ route: 'codex' }, { route: 'grok' }, { route: 'claude' }],
        inputs: ['find'],
        forEach: { step: 'find', limit, order: 'impact', merge: 'root-cause' },
        escalate: { max: 1, crossFamily: true }
      },
      {
        id: 'report',
        kind: 'synthesize',
        title: 'Report',
        agents: [{ route: 'claude' }],
        inputs: ['verify']
      }
    ],
    repeat: { do: 'find', review: 'verify', until: 'nothing-new', maxRounds: 2 }
  })
}

function drive(
  spec: ReturnType<typeof workflow>,
  answer: (call: GraphCall) => unknown,
  change: Partial<GraphConfig> = {}
) {
  const outcomes = new Map<string, GraphOutcome>()
  const order: string[] = []
  const config = { ...configFor(spec), ...change }
  let plan = planWorkflowGraph(config, task, outcomes)
  for (let pass = 0; pass < 50 && plan.ready.length; pass++) {
    for (const call of plan.ready) {
      order.push(call.id)
      const value = answer(call)
      outcomes.set(call.id, value === undefined ? { failed: true } : { value })
    }
    plan = planWorkflowGraph(config, task, outcomes)
  }
  return { plan, order }
}

describe('Discover verification correctness', () => {
  it('9: spends round two on unchecked earlier findings before higher-impact new ones', () => {
    const { plan, order } = drive(workflow(), (call) => {
      if (call.stepId === 'find') {
        return { items: call.round === 1 ? [row('first'), row('overflow')] : [row('new')] }
      }
      if (call.id.endsWith('/impact')) {
        return {
          items: [
            { key: 'find.r1.1', impact: 5, why: 'first', sameAs: '' },
            { key: 'find.r1.2', impact: 4, why: 'backlog', sameAs: '' },
            ...(call.round === 2 ? [{ key: 'find.r2.1', impact: 5, why: 'new', sameAs: '' }] : [])
          ]
        }
      }
      return text('Traced the evidence.\nVERDICT: PASS')
    })
    expect(order).toContain('verify/r2/find.r1.2/a0')
    expect(order).not.toContain('verify/r2/find.r2.1/a0')
    expect(
      plan.runs.verify[1].targets!.find((target) => target.item.key === 'find.r1.2')?.tally
    ).toBe('confirmed')
  })

  it('15/16: triage sees earlier targets and re-reviews a reworded claim with fresh evidence', () => {
    let triage = ''
    const { plan, order } = drive(workflow(), (call) => {
      if (call.stepId === 'find') {
        return { items: [row(call.round === 1 ? 'original' : 'fresh location')] }
      }
      if (call.id.endsWith('/impact')) {
        triage = call.prompt
        return {
          items: [
            { key: 'find.r1.1', impact: 5, why: 'same mechanism', sameAs: '' },
            { key: 'find.r2.1', impact: 5, why: 'new evidence', sameAs: 'find.r1.1' }
          ]
        }
      }
      return text(
        call.round === 1
          ? 'Counterexample.\nVERDICT: FAIL'
          : 'REPORT 1: PASS\nREPORT 2: PASS\nVERDICT: PASS'
      )
    })
    expect(triage).toContain('for proposals consider expected benefit')
    expect(triage).toContain('same claim or proposal')
    expect(triage).toContain('original')
    expect(triage).toContain('fresh location')
    expect(order).toContain('verify/r2/find.r1.1/a0')
    expect(plan.outcome).toBeDefined()
    expect(plan.runs.verify[1].targets![0].tally).toBe('confirmed')
    expect(plan.runs.verify[1].targets![0].item.alsoReported?.[0].location).toBe(
      'src/fresh location.ts:10'
    )
  })

  it('13: a single FAIL beyond the escalation cap stays unverified', () => {
    const spec = workflow(2)
    delete spec.repeat
    spec.steps[1].forEach!.order = undefined
    spec.steps[1].forEach!.merge = undefined
    const { plan } = drive(spec, (call) =>
      call.stepId === 'find'
        ? { items: [row('a'), row('b')] }
        : text('Counterexample.\nVERDICT: FAIL')
    )
    expect(plan.runs.verify[0].targets!.map((target) => target.tally)).toEqual([
      'refuted',
      'unverified'
    ])
  })

  it('14: adjacent distinct claims never inherit a verdict by word overlap', () => {
    const a = row('Cache does not include locale')
    expect(
      sameGraphClaim(
        a as GraphItem,
        { ...a, title: 'Cache does not include user', location: 'src/cache.ts:11' } as GraphItem
      )
    ).toBe(false)
    expect(sameGraphClaim(a as GraphItem, { ...a, detail: `  ${a.detail}\n` } as GraphItem)).toBe(
      true
    )
    expect(sameGraphClaim(a as GraphItem, { ...a, excerpt: 'new evidence' } as GraphItem)).toBe(
      false
    )
  })

  it('14: every semantically merged report must be judged, and mixed verdicts stay unverified', () => {
    const group = { ...item('a'), alsoReported: [row('b') as GraphItem] }
    expect(graphMergedVerdict(group, 'VERDICT: PASS')).toBe('unsure')
    expect(graphMergedVerdict(group, 'REPORT 1: PASS\nREPORT 2: FAIL\nVERDICT: PASS')).toBe(
      'unsure'
    )
    expect(graphMergedVerdict(group, 'REPORT 1: PASS\nREPORT 2: PASS\nVERDICT: PASS')).toBe('pass')
  })

  it('51: a merged group retains a member passing quote and all evidence fields', () => {
    const a = { ...item('a'), evidence: { status: 'missing' as const } }
    const b = {
      ...item('b'),
      evidence: { status: 'found' as const },
      excerpt: 'a valid quote',
      trigger: 'second trigger'
    }
    const merged = graphMergeRootCauses([a, b], [{ key: 'b', sameAs: 'a', impact: 5, why: 'same' }])
      .items[0]!
    expect(merged).toMatchObject({
      evidence: { status: 'found', location: b.location, excerpt: 'a valid quote' },
      excerpt: a.excerpt,
      trigger: a.trigger
    })
    expect(merged!.alsoReported?.[0]).toMatchObject({
      excerpt: 'a valid quote',
      trigger: 'second trigger'
    })
  })

  it('52: synthesis receives trigger, excerpt, verdict and fix outside the detail budget', () => {
    const budget = new GraphInputBudget('Report')
    const finding = {
      ...item('a'),
      detail: 'x'.repeat(3000),
      trigger: 'unique trigger',
      excerpt: 'unique excerpt',
      fix: 'unique fix'
    }
    const report = renderGraphReportEvidence(
      'Verify',
      [{ item: finding, tally: 'confirmed', votes: [] }],
      budget
    )
    expect(report).toContain('Trigger: unique trigger')
    expect(report).toContain('Excerpt: unique excerpt')
    expect(report).toContain('Fix / next step: unique fix')
    expect(report).toContain('Verdict: confirmed')
  })

  it('53: drops a placeholder row while keeping valid finder rows and a gap', () => {
    const spec = workflow()
    spec.steps[0].list!.evidence = true
    delete spec.repeat
    const rows = [
      row('real'),
      {
        title: 'None',
        detail: 'No findings',
        severity: 'none',
        location: '',
        excerpt: '',
        trigger: ''
      }
    ]
    expect(validateJsonSchema(graphListSchema(6, true, true), { items: rows })).toEqual([])
    expect(graphItemsProblem({ items: rows }, true)).toBeNull()
    const { plan } = drive(spec, (call) =>
      call.stepId === 'find' ? { items: rows } : text('VERDICT: PASS')
    )
    expect(plan.runs.find[0].items!.map((entry) => entry.title)).toEqual(['real'])
    expect(plan.runs.find[0].notes.join(' ')).toContain('dropped 1 placeholder')
    expect(plan.outcome?.gaps.join(' ')).toContain('placeholder rows were discarded')
  })

  it('keeps the existing finder output contract outside Discover', () => {
    const spec = workflow()
    spec.template = 'investigate'
    delete spec.repeat
    const { fix: _fix, ...finding } = row('real')
    const { plan } = drive(spec, (call) =>
      call.stepId === 'find' ? { items: [finding] } : text('VERDICT: PASS')
    )
    const call = plan.calls.find((entry) => entry.stepId === 'find')!
    expect(call.prompt).toContain('excerpt and trigger.')
    expect(call.prompt).not.toContain('trigger and fix')
    expect(validateJsonSchema(call.schema, { items: [finding] })).toEqual([])
    expect(
      validateJsonSchema(call.schema, { items: [{ ...finding, fix: 'new field' }] })
    ).not.toEqual([])
  })

  it('54: bad-path rescue searches a useful fragment of an ellipsis excerpt', () => {
    const request = graphPreVerifyItem({
      ...row('cache'),
      key: 'a',
      excerpt: 'const verySpecificValue = lookup() ... return verySpecificValue'
    })
    expect(request?.probe).toBe('const verySpecificValue = lookup()')
  })

  it('26/55: searches in impact order, then lowers failed quote checks before the verify limit', () => {
    const spec = workflow()
    delete spec.repeat
    spec.steps[0].list!.evidence = true
    let searches: string[] = []
    const { order } = drive(
      spec,
      (call) => {
        if (call.stepId === 'find') {
          return { items: [row('lower'), row('higher')] }
        }
        if (call.id.endsWith('/impact')) {
          return {
            items: [
              { key: 'find.r1.1', impact: 4, why: 'lower', sameAs: '' },
              { key: 'find.r1.2', impact: 5, why: 'higher', sameAs: '' }
            ]
          }
        }
        if (call.evidence) {
          searches = call.evidence.items.map((entry) => entry.key)
          return {
            checks: { 'find.r1.1': { status: 'found' }, 'find.r1.2': { status: 'missing' } }
          }
        }
        return text('VERDICT: PASS')
      },
      { evidenceRules: 2 }
    )
    expect(searches).toEqual(['find.r1.2', 'find.r1.1'])
    expect(order).toContain('verify/find.r1.1/a0')
    expect(order).not.toContain('verify/find.r1.2/a0')
  })

  it('56: accepts a partial impact answer and fills missing findings by severity', () => {
    const rows = [{ key: 'a', impact: 2, why: 'small', sameAs: '' }]
    expect(graphImpactProblem({ items: rows }, ['a', 'b'], true)).toBeNull()
    expect(
      graphImpactOrder('Verify', [item('a'), item('b')], { value: { items: rows } }).ordered.map(
        (entry) => entry.key
      )
    ).toEqual(['b', 'a'])
  })

  it('12/57: every finder has an available cross-family verifier and Scout uses frontier', () => {
    const spec = workflowTemplate('discover', ['claude', 'gemini'])
    expect(
      spec.steps
        .find((step) => step.id === 'find')!
        .agents.every((agent) => agent.route === 'gemini')
    ).toBe(true)
    expect(spec.steps.find((step) => step.id === 'scout')!.agents).toEqual([{ route: 'claude' }])
    const single = workflowTemplate('discover', ['claude'])
    expect(
      validateWorkflowSpec(single, { available: ['claude'] })
        .problems.map((problem) => problem.message)
        .join(' ')
    ).toContain('Set up another model family')
  })
})
