import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import {
  graphImpactProblem,
  graphMergeRootCauses,
  graphWithMergedRepeats
} from './graph-impact-answer'
import { graphLoopTarget } from './graph-triage'
import type { GraphItem, GraphSeverity } from './graph-items'
import type { GraphCall } from './graph-plan'
import { drive, text } from './graph-test-harness'

const item = (n: number, change: Partial<GraphItem> = {}): GraphItem => ({
  key: `find.r1.${n}`,
  title: `Result ${n}`,
  detail: `Detail ${n}.`,
  location: `src/f${n}.ts:${n}`,
  severity: 'medium',
  round: 1,
  sourceCallId: `find/a${n}`,
  repeats: 0,
  ...change
})
const row = (n: number, impact: number, sameAs = '') => ({
  key: `find.r1.${n}`,
  impact,
  why: `why ${n}`,
  sameAs
})

describe('merging repeats of one root cause', () => {
  it('folds a chain of repeats into its earliest result, keeping every claim and finder', () => {
    const items = [
      item(1, { impact: { score: 3, why: 'x' } }),
      item(2),
      item(3, { severity: 'critical' as GraphSeverity, impact: { score: 5, why: 'y' } }),
      item(4)
    ]
    const { items: kept, merged } = graphMergeRootCauses(items, [
      row(1, 3),
      row(2, 2),
      row(3, 5, 'find.r1.2'),
      row(4, 1, 'find.r1.1')
    ])
    expect(merged).toBe(2)
    expect(kept.map((entry) => entry.key)).toEqual(['find.r1.1', 'find.r1.2'])
    // A result that absorbed nothing is the very same object.
    expect(kept[0]).not.toBe(items[0])
    expect(kept[0]!.alsoReported?.map((report) => report.title)).toEqual(['Result 4'])
    expect(kept[0]!.alsoFrom).toEqual(['find/a4'])
    expect(kept[1]).toMatchObject({
      severity: 'critical',
      reportedSeverity: 'medium',
      impact: { score: 5 },
      alsoFrom: ['find/a3'],
      repeats: 1
    })
    const untouched = graphMergeRootCauses(items, [row(1, 3), row(2, 2), row(3, 5), row(4, 1)])
    expect(untouched.items).toEqual(items)
    expect(untouched.items[0]).toBe(items[0])
  })

  it('merges only into an earlier listed result, and asks again for anything else', () => {
    const keys = ['find.r1.1', 'find.r1.2']
    const answer = (sameAs: string) => ({ items: [row(1, 2, sameAs), row(2, 2)] })
    expect(graphImpactProblem(answer('find.r1.2'), keys, true)).toContain('earlier listed result')
    expect(graphImpactProblem(answer('find.r1.1'), keys, true)).toContain('earlier listed result')
    expect(graphImpactProblem(answer(''), keys, true)).toBeNull()
    // A bad pointer that slipped through merges nothing.
    expect(
      graphMergeRootCauses([item(1), item(2)], [row(1, 2, 'find.r1.2'), row(2, 2, 'nope')]).merged
    ).toBe(0)
  })

  it("keeps a round's root-cause merges when the loop's aggregate replaces the item", () => {
    const [leader] = graphMergeRootCauses(
      [item(1), item(2)],
      [row(1, 3), row(2, 2, 'find.r1.1')]
    ).items
    const later = item(1, {
      alsoReported: [{ title: 'Later', detail: 'd', location: '', severity: 'low' }]
    })
    const target = { item: leader!, votes: [], texts: [], tally: 'confirmed' as const }
    const kept = graphLoopTarget(target, later).item
    expect(kept.alsoReported?.map((report) => report.title)).toEqual(['Later', 'Result 2'])
    expect(kept.alsoFrom).toEqual(['find/a2'])
  })

  it('rejects a sameAs that is not a listed key, so the model repairs it', () => {
    const answer = { items: [row(1, 2), row(2, 2, 'find.r1.01')] }
    expect(graphImpactProblem(answer, ['find.r1.1', 'find.r1.2'], true)).toContain(
      'must be the key of an earlier listed result'
    )
  })

  it('counts every copy of an absorbed repeat, and remembers which results it absorbed', () => {
    const [leader] = graphMergeRootCauses(
      [item(1), item(2, { repeats: 4 })],
      [row(1, 3), row(2, 2, 'find.r1.1')]
    ).items
    expect(leader).toMatchObject({ repeats: 5, alsoMerged: ['find.r1.2'] })
  })

  it("brings a later round's reports of an absorbed repeat into the aggregate", () => {
    const [leader] = graphMergeRootCauses(
      [item(1), item(2)],
      [row(1, 3), row(2, 2, 'find.r1.1')]
    ).items
    const later = {
      title: 'Worse than thought',
      detail: 'd',
      location: 'src/f2.ts:9',
      severity: 'critical' as GraphSeverity
    }
    const copies = new Map([
      ['find.r1.1', item(1)],
      ['find.r1.2', item(2, { repeats: 1, alsoReported: [later], alsoFrom: ['find/r2/a1'] })]
    ])
    const aggregate = graphWithMergedRepeats(item(1, { alsoMerged: leader!.alsoMerged }), (key) =>
      copies.get(key)
    )
    expect(aggregate.alsoReported?.map((report) => report.title)).toEqual([
      'Result 2',
      'Worse than thought'
    ])
    expect(aggregate).toMatchObject({ severity: 'critical', repeats: 2 })
    expect(aggregate.alsoFrom).toEqual(['find/a2', 'find/r2/a1'])
  })

  function spec(merge: boolean) {
    return normalizeWorkflowSpec({
      title: 'Repeats',
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
          forEach: {
            step: 'find',
            limit: 8,
            order: 'impact',
            ...(merge ? { merge: 'root-cause' } : {})
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
  const found = (title: string, location: string) => ({
    title,
    detail: `${title}.`,
    location,
    severity: 'high'
  })
  const answer = (call: GraphCall) =>
    call.id === 'find/a0'
      ? {
          items: [
            found('Cache key ignores locale', 'src/cache.ts:10'),
            found('Store write races flush', 'src/store.ts:40'),
            found('Locale missing from the cache key builder', 'src/cache-key.ts:3')
          ]
        }
      : call.id === 'verify/impact'
        ? { items: [row(1, 4), row(2, 5), row(3, 4, 'find.r1.1')] }
        : call.stepId === 'verify'
          ? text('Traced.\nVERDICT: PASS')
          : text('Report')

  it('asks the triage to mark repeats even when every result fits, and checks each defect once', () => {
    const plan = drive(spec(true), answer)
    const triage = plan.calls.find((call) => call.id === 'verify/impact')!
    expect(triage.prompt).toContain('set sameAs to that earlier result')
    expect(
      plan.calls.filter((call) => call.id.startsWith('verify/find')).map((call) => call.id)
    ).toEqual(['verify/find.r1.2/a0', 'verify/find.r1.1/a0'])
    expect(plan.runs.verify[0].notes.join('\n')).toContain(
      "merged 1 repeat of an earlier result's root cause into it"
    )
    expect(plan.calls.find((call) => call.id === 'report/a0')!.prompt).toContain(
      '- **Locale missing from the cache key builder** (src/cache-key.ts:3)'
    )
  })

  it('leaves a step without the option as it was: no triage within the limit, no repeat rules', () => {
    const plan = drive(spec(false), answer)
    expect(plan.calls.some((call) => call.id === 'verify/impact')).toBe(false)
    expect(plan.calls.filter((call) => call.id.startsWith('verify/find'))).toHaveLength(3)
  })

  it('keeps merging only with the impact order it rides on', () => {
    const plain = normalizeWorkflowSpec({
      title: 'x',
      steps: [
        { id: 'find', kind: 'do', title: 'Find', agents: [{}], list: { maxItems: 8 } },
        {
          id: 'verify',
          kind: 'review',
          title: 'Verify',
          agents: [{}],
          inputs: ['find'],
          forEach: { step: 'find', limit: 8, merge: 'root-cause' }
        }
      ]
    })
    expect(plain.steps[1]!.forEach?.merge).toBeUndefined()
  })
})
