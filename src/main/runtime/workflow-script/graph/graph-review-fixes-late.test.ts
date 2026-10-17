import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { projectGraphRun } from '../local-workflow-graph-projection'
import { planWorkflowGraph, type GraphCall, type GraphOutcome } from './graph-plan'
import { fitGraphPrompt } from './graph-prompts'
import { SEATS, configFor, drive, task, text } from './graph-test-harness'

/** Regressions for rounds 4 and 5 of the cross-model review of 2026-09-22 (codex-critic). */
describe('cross-model review regressions, round 4', () => {
  const report = (title: string, detail: string, location = 'src/cache.ts:10') => ({
    title,
    detail,
    location,
    severity: 'high'
  })

  it('NEW-001: only a byte-for-byte copy is folded; case or place alone keeps a report', () => {
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [
          { id: 'find', kind: 'do', title: 'Find', agents: [{}, {}], list: { maxItems: 4 } },
          {
            id: 'verify',
            kind: 'review',
            title: 'Verify',
            agents: [{ route: 'codex' }],
            inputs: ['find'],
            forEach: { step: 'find', limit: 10 }
          }
        ]
      }),
      (call) =>
        call.id === 'find/a0'
          ? { items: [report('Stale key', 'The cacheKey ignores the locale.')] }
          : call.id === 'find/a1'
            ? {
                items: [
                  report('Stale key', 'The cacheKey ignores the locale.'),
                  report('Stale key', 'The CacheKey ignores the locale.'),
                  report('Stale key', 'The cacheKey ignores the locale.', 'src/cache.ts:20')
                ]
              }
            : text('Checked.\nVERDICT: PASS')
    )
    const [item] = plan.runs.find[0].items!
    expect(item.repeats).toBe(3)
    expect(item.alsoReported?.map((entry) => [entry.detail, entry.location])).toEqual([
      ['The CacheKey ignores the locale.', 'src/cache.ts:10'],
      ['The cacheKey ignores the locale.', 'src/cache.ts:20']
    ])
  })

  it('NEW-005: a later wording of a known item is shown to the next round and in every view', () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        { id: 'find', kind: 'do', title: 'Find', agents: [{}], list: { maxItems: 4 } },
        {
          id: 'verify',
          kind: 'review',
          title: 'Verify',
          agents: [{ route: 'codex' }],
          inputs: ['find'],
          forEach: { step: 'find', limit: 10 }
        },
        { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['verify'] }
      ],
      repeat: { do: 'find', review: 'verify', until: 'nothing-new', maxRounds: 3 }
    })
    const config = configFor(spec)
    const outcomes = new Map<string, GraphOutcome>()
    const answer = (call: GraphCall) =>
      call.id === 'find/r1/a0'
        ? { items: [report('Cache key omits locale', 'Round one wording.')] }
        : call.id === 'find/r2/a0'
          ? {
              items: [
                report('Cache key omits the locale', 'Round two wording.'),
                report('Retry storm on timeout', 'Something new.', 'src/retry.ts:5')
              ]
            }
          : call.stepId === 'find'
            ? { items: [] }
            : text('Real.\nVERDICT: PASS')
    let plan = planWorkflowGraph(config, task, outcomes)
    for (let pass = 0; pass < 50 && plan.ready.length; pass++) {
      for (const call of plan.ready) {
        outcomes.set(call.id, { value: answer(call) })
      }
      plan = planWorkflowGraph(config, task, outcomes)
    }
    expect(plan.calls.find((call) => call.id === 'find/r3/a0')!.prompt).toContain(
      'also reported as: Cache key omits the locale'
    )
    const { graphRun } = projectGraphRun(
      {
        graphProgramRevision: 1,
        graph: { spec, agentSeats: config.agentSeats },
        seats: SEATS,
        task,
        access: 'frozen'
      } as never,
      outcomes,
      false
    )
    const round1 = graphRun.steps.find((step) => step.id === 'find')!.rounds[0].items![0]
    expect(round1.alsoReported?.map((entry) => entry.detail)).toEqual(['Round two wording.'])
    // The round's own record is untouched.
    expect(plan.runs.find[0].items![0].alsoReported).toBeUndefined()
  })

  it('NEW-007: the reasons of reviewers go through the budget, so a crowded report prompt is cut and says so', () => {
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [
          { id: 'find', kind: 'do', title: 'Find', agents: [{}], list: { maxItems: 20 } },
          {
            id: 'verify',
            kind: 'review',
            title: 'Verify',
            agents: Array.from({ length: 8 }, () => ({ route: 'codex' })),
            inputs: ['find'],
            forEach: { step: 'find', limit: 20 }
          },
          { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['verify'] }
        ]
      }),
      (call) =>
        call.stepId === 'find'
          ? {
              items: Array.from({ length: 20 }, (_, index) =>
                report(
                  `Distinct defect ${index} zeta${index}`,
                  'A concrete failure.',
                  `src/f${index}.ts:1`
                )
              )
            }
          : call.stepId === 'verify'
            ? text(`${'r'.repeat(3_000)}\nVERDICT: PASS`)
            : text('Report')
    )
    const prompt = plan.calls.find((call) => call.stepId === 'report')!.prompt
    // The budget bounds the inputs (160,000 characters); headings and vote lines come on top.
    expect(prompt.length).toBeLessThan(180_000)
    expect(prompt).toContain('[… cut:')
    expect(plan.outcome?.gaps.join(' ')).toContain('cut to fit a prompt')
  })
})

