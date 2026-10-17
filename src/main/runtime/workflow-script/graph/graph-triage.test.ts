import { graphDiscoverVerifyAdmission } from './graph-discover-rules'
import { describe, expect, it } from 'vitest'
import type { ResolvedLocalWorkflowSeat } from '../../../../shared/local-workflow-seats'
import type { WorkflowSpec } from '../../../../shared/workflow-graph'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { describeWorkflow, planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { screenedDiscover } from '../../../../shared/workflow-discover-screen.test-fixture'
import { createWorkflowProgramContext, type WorkflowProgramCall } from '../workflow-program-context'
import { runWorkflowGraphProgram } from './graph-program'
import {
  planWorkflowGraph,
  type GraphCall,
  type GraphConfig,
  type GraphOutcome
} from './graph-plan'
import {
  GRAPH_DEFAULT_SCREEN_RUBRIC,
  graphBriefRubric,
  graphScreenCall,
  graphTriage
} from './graph-triage'
import { graphReviewGist, renderGraphReportEvidence } from './graph-report-evidence'
import { fitGraphPrompt, GRAPH_MAX_PROMPT_INPUT_CHARS } from './graph-prompts'
import { graphJevCallViews } from './graph-jev-view'
import type { GraphItem } from './graph-items'

const seat = (
  route: 'claude' | 'codex' | 'grok' | 'gemini',
  lineage: ResolvedLocalWorkflowSeat['lineage']
) => ({
  id: `seat-${route}`,
  agent: route,
  accountId: 'a',
  model: `${route}-model`,
  effort: null,
  lineage,
  policyRevision: 'p'
})
const SEATS = [
  seat('claude', 'anthropic'),
  seat('codex', 'openai'),
  seat('grok', 'xai'),
  seat('gemini', 'google')
]

function configFor(
  spec: WorkflowSpec,
  screen?: (call: GraphCall) => Promise<GraphOutcome>
): GraphConfig {
  return {
    spec,
    ...graphDiscoverVerifyAdmission(spec),
    seats: SEATS as ResolvedLocalWorkflowSeat[],
    access: 'frozen',
    agentSeats: Object.fromEntries(
      spec.steps.map((step) => [step.id, step.agents.map((agent) => `seat-${agent.route}`)])
    ),
    ...(screen ? { screenWithJev: screen } : {})
  }
}

/** A fake durable port that records every agent call and its outcome. */
function fakeContext(respond: (call: WorkflowProgramCall) => unknown) {
  const calls: WorkflowProgramCall[] = []
  const logs: string[] = []
  const outcomes = new Map<string, GraphOutcome>()
  const context = createWorkflowProgramContext({
    agent: async (call) => {
      calls.push(call)
      await Promise.resolve()
      const value = respond(call)
      outcomes.set(call.id, { value })
      return value
    },
    phase: () => {},
    log: (message) => logs.push(message),
    guard: () => {},
    isFatal: () => false
  })
  return { context, calls, logs, outcomes }
}

const task = { prompt: 'Find defects in the store.', evidence: '' }
const finding = (title: string, severity = 'high') => ({
  title,
  detail: `How ${title} breaks.`,
  location: `src/${title.replace(/\s+/g, '-')}.ts:1`,
  severity
})

// Brief → one Do listing findings → a screened, escalating Verify → Report.
const spec = normalizeWorkflowSpec({
  title: 'Triage',
  steps: [
    { id: 'brief', kind: 'do', title: 'Brief', agents: [{ route: 'claude' }] },
    {
      id: 'find',
      kind: 'do',
      title: 'Find',
      agents: [{ route: 'claude' }],
      inputs: ['brief'],
      list: { maxItems: 8 }
    },
    {
      id: 'verify',
      kind: 'review',
      title: 'Verify',
      agents: [{ route: 'codex' }, { route: 'grok' }, { route: 'claude' }],
      inputs: ['brief', 'find'],
      forEach: { step: 'find', limit: 3, screen: { rubricFrom: 'brief' } },
      escalate: { max: 1 }
    },
    {
      id: 'report',
      kind: 'synthesize',
      title: 'Report',
      agents: [{ route: 'claude' }],
      inputs: ['verify']
    }
  ]
})

const BRIEF = [
  '## Scope',
  'SCOPE: OK',
  '## Rubric',
  '- Is it a real defect in the store?',
  '- Does it quote the code?',
  '## Severity',
  '- critical: data loss'
].join('\n')

describe('screening and escalating a review step', () => {
  it('reads the rubric from the brief, and only its Rubric section', () => {
    expect(graphBriefRubric(BRIEF)).toBe(
      '- Is it a real defect in the store?\n- Does it quote the code?'
    )
    expect(graphBriefRubric('## Scope\n- only one bullet elsewhere')).toBeUndefined()
  })

  it('orders by JEV score, sets aside non-findings, and keeps an unscored item in the middle', () => {
    const item = (key: string, severity: GraphItem['severity']): GraphItem =>
      ({
        key,
        title: key,
        detail: '',
        location: '',
        severity,
        round: 1,
        sourceCallId: 'x',
        repeats: 0
      }) as GraphItem
    const items = [item('a', 'critical'), item('b', 'low'), item('c', 'high'), item('d', 'high')]
    const triage = graphTriage('Verify', items, { value: { scores: { a: 0.8, b: 3.9, c: 2.5 } } })
    expect(triage.ordered.map((entry) => [entry.key, entry.jev?.score])).toEqual([
      ['b', 3.9],
      ['c', 2.5],
      ['d', undefined]
    ])
    expect(triage.setAside.map((entry) => entry.key)).toEqual(['a'])
    expect(triage.note).toBe(
      'Verify: JEV screened 4 items (1 it could not score); 1 scored below 1 of 4 and were set aside as non-findings; the reviewers took the rest best first.'
    )
    // A failed screen falls back to the unscreened order: severity.
    const fallback = graphTriage('Verify', items, { value: { error: 'no key' } })
    expect(fallback.ordered.map((entry) => entry.key)).toEqual(['a', 'c', 'd', 'b'])
    expect(fallback.setAside).toEqual([])
  })

  it('verifies the best findings with one review, escalates doubt, and reports compact evidence', async () => {
    const screens: GraphCall[] = []
    const { context, calls, logs, outcomes } = fakeContext((call) => {
      if (call.id === 'brief/a0') {
        return { markdown: BRIEF }
      }
      if (call.id === 'find/a0') {
        return {
          items: [
            finding('noise note', 'none'),
            finding('lost write'),
            finding('stale read', 'critical'),
            finding('slow flush', 'medium'),
            finding('double count', 'low')
          ]
        }
      }
      if (call.id.startsWith('verify')) {
        // The first review passes everything except the slow flush, which it cannot settle.
        return call.id.includes('find.r1.4') && call.id.endsWith('a0')
          ? { markdown: 'The flush path is guarded upstream, maybe.\nVERDICT: UNSURE' }
          : { markdown: `Traced it: the defect is real in src.\nVERDICT: PASS` }
      }
      return { markdown: 'Report' }
    })
    const screen = async (call: GraphCall): Promise<GraphOutcome> => {
      screens.push(call)
      return {
        value: {
          scores: {
            'find.r1.1': 0.4,
            'find.r1.2': 3.8,
            'find.r1.3': 3.5,
            'find.r1.4': 3.1,
            'find.r1.5': 1.9
          }
        }
      }
    }
    const result = await runWorkflowGraphProgram(context, configFor(spec, screen), task)
    expect(result.final.markdown).toBe('Report')
    expect(screens).toHaveLength(1)
    expect(screens[0].screen!.rubric).toBe(graphBriefRubric(BRIEF))
    expect(screens[0].screen!.candidates.map((candidate) => candidate.id)).toEqual([
      'find.r1.1',
      'find.r1.2',
      'find.r1.3',
      'find.r1.4',
      'find.r1.5'
    ])
    const verify = calls.map((call) => call.id).filter((id) => id.startsWith('verify'))
    // The noise note was set aside; the best three got one review; of the two that asked for more
    // (critical stale read, unsure slow flush) only the first in JEV order fit the limit of one.
    expect(verify).toEqual([
      'verify/find.r1.2/a0',
      'verify/find.r1.3/a0',
      'verify/find.r1.4/a0',
      'verify/find.r1.3/a1',
      'verify/find.r1.3/a2'
    ])
    expect(logs).toContain(
      'Verify: 1 item went to 3 reviewers (the first review did not pass, or the item is critical); 1 more kept one review, past the limit of 1 a round.'
    )
    const report = calls.find((call) => call.id === 'report/a0')!.prompt
    expect(report).toContain('### Confirmed (2)')
    expect(report).toContain('### Unverified after review (1)')
    expect(report).toContain('### Not checked, over the verification limit (1)')
    expect(report).toContain(
      '### Set aside by JEV as non-findings (1)\n1. **noise note** — src/noise-note.ts:1 · JEV 0.4/4'
    )
    expect(report).toContain('JEV 3.8/4')
    expect(report).not.toContain('How noise note breaks.')
    // Replanning from the settled outcomes (as the view and a replay do) gives the same run.
    outcomes.set(screens[0].id, await screen(screens[0]))
    const plan = planWorkflowGraph(configFor(spec, screen), task, outcomes)
    const targets = plan.runs.verify[0].targets!
    expect(
      targets.map((target) => [
        target.item.key,
        target.tally,
        target.votes.length,
        !!target.screened
      ])
    ).toEqual([
      ['find.r1.2', 'confirmed', 1, false],
      ['find.r1.3', 'confirmed', 3, false],
      ['find.r1.4', 'unverified', 1, false],
      ['find.r1.5', 'unverified', 3, false],
      ['find.r1.1', 'unverified', 3, true]
    ])
  })

  it('escalates nothing until every first review is in', () => {
    const outcomes = new Map<string, GraphOutcome>([
      ['brief/a0', { value: { markdown: BRIEF } }],
      ['find/a0', { value: { items: [finding('lost write'), finding('stale read')] } }],
      ['verify/screen', { value: { scores: { 'find.r1.1': 3, 'find.r1.2': 3 } } }],
      ['verify/find.r1.1/a0', { value: { markdown: 'Refuted by the lock.\nVERDICT: FAIL' } }]
    ])
    const plan = planWorkflowGraph(configFor(spec), task, outcomes)
    expect(plan.ready.map((call) => call.id)).toEqual(['verify/find.r1.2/a0'])
  })

  it('counts, validates and bounds screening and escalation', () => {
    expect(planWorkflowCalls(spec).perStep.verify).toBe(3 + 1 * 2)
    const discover = screenedDiscover()
    expect(
      validateWorkflowSpec(discover, { available: ['claude', 'codex', 'grok'] }).problems
    ).toEqual([])
    // 153 agent calls, and the app's quote check once in each of the two rounds.
    expect(planWorkflowCalls(discover).total).toBe(155)
    expect(planWorkflowCalls(discover).agentTotal).toBe(153)
    expect(describeWorkflow(discover)).toContain(
      'Verify: 1 agent reviews for each item from Find using Brief, after JEV sets aside non-items, with repeats of one root cause merged, most important first; the first reviewer is from another model family than the finder, and the other 2 agents join on up to 8 items a round that do not pass or are critical.'
    )
    const broken = normalizeWorkflowSpec({
      ...spec,
      steps: spec.steps.map((step) =>
        step.id === 'verify'
          ? {
              ...step,
              agents: [{ route: 'codex' }],
              forEach: { step: 'find', limit: 99, screen: { rubricFrom: 'report' } }
            }
          : step
      )
    })
    const verify = broken.steps.find((step) => step.id === 'verify')!
    expect(verify.forEach!.limit).toBe(48)
    expect(
      validateWorkflowSpec(broken, { available: ['claude', 'codex', 'grok'] }).problems.map(
        (problem) => problem.message
      )
    ).toEqual(
      expect.arrayContaining([
        'Verify takes its screening rubric from a step it does not read.',
        'Verify escalates to more reviewers, so it needs at least two.'
      ])
    )
    expect(GRAPH_DEFAULT_SCREEN_RUBRIC.split('\n')).toHaveLength(5)
  })

  it("keeps a review's point when compacting it", () => {
    expect(
      graphReviewGist(
        '## Trace\n\n**The parse is as reported.** `x` splits on `;`.\n\nVERDICT: PASS'
      )
    ).toBe('The parse is as reported. `x` splits on `;`.')
  })

  it('keeps screen scores and merged reports through the Discover loop to the report', async () => {
    const discover = screenedDiscover()
    const found = (title: string, location: string) => ({
      title,
      detail: `A concrete failure scenario for ${title}.`,
      location,
      severity: 'high'
    })
    const screens: GraphCall[] = []
    const { context, calls } = fakeContext((call) => {
      if (call.id === 'brief/a0') {
        return { markdown: BRIEF }
      }
      if (call.id === 'scout/a0') {
        return {
          items: [{ title: 'Cache', detail: 'The cache.', location: 'src/cache', severity: 'none' }]
        }
      }
      if (call.id.startsWith('find/r1')) {
        return { items: [found('Cache key ignores locale', 'src/cache/key.ts:10')] }
      }
      if (call.id.startsWith('find/r2')) {
        // A later round reports it again with a different claim nearby: merged, not dropped.
        return { items: [found('Cache keys ignore the locale on reload', 'src/cache/key.ts:14')] }
      }
      if (call.id.endsWith('/impact')) {
        return {
          items: [
            { key: 'find.r1.1', impact: 3, why: 'same mechanism', sameAs: '' },
            { key: 'find.r2.1', impact: 3, why: 'new evidence', sameAs: 'find.r1.1' }
          ]
        }
      }
      if (call.id.startsWith('verify')) {
        return {
          markdown:
            'REPORT 1: PASS\nREPORT 2: PASS\nTraced it through the key builder.\nVERDICT: PASS'
        }
      }
      return { markdown: 'Report' }
    })
    const screen = async (call: GraphCall): Promise<GraphOutcome> => {
      screens.push(call)
      return { value: { scores: { 'find.r1.1': 3.5 } } }
    }
    await runWorkflowGraphProgram(context, configFor(discover, screen), task)
    expect(screens.map((call) => call.id)).toEqual(['verify/r1/screen', 'verify/r2/screen'])
    const report = calls.find((call) => call.id === 'report/a0')!.prompt
    expect(report).toContain('**Cache key ignores locale** — src/cache/key.ts:10')
    expect(report).toContain('JEV 3.5/4')
    expect(report).toContain(
      'also reported as: Cache keys ignore the locale on reload — src/cache/key.ts:14'
    )
  })

  it('re-reviews a set-aside finding when a later round supplies new evidence', async () => {
    const discover = screenedDiscover()
    const found = (title: string, location: string) => ({
      title,
      detail: `Evidence for ${title}.`,
      location,
      severity: 'high'
    })
    const { context, calls } = fakeContext((call) => {
      if (call.id === 'brief/a0') {
        return { markdown: BRIEF }
      }
      if (call.id === 'scout/a0') {
        return {
          items: [{ title: 'Cache', detail: 'The cache.', location: 'src/cache', severity: 'none' }]
        }
      }
      if (call.id.startsWith('find/r1')) {
        return { items: [found('Cache key ignores locale', 'src/cache/key.ts:10')] }
      }
      if (call.id.startsWith('find/r2')) {
        return { items: [found('Cache key ignores locale on reload', 'src/cache/key.ts:12')] }
      }
      if (call.id.endsWith('/impact')) {
        return {
          items: [
            { key: 'find.r1.1', impact: 3, why: 'same mechanism', sameAs: '' },
            { key: 'find.r2.1', impact: 3, why: 'new evidence', sameAs: 'find.r1.1' }
          ]
        }
      }
      if (call.id.startsWith('verify/')) {
        return { markdown: 'VERDICT: UNSURE' }
      }
      return { markdown: 'Report' }
    })
    const screen = async (): Promise<GraphOutcome> => ({
      value: { scores: { 'find.r1.1': 0.2 } }
    })
    await runWorkflowGraphProgram(context, configFor(discover, screen), task)
    expect(calls.some((call) => call.id.startsWith('verify/r1/') && /a\d+$/.test(call.id))).toBe(
      false
    )
    expect(calls.some((call) => call.id.startsWith('verify/r2/find.r1.1/'))).toBe(true)
    const report = calls.find((call) => call.id === 'report/a0')!.prompt
    expect(report).toContain('### Unverified after review (1)')
    expect(report).toContain(
      'also reported as: Cache key ignores locale on reload — src/cache/key.ts:12'
    )
    expect(report).not.toContain('### Set aside by JEV')
  })

  it('screens every merged report, and fits a large report in the budget without losing an item', () => {
    const merged: GraphItem = {
      key: 'find.r1.1',
      title: 'Lost write',
      detail: 'The flush drops it.',
      location: 'src/a.ts:1',
      severity: 'high',
      round: 1,
      sourceCallId: 'x',
      repeats: 0,
      alsoReported: [
        {
          title: 'Retry duplicates',
          detail: 'A retry writes twice.',
          location: 'src/b.ts:9',
          severity: 'high'
        }
      ]
    } as GraphItem
    const call = graphScreenCall(
      { task, config: { spec } } as unknown as Parameters<typeof graphScreenCall>[0],
      {
        step: spec.steps[2],
        round: 1,
        inLoop: false,
        items: [merged],
        settled: [],
        dependencies: []
      }
    )
    expect(call.screen!.candidates[0].text).toContain(
      'Also reported as: Retry duplicates (src/b.ts:9)'
    )
    // A long first report never crowds out the merged one, and is itself sent whole.
    const long = { ...merged, detail: 'd'.repeat(5000) }
    const longText = graphScreenCall(
      { task, config: { spec } } as unknown as Parameters<typeof graphScreenCall>[0],
      {
        step: spec.steps[2],
        round: 1,
        inLoop: false,
        items: [long],
        settled: [],
        dependencies: []
      }
    ).screen!.candidates[0].text
    expect(longText).toContain('d'.repeat(5000))
    expect(longText).toContain(
      'Also reported as: Retry duplicates (src/b.ts:9)\nA retry writes twice.'
    )
    // Reported more than once, it is never set aside, however JEV scores it.
    const triage = graphTriage('Verify', [long], { value: { scores: { 'find.r1.1': 0.2 } } })
    expect(triage.setAside).toEqual([])
    expect(triage.note).toContain(
      '1 scored as low but were reported more than once, so they stayed'
    )
    // 300 findings with long details and reviews: every one keeps its identifying line.
    const targets = Array.from({ length: 300 }, (_, index) => ({
      item: {
        ...merged,
        key: `find.r1.${index}`,
        title: `Finding ${index}`,
        detail: 'x'.repeat(5000),
        alsoReported: [
          {
            title: `Variant ${index}`,
            detail: 'y'.repeat(2000),
            location: `src/v${index}.ts:2`,
            severity: 'high' as const
          }
        ]
      },
      tally: index % 3 === 0 ? ('unverified' as const) : ('confirmed' as const),
      ...(index >= 120 ? { unchecked: true } : {}),
      votes: ['A', 'B', 'C'].map((name) => ({
        name,
        verdict: 'pass' as const,
        markdown: `${'Because the path is reachable. '.repeat(40)}\nVERDICT: PASS`
      }))
    }))
    const { prompt, cuts } = fitGraphPrompt('Report', (budget) =>
      renderGraphReportEvidence('Verify', targets, budget)
    )
    // Inputs share the budget; each cut's marker and the headings sit outside it.
    expect(prompt.length).toBeLessThan(GRAPH_MAX_PROMPT_INPUT_CHARS * 1.1)
    expect(cuts.length).toBeGreaterThan(0)
    for (let index = 0; index < 300; index++) {
      expect(prompt).toContain(`**Finding ${index}**`)
      expect(prompt).toContain(`also reported as: Variant ${index} — src/v${index}.ts:2`)
    }
  })

  it('shows a failed screen as failed, with its reason', () => {
    const [view] = graphJevCallViews({
      'verify/r1/screen': {
        digest: 'd',
        outcome: {
          value: { markdown: 'JEV could not screen the options: no key.', error: 'no key' }
        },
        detail: 'no key',
        at: 1
      }
    })
    expect(view.state).toBe('failed')
    expect(view.error).toBe('JEV could not screen: no key')
    expect(view.resultMarkdown).toContain('could not screen')
  })
})
