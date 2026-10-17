import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import type { WorkflowRoute } from '../../../../shared/workflow-graph'
import { graphCallSeatId } from '../local-workflow-graph-projection'
import { planWorkflowGraph, type GraphCall, type GraphOutcome } from './graph-plan'
import { graphImpactCall } from './graph-verify-order'
import { graphLoopTarget } from './graph-triage'
import { graphMergeLaterReports } from './graph-items'
import type { GraphItem, GraphSeverity } from './graph-items'
import type { GraphScope } from './graph-scope'
import { configFor, drive, SEATS, task, text } from './graph-test-harness'

const found = (title: string, severity: GraphSeverity = 'high') => ({
  title,
  detail: `How ${title} breaks.`,
  location: `src/${title.replace(/\s+/g, '-')}.ts:1`,
  severity
})

function spec(
  finders: WorkflowRoute[],
  reviewers: WorkflowRoute[],
  crossFamily = true,
  max = 4,
  standIn = false
) {
  return normalizeWorkflowSpec({
    title: 'Cross-family',
    steps: [
      {
        id: 'find',
        kind: 'do',
        title: 'Find',
        agents: finders.map((route) => ({ route })),
        list: { maxItems: 8 }
      },
      {
        id: 'verify',
        kind: 'review',
        title: 'Verify',
        agents: reviewers.map((route) => ({ route })),
        inputs: ['find'],
        forEach: { step: 'find', limit: 4 },
        escalate: {
          max,
          ...(crossFamily ? { crossFamily: true } : {}),
          ...(standIn ? { standIn: true } : {})
        }
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
}

const pass = (call: GraphCall, items: object[]) =>
  call.stepId === 'find'
    ? { items }
    : call.stepId === 'verify'
      ? text('Traced.\nVERDICT: PASS')
      : text('Report')

describe('the first reviewer is independent of every finder, or the item is not settled by one pass', () => {
  it('skips every family that reported a merged item', () => {
    // Claude and Codex both report the lost write; only Grok is independent of both.
    const plan = drive(spec(['claude', 'codex'], ['claude', 'codex', 'grok']), (call) =>
      pass(call, [found('lost write')])
    )
    const target = plan.runs.verify[0].targets![0]!
    expect(target.item.alsoFrom).toEqual(['find/a1'])
    expect(plan.calls.filter((call) => call.stepId === 'verify').map((call) => call.id)).toEqual([
      'verify/find.r1.1/a2'
    ])
  })

  it('sends the item to every reviewer when no other family is on the roster', () => {
    const plan = drive(spec(['claude'], ['claude', 'claude']), (call) =>
      pass(call, [found('lost write')])
    )
    expect(plan.calls.filter((call) => call.stepId === 'verify').map((call) => call.id)).toEqual([
      'verify/find.r1.1/a0',
      'verify/find.r1.1/a1'
    ])
    expect(plan.runs.verify[0].notes.join('\n')).toContain(
      'no reviewer from another model family than its finders was available (1)'
    )
    const report = plan.calls.find((call) => call.id === 'report/a0')!.prompt
    expect(report).not.toContain('confirmed by one review')
  })

  it('never confirms on a same-family pass alone, even past the escalation limit', () => {
    const plan = drive(spec(['claude'], ['claude', 'claude', 'claude'], true, 1), (call) =>
      pass(call, [found('lost write'), found('stale read')])
    )
    const targets = plan.runs.verify[0].targets!
    // The first escalates to all three; the second, past the limit of one, keeps its one pass.
    expect(targets.map((target) => [target.item.key, target.votes.filter(Boolean).length])).toEqual(
      [
        ['find.r1.1', 3],
        ['find.r1.2', 1]
      ]
    )
    expect(targets.every((target) => target.tally === 'unverified' && target.sameFamilyOnly)).toBe(
      true
    )
    expect(plan.runs.verify[0].notes.join('\n')).toContain(
      "2 items passed only by reviewers from their finders' own model families, so they stay unverified."
    )
    const report = plan.calls.find((call) => call.id === 'report/a0')!.prompt
    expect(report).toContain("passed only by reviewers from its finders' own model families")
  })

  it('marks a confirmation by another family as cross-checked', () => {
    const plan = drive(spec(['claude'], ['claude', 'codex']), (call) =>
      pass(call, [found('lost write')])
    )
    expect(plan.runs.verify[0].targets![0]).toMatchObject({
      tally: 'confirmed',
      crossChecked: true
    })
  })

  it('keeps every later finder of an item, so an aggregate review skips their families too', () => {
    const [merged] = graphMergeLaterReports(
      [
        {
          key: 'find.r1.1',
          ...found('lost write'),
          round: 1,
          sourceCallId: 'find/r1/a0',
          repeats: 0
        }
      ],
      [{ key: 'find.r1.1', report: found('lost writes'), from: 'find/r2/a1' }]
    )
    expect(merged!.alsoFrom).toEqual(['find/r2/a1'])
  })

  it('never counts an unknown family as independent', () => {
    const seats = SEATS.map((seat) =>
      seat.id === 'codex' ? { ...seat, lineage: 'unknown' as const } : seat
    )
    const plan = drive(
      spec(['claude'], ['codex', 'claude']),
      (call) => pass(call, [found('lost write')]),
      { seats }
    )
    expect(plan.calls.filter((call) => call.stepId === 'verify')).toHaveLength(2)
  })

  it('leaves older specs with the reviewer and report prompt they had', () => {
    const plan = drive(spec(['claude'], ['claude', 'codex'], false), (call) =>
      pass(call, [found('lost write')])
    )
    expect(plan.calls.filter((call) => call.stepId === 'verify').map((call) => call.id)).toEqual([
      'verify/find.r1.1/a0'
    ])
    const report = plan.calls.find((call) => call.id === 'report/a0')!.prompt
    expect(report).not.toContain('confirmed by one review')
    expect(report).not.toContain('impact')
  })
})

describe('a stand-in on another provider reviews an item whose first review gave no answer', () => {
  const ids = (plan: ReturnType<typeof drive>) =>
    plan.calls.filter((call) => call.stepId === 'verify').map((call) => call.id)
  // Codex is down: every review on it fails.
  const codexDown = (answer: (call: GraphCall) => unknown) => (call: GraphCall) =>
    call.stepId === 'verify' && call.seatId === 'codex' ? undefined : answer(call)
  const three = (standIn = true, max = 4) =>
    spec(['claude'], ['codex', 'grok', 'claude'], true, max, standIn)

  it('confirms on the stand-in alone, leaving the third reviewer out', () => {
    const plan = drive(
      three(),
      codexDown((call) => pass(call, [found('lost write'), found('stale read')]))
    )
    expect(ids(plan)).toEqual([
      'verify/find.r1.1/a0',
      'verify/find.r1.1/a1',
      'verify/find.r1.2/a0',
      'verify/find.r1.2/a1'
    ])
    const targets = plan.runs.verify[0].targets!
    expect(targets.map((target) => [target.tally, target.votes, target.voters])).toEqual([
      ['confirmed', ['pass'], [1]],
      ['confirmed', ['pass'], [1]]
    ])
    expect(targets.every((target) => target.crossChecked)).toBe(true)
    expect(plan.runs.verify[0].notes).toContain(
      'Verify: the first review of 2 items gave no answer, so a reviewer on another provider checked each instead.'
    )
  })

  it('leaves specs without the option as they were', () => {
    const plan = drive(
      three(false),
      codexDown((call) => pass(call, [found('lost write')]))
    )
    expect(ids(plan)).toEqual(['verify/find.r1.1/a0', 'verify/find.r1.1/a1', 'verify/find.r1.1/a2'])
  })

  it('stands in for at most `max` items a round, in order; the rest may still escalate', () => {
    const plan = drive(
      three(true, 1),
      codexDown((call) =>
        pass(call, [found('lost write'), found('stale read'), found('slow flush')])
      )
    )
    const targets = plan.runs.verify[0].targets!
    expect(targets.map((target) => [target.item.key, target.tally, target.votes])).toEqual([
      ['find.r1.1', 'confirmed', ['pass']],
      ['find.r1.2', 'confirmed', [null, 'pass', 'pass']],
      ['find.r1.3', 'unverified', [null]]
    ])
    const notes = plan.runs.verify[0].notes.join('\n')
    expect(notes).toContain(
      'Verify: the first review of 3 items gave no answer, so a reviewer on another provider checked 1 of them instead; the other 2 had none, past the limit of 1 a round.'
    )
    expect(notes).toContain(
      'Verify: 1 item went to 3 reviewers (the first review did not pass, or the item is critical); 1 more kept one review, past the limit of 1 a round.'
    )
  })

  it("takes the next agent on another provider, and none from the finder's own family", () => {
    const twoCodex = drive(
      spec(['claude'], ['codex', 'codex', 'grok'], true, 4, true),
      codexDown((call) => pass(call, [found('lost write')]))
    )
    expect(ids(twoCodex)).toEqual(['verify/find.r1.1/a0', 'verify/find.r1.1/a2'])
    // Grok found it, so only Codex is independent: no stand-in; the failed review escalates.
    const grokFound = drive(
      spec(['grok'], ['codex', 'grok'], true, 4, true),
      codexDown((call) => pass(call, [found('lost write')]))
    )
    expect(ids(grokFound)).toEqual(['verify/find.r1.1/a0', 'verify/find.r1.1/a1'])
    expect(grokFound.runs.verify[0].notes.join('\n')).not.toContain('gave no answer')
    expect(grokFound.runs.verify[0].targets![0]!.tally).toBe('unverified')
  })

  it('stands in for an answer with no verdict, but an unsure one escalates as before', () => {
    const plan = drive(three(), (call) =>
      call.id === 'verify/find.r1.1/a0'
        ? text('I could not open the file.')
        : call.id === 'verify/find.r1.2/a0'
          ? text('Maybe.\nVERDICT: UNSURE')
          : pass(call, [found('lost write'), found('stale read')])
    )
    expect(ids(plan)).toEqual([
      'verify/find.r1.1/a0',
      'verify/find.r1.1/a1',
      'verify/find.r1.2/a0',
      'verify/find.r1.2/a1',
      'verify/find.r1.2/a2'
    ])
    expect(plan.runs.verify[0].targets!.map((target) => [target.tally, target.votes])).toEqual([
      ['confirmed', ['pass']],
      ['confirmed', ['unsure', 'pass', 'pass']]
    ])
  })

  it('escalates no further when the stand-in was the only other agent', () => {
    const plan = drive(
      spec(['claude'], ['codex', 'grok'], true, 4, true),
      codexDown((call) =>
        call.stepId === 'verify'
          ? text('Refuted by the lock.\nVERDICT: FAIL')
          : pass(call, [found('lost write')])
      )
    )
    expect(ids(plan)).toEqual(['verify/find.r1.1/a0', 'verify/find.r1.1/a1'])
    expect(plan.runs.verify[0].targets![0]).toMatchObject({ tally: 'refuted', votes: ['fail'] })
    expect(plan.runs.verify[0].notes.join('\n')).not.toContain('went to 2 reviewers')
  })

  it('lists an item as verified once its stand-in passes, while another still runs', () => {
    const outcomes = new Map<string, GraphOutcome>([
      ['find/a0', { value: { items: [found('lost write'), found('stale read')] } }],
      ['verify/find.r1.1/a0', { failed: true }],
      ['verify/find.r1.2/a0', { failed: true }],
      ['verify/find.r1.1/a1', { value: text('Traced.\nVERDICT: PASS') }]
    ])
    const plan = planWorkflowGraph(configFor(three()), task, outcomes)
    expect(plan.ready.map((call) => call.id)).toEqual(['verify/find.r1.2/a1'])
    expect(plan.runs.verify[0].verifiedEarly?.map((target) => target.item.key)).toEqual([
      'find.r1.1'
    ])
  })
})

describe('impact triage evidence', () => {
  const item = (n: number, change: Partial<GraphItem> = {}): GraphItem => ({
    key: `find.r1.${n}`,
    title: `Result ${n} ${'t'.repeat(300)}`,
    detail: 'd'.repeat(4000),
    location: `src/${'p'.repeat(300)}.ts:1`,
    severity: 'low',
    round: 1,
    sourceCallId: 'find/a0',
    repeats: 0,
    ...change
  })
  const scope = { task: { prompt: 'Goal' }, seatFor: () => 'claude' } as unknown as GraphScope
  const step = spec(['claude'], ['codex']).steps[1]!

  it('shows every merged claim, since a severe variant makes the item severe', () => {
    const { call } = graphImpactCall(scope, {
      step,
      round: 1,
      inLoop: false,
      items: [
        item(1, {
          alsoReported: [{ ...found('token leak', 'critical'), detail: 'Leaks the key.' }]
        })
      ],
      dependencies: []
    })
    expect(call.prompt).toContain('also reported as (critical) token leak')
    expect(call.prompt).toContain('Leaks the key.')
  })

  it('fits hundreds of long results into the prompt budget without losing a key', () => {
    const items = Array.from({ length: 400 }, (_, index) => item(index + 1))
    const { call, cuts } = graphImpactCall(scope, {
      step,
      round: 1,
      inLoop: false,
      items,
      dependencies: []
    })
    expect(call.prompt.length).toBeLessThan(200_000)
    expect(cuts.length).toBeGreaterThan(0)
    for (const entry of items) {
      expect(call.prompt).toContain(`[${entry.key}]`)
    }
  })

  it('keeps every merged claim visible when the prompt must be cut', () => {
    const items = Array.from({ length: 203 }, (_, index) =>
      item(index + 1, {
        alsoReported: [{ ...found(`variant ${index + 1}`, 'critical'), detail: 'x'.repeat(4000) }]
      })
    )
    const { call, cuts } = graphImpactCall(scope, {
      step,
      round: 1,
      inLoop: false,
      items,
      dependencies: []
    })
    expect(cuts.length).toBeGreaterThan(0)
    for (let n = 1; n <= 203; n++) {
      expect(call.prompt).toContain(`also reported as (critical) variant ${n}:`)
    }
  })

  it("keeps a round's impact on the loop's aggregate item, and names the triage's model", () => {
    const merged = item(1, { impact: undefined, alsoReported: [found('later')] })
    const target = {
      item: item(1, { jev: { score: 3 }, impact: { score: 5, why: 'data loss' } }),
      votes: [],
      texts: [],
      tally: 'confirmed' as const
    }
    expect(graphLoopTarget(target, merged).item).toMatchObject({
      jev: { score: 3 },
      impact: { score: 5, why: 'data loss' },
      alsoReported: [found('later')]
    })
    const snapshot = { graph: { agentSeats: { verify: ['seat-0', 'seat-1'] } } }
    expect(graphCallSeatId(snapshot as never, 'verify/impact')).toBe('seat-0')
    expect(graphCallSeatId(snapshot as never, 'verify/r2/impact')).toBe('seat-0')
    expect(graphCallSeatId(snapshot as never, 'verify/find.r1.1/a1')).toBe('seat-1')
  })
})