describe('cross-model review regressions, round 5', () => {
  const report = (title: string, severity = 'high', location = 'src/cache.ts:10') => ({
    title,
    detail: 'The key ignores the locale.',
    location,
    severity
  })
  const listReview = (limit?: number) =>
    normalizeWorkflowSpec({
      steps: [
        { id: 'find', kind: 'do', title: 'Find', agents: [{}, {}], list: { maxItems: 20 } },
        {
          id: 'verify',
          kind: 'review',
          title: 'Verify',
          agents: [{ route: 'codex' }],
          inputs: ['find'],
          ...(limit ? { forEach: { step: 'find', limit } } : {})
        }
      ]
    })

  it('NEW-001: a report differing only by a higher severity is kept, and the first severity shown', () => {
    const plan = drive(listReview(10), (call) =>
      call.id === 'find/a0'
        ? { items: [report('Stale key', 'low')] }
        : call.id === 'find/a1'
          ? { items: [report('Stale key', 'critical')] }
          : text('Real.\nVERDICT: PASS')
    )
    const [item] = plan.runs.find[0].items!
    expect(item).toMatchObject({ severity: 'critical', reportedSeverity: 'low', repeats: 1 })
    expect(item.alsoReported?.map((entry) => entry.severity)).toEqual(['critical'])
    expect(plan.calls.find((call) => call.stepId === 'verify')!.prompt).toContain(
      '[critical; first reported as low]'
    )
  })

  it('NEW-008: a report matching only a later wording of an item is that item, not a new one', () => {
    // Word overlap: second vs first 4/6, third vs second 4/7, third vs first only 2/7.
    const plan = drive(listReview(10), (call) =>
      call.id === 'find/a0'
        ? {
            items: [
              report('alpha bravo charlie delta'),
              report('alpha bravo charlie delta echo foxtrot')
            ]
          }
        : call.id === 'find/a1'
          ? { items: [report('charlie delta echo foxtrot golf')] }
          : text('Real.\nVERDICT: PASS')
    )
    const items = plan.runs.find[0].items!
    expect(items.map((entry) => entry.title)).toEqual(['alpha bravo charlie delta'])
    expect(items[0].alsoReported?.map((entry) => entry.title)).toEqual([
      'alpha bravo charlie delta echo foxtrot',
      'charlie delta echo foxtrot golf'
    ])
  })

  it('NEW-009: a final review of a whole list shows the list it reviewed', () => {
    const plan = drive(listReview(), (call) =>
      call.stepId === 'find'
        ? {
            items: [
              report(
                `Defect ${call.agentIndex} zeta${call.agentIndex}`,
                'high',
                `src/f${call.agentIndex}.ts:1`
              )
            ]
          }
        : text('Real.\nVERDICT: PASS')
    )
    const markdown = plan.outcome?.final?.markdown ?? ''
    expect(markdown).toContain('## Find (2 items)')
    expect(markdown).toContain('Defect 0 zeta0')
    expect(markdown).toContain('Defect 1 zeta1')
  })

  it('NEW-010: every cut input is counted, even when several share a title', () => {
    const long = 'z'.repeat(9_000)
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [
          { id: 'find', kind: 'do', title: 'Find', agents: [{}], list: { maxItems: 20 } },
          {
            id: 'verify',
            kind: 'review',
            title: 'Verify',
            agents: [{ route: 'codex' }],
            inputs: ['find'],
            forEach: { step: 'find', limit: 20 }
          },
          { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['verify'] }
        ]
      }),
      (call) =>
        call.stepId === 'find'
          ? {
              items: Array.from({ length: 20 }, (_, index) => ({
                ...report('Same title everywhere', 'high', `src/other${index}.ts:${index * 100}`),
                detail: `${index} ${long}`
              }))
            }
          : call.stepId === 'verify'
            ? text('Real.\nVERDICT: PASS')
            : text('Final')
    )
    expect(plan.runs.verify[0].targets).toHaveLength(20)
    expect(plan.runs.final[0].cuts).toHaveLength(20)
    expect(plan.outcome?.gaps.join(' ')).toContain('20 inputs cut to fit a prompt')
  })

  it('NEW-011: a one-to-one split is not approved and is not called a majority', () => {
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [
          { id: 'write', kind: 'do', title: 'Write', agents: [{}] },
          {
            id: 'check',
            kind: 'review',
            title: 'Check',
            agents: [{ route: 'codex' }, { route: 'claude' }],
            inputs: ['write']
          }
        ]
      }),
      (call) =>
        call.stepId === 'write'
          ? text('Work')
          : text(call.agentIndex === 0 ? 'Yes.\nVERDICT: PASS' : 'No.\nVERDICT: FAIL')
    )
    const markdown = plan.outcome?.final?.markdown ?? ''
    expect(markdown).toContain(
      'Not approved: 1 reviewer of 2 passed it, and approval needs every reviewer.'
    )
    expect(markdown).not.toContain('majority')
  })
})

