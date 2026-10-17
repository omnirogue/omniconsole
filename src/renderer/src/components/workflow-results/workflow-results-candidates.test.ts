import { describe, expect, it } from 'vitest'
import type {
  LocalWorkflowGraphItem,
  LocalWorkflowGraphRun,
  LocalWorkflowView
} from '../../../../shared/local-workflow-view'
import type { WorkflowFindTrail } from '../../../../shared/workflow-find-trail'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { discoverRunView } from '../local-workflows/local-workflow-run.fixtures'
import { workflowView } from '../local-workflows/local-workflow-ui.fixtures'
import { workflowTargetTallyLabel } from '../workflow-graph/workflow-graph-labels'
import { workflowResults } from './workflow-results-candidates'

const item = (
  key: string,
  change: Partial<LocalWorkflowGraphItem> = {}
): LocalWorkflowGraphItem => ({
  key,
  title: `Finding ${key}`,
  detail: `Why ${key} breaks.`,
  location: `src/${key}.ts:3`,
  severity: 'medium',
  repeats: 0,
  ...change
})

function graphView(run: Partial<LocalWorkflowGraphRun>, state = 'completed'): LocalWorkflowView {
  return {
    ...workflowView(),
    executionId: 'run-1',
    state: state as LocalWorkflowView['state'],
    graphRun: {
      spec: workflowTemplate('discover', ['claude', 'codex', 'grok']),
      levels: {},
      steps: [],
      gaps: [],
      notes: [],
      ...run
    }
  }
}

const row = (n: number, kept = true) => ({
  key: `o${n}`,
  title: `Option ${n}`,
  detail: `Why option ${n} works.`,
  judgeText: `Option ${n}: Why option ${n} works.`,
  by: 'Claude',
  scores: [n === 2 ? 3 : null, 2],
  ...(kept ? { kept: true as const } : {})
})

const TRAIL: WorkflowFindTrail = {
  stage: 'done',
  pool: 40,
  source: 'generated',
  top: 5,
  overall: [],
  byCriterion: [],
  criteria: ['Cheap', 'Fast'],
  winner: { key: 'o2', title: 'Option 2', detail: '', by: 'Claude' },
  rows: [
    { ...row(2), score: 3.5, finalPlace: 1, finalist: true, facts: 'GitHub facts for a/b' },
    { ...row(1), check: { passed: false, score: 2 } },
    row(3, false)
  ]
}