describe('second-lineage review (Grok 4.6, three narrow briefs)', () => {
  it('names every failed round of a loop review, not only the last', () => {
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [
          { id: 'find', kind: 'do', title: 'Find', agents: [{}], list: { maxItems: 4 } },
          {
            id: 'verify',
            kind: 'review',
            title: 'Verify',
            agents: [{ route: 'codex' }],
            inputs: ['find'],
            forEach: { step: 'find', limit: 10 }
          },
          { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['verify'] }
        ],
        repeat: { do: 'find', review: 'verify', until: 'nothing-new', maxRounds: 2 }
      }),
      (call) =>
        call.stepId === 'find'
          ? {
              items: [
                {
                  title: `Defect of round ${call.round} zeta${call.round}`,
                  detail: 'A concrete failure scenario.',
                  location: `src/r${call.round}.ts:1`,
                  severity: 'high'
                }
              ]
            }
          : call.stepId === 'verify'
            ? undefined
            : text('Report')
    )
    const gaps = plan.outcome?.gaps.join('\n') ?? ''
    expect(gaps).toContain('Verify (round 1):')
    expect(gaps).toContain('Verify (round 2):')
    expect(gaps).toContain('Verify failed in all 2 rounds that had something to review.')
    // Both rounds' findings still reach the report, unverified.
    const report = plan.calls.find((call) => call.stepId === 'report')!.prompt
    expect(report).toContain('Defect of round 1 zeta1')
    expect(report).toContain('Defect of round 2 zeta2')
  })

  it('refuses a prompt whose inputs differ between the measuring and the fitting pass', () => {
    const render = (budget: Parameters<Parameters<typeof fitGraphPrompt>[1]>[0]) => {
      const first = budget.take('First', 'a'.repeat(200_000))
      return first.includes('[… cut:') ? first : `${first}${budget.take('Second', 'b')}`
    }
    expect(() => fitGraphPrompt('Step', render)).toThrow('took 1 inputs when fitted but 2')
  })

  it('ends an until-approved loop whose draft had nothing to work on, without a crash', () => {
    const plan = drive(
      normalizeWorkflowSpec({
        steps: [
          { id: 'source', kind: 'do', title: 'Source', agents: [{}], list: { maxItems: 4 } },
          {
            id: 'write',
            kind: 'do',
            title: 'Write',
            agents: [{}],
            inputs: ['source'],
            forEach: { step: 'source', limit: 4 }
          },
          {
            id: 'check',
            kind: 'review',
            title: 'Check',
            agents: [{ route: 'codex' }],
            inputs: ['write']
          }
        ],
        repeat: { do: 'write', review: 'check', until: 'approved', maxRounds: 2 }
      }),
      (call) => (call.stepId === 'source' ? { items: [] } : text('Good.\nVERDICT: PASS'))
    )
    expect(plan.calls.some((call) => call.stepId === 'check')).toBe(false)
    expect(plan.loop?.status).toBe('failed')
    expect(plan.outcome?.state).toBe('failed')
  })
})