describe('workflowResults', () => {
  it('offers the options Find the best kept, the winner ticked, with every score it got', () => {
    const results = workflowResults(
      graphView({ spec: workflowTemplate('find', ['claude']), find: TRAIL })
    )
    expect(results).toMatchObject({ kind: 'find', considered: 40 })
    expect(results!.candidates).toEqual([
      {
        id: 'run-1:o2',
        key: 'o2',
        title: 'Option 2',
        detail: 'Why option 2 works.',
        judgeText: 'Option 2: Why option 2 works.',
        score: 3.5,
        criteria: [
          { name: 'Cheap', score: 3 },
          { name: 'Fast', score: 2 }
        ],
        place: 1,
        winner: true,
        facts: 'GitHub facts for a/b',
        preselected: true
      },
      {
        id: 'run-1:o1',
        key: 'o1',
        title: 'Option 1',
        detail: 'Why option 1 works.',
        judgeText: 'Option 1: Why option 1 works.',
        criteria: [{ name: 'Fast', score: 2 }],
        check: { passed: false, score: 2 },
        preselected: false
      }
    ])
    // Nothing to act on until the run settles, or while Find has not finished.
    expect(
      workflowResults(graphView({ find: TRAIL, spec: workflowTemplate('find', []) }, 'running'))
    ).toBeUndefined()
    expect(workflowResults(graphView({ find: { ...TRAIL, stage: 'final' } }))).toBeUndefined()
  })

  it('marks an option JEV could not score as not scored, never as a low score', () => {
    const rows = [
      { ...row(2), score: 3.5, finalPlace: 1, finalist: true as const },
      {
        ...row(1),
        finalPlace: 2,
        finalist: true as const,
        notScored: 'JEV answered invalid_response'
      }
    ]
    const results = workflowResults(
      graphView({ spec: workflowTemplate('find', ['claude']), find: { ...TRAIL, rows } })
    )
    expect(results!.candidates[1]).toMatchObject({ key: 'o1', place: 2, notScored: true })
    expect(results!.candidates[1]).not.toHaveProperty('score')
    expect(results!.candidates[0]).not.toHaveProperty('notScored')
  })

  it('offers each reviewed finding once, as its latest round judged it, held-up ones ticked', () => {
    const verify = {
      id: 'verify',
      state: 'done' as const,
      agents: [],
      rounds: [
        {
          round: 1,
          state: 'done' as const,
          calls: [],
          notes: [],
          targets: [
            { ...item('a'), tally: 'unverified' as const, votes: [] },
            { ...item('b', { severity: 'none' }), tally: 'refuted' as const, votes: [] }
          ]
        },
        {
          round: 2,
          state: 'done' as const,
          calls: [],
          notes: [],
          targets: [
            { ...item('c', { severity: 'low' }), tally: 'confirmed' as const, votes: [] },
            {
              ...item('a', { severity: 'high' }),
              tally: 'confirmed' as const,
              votes: [],
              jev: { score: 3, reason: 'Clear trigger' }
            },
            { ...item('d'), tally: 'unverified' as const, votes: [], unchecked: true }
          ]
        }
      ]
    }
    const results = workflowResults(graphView({ steps: [verify] }))!
    expect(results.kind).toBe('discover')
    expect(
      results.candidates.map((entry) => [entry.key, entry.tally, entry.severity, entry.preselected])
    ).toEqual([
      ['a', 'confirmed', 'high', true],
      ['c', 'confirmed', 'low', true],
      ['d', 'unverified', 'medium', false],
      ['b', 'refuted', undefined, false]
    ])
    expect(results.candidates[0]).toMatchObject({
      id: 'run-1:a',
      location: 'src/a.ts:3',
      jev: { score: 3, reason: 'Clear trigger' }
    })
    expect(results.candidates[2]!.unchecked).toBe(true)
  })

  it("carries the app's quote check of each finding", () => {
    const verify = {
      id: 'verify',
      state: 'done' as const,
      agents: [],
      rounds: [
        {
          round: 1,
          state: 'done' as const,
          calls: [],
          notes: [],
          targets: [
            {
              ...item('a', { evidence: { status: 'missing' as const, line: 3 } }),
              tally: 'confirmed' as const,
              votes: []
            },
            { ...item('b'), tally: 'confirmed' as const, votes: [] }
          ]
        }
      ]
    }
    const { candidates } = workflowResults(graphView({ steps: [verify] }))!
    expect(candidates.map((entry) => [entry.key, entry.evidence, entry.preselected])).toEqual([
      ['a', 'missing', true],
      ['b', undefined, true]
    ])
  })

  it('never shows a claim the app left open as confirmed, and carries its checks, ranked or not', () => {
    const notFound = { id: 'W1', mark: 'not-in-page' as const, quote: 'fabricated' }
    const found = { id: 'W1', mark: 'found' as const, quote: 'Prices rise in May.' }
    const verify = {
      id: 'verify',
      state: 'done' as const,
      agents: [],
      rounds: [
        {
          round: 1,
          state: 'done' as const,
          calls: [],
          notes: [],
          targets: [
            // The reviewers passed both; the app settled only b's claim.
            { ...item('a'), tally: 'confirmed' as const, votes: [], webChecks: [] },
            { ...item('b'), tally: 'confirmed' as const, votes: [], webChecks: [found] }
          ]
        }
      ]
    }
    const claims = [
      { claim: 'A', status: 'open' as const, evidence: '', key: 'a', webChecks: [notFound] },
      { claim: 'B', status: 'confirmed' as const, evidence: '', key: 'b', webChecks: [found] }
    ]
    const { candidates } = workflowResults(graphView({ steps: [verify], claims }))!
    expect(
      candidates.map((entry) => [entry.key, entry.tally, entry.preselected, entry.webChecks])
    ).toEqual([
      ['b', 'confirmed', true, [found]],
      ['a', 'unverified', false, [notFound]]
    ])
  })

  it('orders each verdict by impact, then severity, never JEV, and puts JEV set-asides last', () => {
    const target = (key: string, change: Record<string, unknown>) => ({
      ...item(key),
      tally: 'unverified' as const,
      votes: [],
      ...change
    })
    const verify = {
      id: 'verify',
      state: 'done' as const,
      agents: [],
      rounds: [
        {
          round: 1,
          state: 'done' as const,
          calls: [],
          notes: [],
          // As JEV ranked them: reviewed best first, then over the limit, then set aside.
          targets: [
            target('a', { tally: 'confirmed', jev: { score: 3.9 }, severity: 'low' }),
            target('b', { tally: 'refuted', jev: { score: 3.1 } }),
            target('c', { tally: 'confirmed', jev: { score: 2.4 }, severity: 'critical' }),
            target('d', { unchecked: true, jev: { score: 1.2 } }),
            target('e', { unchecked: true, screened: true, jev: { score: 0.4 } })
          ]
        }
      ]
    }
    const { candidates } = workflowResults(graphView({ steps: [verify] }))!
    // Why not JEV's 3.9 over 2.4: on a real run JEV agreed with frontier impact at 0.06-0.13.
    expect(candidates.map((entry) => [entry.key, entry.preselected])).toEqual([
      ['c', true],
      ['a', true],
      ['d', false],
      ['b', false],
      ['e', false]
    ])
    expect(candidates[4]).toMatchObject({ screened: true, unchecked: true, jev: { score: 0.4 } })
    expect(candidates[2]!.screened).toBeUndefined()
    // A frontier triage's impact rating outranks the finder's severity.
    verify.rounds[0]!.targets[0] = target('a', {
      tally: 'confirmed',
      severity: 'low',
      impact: { score: 5, why: 'data loss' }
    })
    verify.rounds[0]!.targets[2] = target('c', {
      tally: 'confirmed',
      severity: 'critical',
      impact: { score: 3, why: 'one tool' }
    })
    const rated = workflowResults(graphView({ steps: [verify] }))!.candidates
    expect(rated.slice(0, 2).map((entry) => entry.key)).toEqual(['a', 'c'])
    // The report's ranking leads within each verdict; what it did not rank follows by impact.
    const ranked = workflowResults(
      graphView({
        steps: [verify],
        ranking: [
          { key: 'c', rank: 1, why: 'breaks every save', next: 'add a lock' },
          { key: 'd', rank: 2, why: 'maybe real', next: 'check it' }
        ]
      })
    )!.candidates
    expect(ranked.map((entry) => entry.key)).toEqual(['c', 'a', 'd', 'b', 'e'])
    expect(ranked[0]).toMatchObject({
      rank: 1,
      why: 'breaks every save',
      next: 'add a lock',
      impact: { score: 3 }
    })
    expect(ranked[2]).toMatchObject({ rank: 2, next: 'check it' })
    expect(ranked[1]!.rank).toBeUndefined()
    // In a run that reads pages the app's check of a reason travels with it, never left behind.
    const check = { id: 'W1', mark: 'not-in-page' as const, quote: 'fabricated' }
    const checked = workflowResults(
      graphView({
        steps: [verify],
        ranking: [{ key: 'c', rank: 1, why: '[W1] "fabricated"', next: '', webChecks: [check] }]
      })
    )!.candidates
    expect(checked[0]).toMatchObject({ key: 'c', why: '[W1] "fabricated"', webChecks: [check] })
    // Equal impact: the worse severity goes first.
    verify.rounds[0]!.targets[2] = target('c', {
      tally: 'confirmed',
      severity: 'critical',
      impact: { score: 5, why: 'outage' }
    })
    const tied = workflowResults(graphView({ steps: [verify] }))!.candidates
    expect(tied.slice(0, 2).map((entry) => entry.key)).toEqual(['c', 'a'])
  })

  it("keeps live JEV verify's set-aside and its p, apart from a reviewer's refutation", () => {
    const target = (key: string, change: Record<string, unknown>) => ({
      ...item(key),
      tally: 'refuted' as const,
      votes: [],
      ...change
    })
    const verify = {
      id: 'verify',
      state: 'done' as const,
      agents: [],
      rounds: [
        {
          round: 1,
          state: 'done' as const,
          calls: [],
          notes: [],
          targets: [
            target('a', { refutedBy: 'jev', jevVerify: 0.04, unchecked: true }),
            target('b', { jevVerify: 0.6 }),
            target('c', {
              tally: 'unverified',
              resurfaced: true,
              setAsideAt: 0.05,
              jevVerify: 0.05
            })
          ]
        }
      ]
    }
    const { candidates } = workflowResults(graphView({ steps: [verify] }))!
    const jev = candidates.find((entry) => entry.key === 'a')!
    const reviewer = candidates.find((entry) => entry.key === 'b')!
    expect(jev).toMatchObject({ tally: 'refuted', refutedBy: 'jev', jevVerify: 0.04 })
    expect(jev.preselected).toBe(false)
    expect(reviewer.refutedBy).toBeUndefined()
    expect(reviewer.jevVerify).toBe(0.6)
    expect(workflowTargetTallyLabel({ ...jev, tally: 'refuted' })).toBe('Set aside by JEV (p 0.04)')
    expect(workflowTargetTallyLabel({ ...reviewer, tally: 'refuted' })).toBe('Refuted')
    // Reopened by a later report: unverified, and it says why, never a bare Unverified.
    const reopened = candidates.find((entry) => entry.key === 'c')!
    expect(reopened).toMatchObject({ tally: 'unverified', resurfaced: true, setAsideAt: 0.05 })
    expect(reopened.refutedBy).toBeUndefined()
    expect(workflowTargetTallyLabel({ ...reopened, tally: 'unverified' })).toBe(
      'Unverified: reported again after JEV set it aside (p 0.05)'
    )
  })

  it('keeps a long ranking ahead of unranked results, and every verdict group apart', () => {
    const target = (key: string, tally: 'confirmed' | 'unverified', severity = 'medium') => ({
      ...item(key, { severity: severity as LocalWorkflowGraphItem['severity'] }),
      tally,
      votes: []
    })
    const confirmed = Array.from({ length: 1200 }, (_, index) => target(`c${index}`, 'confirmed'))
    const verify = {
      id: 'verify',
      state: 'done' as const,
      agents: [],
      rounds: [
        {
          round: 1,
          state: 'done' as const,
          calls: [],
          notes: [],
          targets: [
            target('loud', 'confirmed', 'critical'),
            ...confirmed,
            target('u', 'unverified')
          ]
        }
      ]
    }
    const ranking = [...confirmed.map((entry) => entry.key), 'u'].map((key, index) => ({
      key,
      rank: index + 1,
      why: 'w',
      next: 'n'
    }))
    const keys = workflowResults(graphView({ steps: [verify], ranking }))!.candidates.map(
      (entry) => entry.key
    )
    expect(keys.slice(0, 2)).toEqual(['c0', 'c1'])
    expect(keys.at(-2)).toBe('loud')
    expect(keys.at(-1)).toBe('u')
  })

  it('offers the last list a run made when nothing reviewed it, and nothing without one', () => {
    const spec = workflowTemplate('discover', ['claude'])
    const find = {
      id: 'find',
      state: 'done' as const,
      agents: [],
      rounds: [
        { round: 1, state: 'done' as const, calls: [], notes: [], items: [item('a')] },
        { round: 2, state: 'done' as const, calls: [], notes: [], items: [item('b')] }
      ]
    }
    const results = workflowResults(
      graphView({ spec: { ...spec, template: 'custom' }, steps: [find] })
    )!
    expect(results.kind).toBe('items')
    expect(results.candidates.map((entry) => [entry.key, entry.preselected])).toEqual([
      ['a', false],
      ['b', false]
    ])
    expect(workflowResults(graphView({ steps: [] }))).toBeUndefined()
    expect(workflowResults({ ...workflowView(), state: 'completed' })).toBeUndefined()
  })

  it('takes the list the run made last by its inputs, not by where the step is stored', () => {
    const agents = [{ route: 'claude' as const }]
    const done = (id: string, items: LocalWorkflowGraphItem[]) => ({
      id,
      state: 'done' as const,
      agents: [],
      rounds: [{ round: 1, state: 'done' as const, calls: [], notes: [], items }]
    })
    const results = workflowResults(
      graphView({
        spec: {
          version: 1,
          title: 'Refine',
          template: 'custom',
          steps: [
            {
              id: 'refined',
              kind: 'do',
              title: 'Refined',
              instruction: '',
              agents,
              inputs: ['raw'],
              list: { maxItems: 5 }
            },
            {
              id: 'raw',
              kind: 'do',
              title: 'Raw',
              instruction: '',
              agents,
              inputs: [],
              list: { maxItems: 5 }
            },
            {
              id: 'answer',
              kind: 'synthesize',
              title: 'Answer',
              instruction: '',
              agents,
              inputs: ['refined']
            }
          ]
        },
        steps: [done('refined', [item('r1')]), done('raw', [item('w1')]), done('answer', [])]
      })
    )!
    expect(results.candidates.map((entry) => entry.key)).toEqual(['r1'])
  })

  it('keeps the reports a finding merged, so the session sees every case it covers', () => {
    const merged = item('a', {
      alsoReported: [
        {
          title: 'Refund retry',
          detail: 'Seen in refunds too.',
          location: 'src/refund.ts:9',
          severity: 'high'
        },
        { title: 'Webhook retry', detail: 'And in webhooks.', location: ' ', severity: 'low' }
      ]
    })
    const results = workflowResults(
      graphView({
        steps: [
          {
            id: 'find',
            state: 'done',
            agents: [],
            rounds: [{ round: 1, state: 'done', calls: [], notes: [], items: [merged] }]
          }
        ]
      })
    )!
    expect(results.candidates[0]!.also).toEqual([
      { title: 'Refund retry', detail: 'Seen in refunds too.', location: 'src/refund.ts:9' },
      { title: 'Webhook retry', detail: 'And in webhooks.' }
    ])
  })

  it('offers every item of an older Discover report, all ticked because each one held up', () => {
    const results = workflowResults(discoverRunView())!
    expect(results).toEqual({
      kind: 'discover',
      candidates: [
        {
          id: 'execution-1:f1',
          key: 'f1',
          title: 'Retry drops the idempotency key',
          detail:
            'What goes wrong: A timeout followed by a retry charges the card twice.\n\nFix: Reuse the original key on retry.',
          location: 'src/checkout/pay.ts:142',
          severity: 'high',
          tally: 'confirmed',
          preselected: true
        }
      ]
    })
  })
})
