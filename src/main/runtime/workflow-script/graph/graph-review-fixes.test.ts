import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { graphOutcomesFromRecords } from '../local-workflow-graph-projection'
import type { GraphCall } from './graph-plan'
import { graphItemsProblem } from './graph-items'
import { parseGraphBallot, parseGraphVerdict } from './graph-parse'
import { graphCallSuperseded } from './graph-supersede'
import { drive, text } from './graph-test-harness'

/**
 * Regressions for the cross-model review of 2026-09-22 (codex-critic, GPT-5.6 Sol): WG-001 to
 * WG-009. Each case is the reviewer's scenario.
 */
let unique = 0
/** The most distinct output every call could return: full lists, passes, full ballots. */
function maximal(call: GraphCall): unknown {
  if ('items' in (call.schema.properties ?? {})) {
    const max = (call.schema.properties!.items as { maxItems: number }).maxItems
    return {
      items: Array.from({ length: max }, () => {
        unique++
        return {
          title: `Distinct defect number ${unique} zeta${unique}`,
          detail: 'A concrete, specific failure scenario.',
          location: `src/file${unique}.ts:${unique * 100}`,
          severity: 'high'
        }
      })
    }
  }
  if (call.stepId === 'rank' || call.prompt.includes('FINAL RANKING')) {
    const labels = [...new Set(call.prompt.match(/Response [A-Z]/g) ?? [])]
    return text(
      `FINAL RANKING:\n${labels.map((label, index) => `${index + 1}. ${label}`).join('\n')}`
    )
  }
  return text('Fine.\nVERDICT: PASS')
}

describe('cross-model review regressions', () => {
  it('WG-001: a final step with nothing to do fails the run instead of completing empty', () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        {
          id: 'answer',
          kind: 'do',
          title: 'Answer',
          agents: [{ route: 'claude' }, { route: 'codex' }]
        },
        {
          id: 'rank',
          kind: 'rank',
          title: 'Rank',
          agents: [{ route: 'claude' }],
          inputs: ['answer']
        }
      ]
    })
    const plan = drive(spec, (call) => (call.id === 'answer/a1' ? undefined : text('An answer')))
    expect(plan.outcome).toMatchObject({
      state: 'failed',
      error: 'Rank produced no result: Nothing to rank: only 1 answer came back.'
    })
  })

  it('WG-004: a failed revision fails the loop; the rejected draft never reaches the final step', () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft', agents: [{ route: 'claude' }] },
        {
          id: 'critic',
          kind: 'review',
          title: 'Critic',
          agents: [{ route: 'codex' }],
          inputs: ['draft']
        },
        {
          id: 'final',
          kind: 'synthesize',
          title: 'Final',
          agents: [{ route: 'claude' }],
          inputs: ['draft', 'critic']
        }
      ],
      repeat: { do: 'draft', review: 'critic', until: 'approved', maxRounds: 3 }
    })
    const plan = drive(spec, (call) =>
      call.id === 'draft/r2/a0'
        ? undefined
        : call.id.startsWith('critic')
          ? text('Bad.\nVERDICT: FAIL')
          : text('draft one')
    )
    expect(plan.calls.some((call) => call.id.startsWith('final'))).toBe(false)
    expect(plan.runs.final[0]).toMatchObject({ state: 'not-run' })
    expect(plan.outcome?.state).toBe('failed')
  })

  it('WG-009: a failed review round keeps its items, unverified, for the report', () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        {
          id: 'find',
          kind: 'do',
          title: 'Find',
          agents: [{ route: 'claude' }],
          list: { maxItems: 2 }
        },
        {
          id: 'verify',
          kind: 'review',
          title: 'Verify',
          agents: [{ route: 'codex' }],
          inputs: ['find'],
          forEach: { step: 'find', limit: 5 }
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
    const plan = drive(spec, (call) => {
      if (call.id === 'find/r1/a0') {
        return {
          items: [
            {
              title: 'Round one defect',
              detail: 'A concrete scenario one.',
              location: 'src/a.ts:1',
              severity: 'high'
            }
          ]
        }
      }
      if (call.id === 'find/r2/a0') {
        return {
          items: [
            {
              title: 'Round two defect',
              detail: 'A concrete scenario two.',
              location: 'src/b.ts:9',
              severity: 'high'
            }
          ]
        }
      }
      return call.id.startsWith('verify/r2') ? undefined : text('Real.\nVERDICT: PASS')
    })
    const report = plan.calls.find((call) => call.id === 'report/a0')!.prompt
    expect(report).toContain('Round one defect')
    expect(report).toContain('### Unverified (1)')
    expect(report).toContain('Round two defect')
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.outcome?.gaps.join(' ')).toContain('Verify (round 2)')
  })

  it('WG-002: the planner never plans more calls than admission allowed', () => {
    const accumulated = normalizeWorkflowSpec({
      steps: [
        {
          id: 'find',
          kind: 'do',
          title: 'Find',
          agents: [{ route: 'claude' }],
          list: { maxItems: 2 }
        },
        {
          id: 'verify',
          kind: 'review',
          title: 'Verify',
          agents: [{ route: 'codex' }],
          inputs: ['find'],
          forEach: { step: 'find', limit: 10 }
        },
        {
          id: 'consume',
          kind: 'do',
          title: 'Consume',
          agents: [{ route: 'grok' }],
          inputs: ['find'],
          forEach: { step: 'find', limit: 10 }
        },
        {
          id: 'final',
          kind: 'synthesize',
          title: 'Final',
          agents: [{ route: 'claude' }],
          inputs: ['consume', 'verify']
        }
      ],
      repeat: { do: 'find', review: 'verify', until: 'nothing-new', maxRounds: 3 }
    })
    for (const spec of [
      accumulated,
      workflowTemplate('discover'),
      workflowTemplate('discover', undefined, { depth: 'quick' }),
      workflowTemplate('council'),
      workflowTemplate('research-panel')
    ]) {
      const plan = drive(spec, maximal)
      expect(plan.settled).toBe(true)
      expect(plan.calls.length).toBeLessThanOrEqual(planWorkflowCalls(spec).total)
    }
  })

  it('WG-003: approval needs every configured reviewer; a FAIL or a missing vote withholds it', () => {
    const loop = (verdicts: (string | undefined)[]) =>
      drive(
        normalizeWorkflowSpec({
          steps: [
            { id: 'draft', kind: 'do', title: 'Draft', agents: [{ route: 'claude' }] },
            {
              id: 'critic',
              kind: 'review',
              title: 'Critic',
              agents: verdicts.map(() => ({ route: 'codex' })),
              inputs: ['draft']
            }
          ],
          repeat: { do: 'draft', review: 'critic', until: 'approved', maxRounds: 2 }
        }),
        (call) => {
          if (call.stepId === 'draft') {
            return text('draft')
          }
          const verdict = verdicts[call.agentIndex]
          return verdict === undefined ? undefined : text(`Notes.\nVERDICT: ${verdict}`)
        }
      ).loop
    expect(loop(['PASS', undefined])?.status).toBe('not-approved')
    // Unanimous: one FAIL or one missing vote withholds approval, however many passed.
    expect(loop(['PASS', 'PASS', 'FAIL'])?.status).toBe('not-approved')
    expect(loop(['PASS', 'PASS', undefined])?.status).toBe('not-approved')
    expect(loop(['PASS', 'PASS', 'PASS'])).toMatchObject({ status: 'approved', round: 1 })
  })

  it('WG-008: until nothing new, a later round never freezes an earlier review vote', () => {
    const discover = workflowTemplate('discover')
    expect(graphCallSuperseded(discover, 'verify/r1/find.r1.1/a1', ['find/r2/scout.r1.1/a0'])).toBe(
      false
    )
    expect(graphCallSuperseded(discover, 'verify/r1/find.r1.1/a1', ['report/a0'])).toBe(true)
    // A round's finders are still final once that round's review or a later round started.
    expect(graphCallSuperseded(discover, 'find/r1/scout.r1.1/a0', ['verify/r1/find.r1.1/a0'])).toBe(
      true
    )
    expect(graphCallSuperseded(discover, 'find/r1/scout.r1.1/a0', ['find/r2/scout.r1.1/a0'])).toBe(
      true
    )
  })

  it('WG-006: a ballot needs its FINAL RANKING list; discussion order is not a vote', () => {
    const labels = ['Response A', 'Response B']
    expect(parseGraphBallot('Response A is good. Response B is weaker.', labels)).toBeUndefined()
    expect(
      parseGraphBallot('Notes.\n\nFINAL RANKING:\n1. Response B\n2. Response A', labels)
    ).toEqual(['Response B', 'Response A'])
    expect(parseGraphBallot('## Final ranking\n1. **Response A**\n2) Response B', labels)).toEqual(
      labels
    )
    expect(parseGraphBallot('FINAL RANKING:\n1. Response A', labels)).toBeUndefined()
    expect(parseGraphBallot('FINAL RANKING:\n1. Response A\n2. Response A', labels)).toBeUndefined()
  })

  it('WG-007: a paused call that can still be retried shows as waiting, not failed', () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        { id: 'work', kind: 'do', title: 'Work', agents: [{}, {}] },
        { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['work'] }
      ]
    })
    const records = [{ call_id: 'work/a0', result_json: null, result_digest: null, quarantined: 0 }]
    const attempts = [
      { id: '1', call_id: 'work/a0', ordinal: 1, state: 'failed', receipt_json: null }
    ]
    const outcomes = (state: string, attemptLimit: number) =>
      graphOutcomesFromRecords({
        records,
        attempts,
        results: new Map(),
        active: false,
        state,
        attemptLimit,
        spec
      })
    expect(outcomes('paused', 3).has('work/a0')).toBe(false)
    expect(outcomes('paused', 1).get('work/a0')).toEqual({ failed: true })
    expect(outcomes('failed', 3).get('work/a0')).toEqual({ failed: true })
  })

  it('WG-005: a review cannot read another review, even beside real work', () => {
    const found = validateWorkflowSpec(
      normalizeWorkflowSpec({
        steps: [
          { id: 'work', kind: 'do', title: 'Work', agents: [{}, {}] },
          { id: 'r1', kind: 'review', title: 'R1', inputs: ['work'] },
          { id: 'r2', kind: 'review', title: 'R2', inputs: ['work', 'r1'] },
          { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['work', 'r2'] }
        ]
      })
    ).problems.map((problem) => problem.message)
    expect(found.join(' ')).toContain('R2 must review work from a Do or Synthesize step')
  })
})

describe('defects Discover found in these parsers (live run, 2026-09-22)', () => {
  it('reads only the last verdict line, as a whole known phrase', () => {
    expect(parseGraphVerdict('Earlier: verdict: approved.\nVERDICT: NOT APPROVED')).toBe('fail')
    expect(parseGraphVerdict('VERDICT: PASS\nMore notes.\nVERDICT: MAYBE')).toBeUndefined()
    expect(
      parseGraphVerdict('VERDICT: FAIL\n(Once the null check is added the verdict - pass.)')
    ).toBe('fail')
    expect(parseGraphVerdict('verdict: pass would be unsafe')).toBeUndefined()
    expect(parseGraphVerdict('VERDICT: FAILED')).toBe('fail')
    expect(parseGraphVerdict('**Verdict:** PASSED')).toBe('pass')
    expect(parseGraphVerdict('VERDICT: PASS — the fix is correct.')).toBe('pass')
    expect(parseGraphVerdict('> VERDICT: REQUEST CHANGES')).toBe('fail')
    expect(parseGraphVerdict('VERDICT: INCONCLUSIVE')).toBe('unsure')
  })

  it('orders a ballot by the numbers written and refuses repeated places', () => {
    const labels = ['Response A', 'Response B']
    expect(parseGraphBallot('FINAL RANKING:\n2. Response A\n1. Response B', labels)).toEqual([
      'Response B',
      'Response A'
    ])
    expect(parseGraphBallot('FINAL RANKING:\n1. Response A\n1. Response B', labels)).toBeUndefined()
  })

  it('never downgrades a merged item and never merges a title with its opposite', () => {
    const spec = normalizeWorkflowSpec({
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
    })
    const item = (title: string, severity: string) => ({
      title,
      detail: 'A concrete failure scenario here.',
      location: 'src/cache.ts:10',
      severity
    })
    const plan = drive(spec, (call) =>
      call.id === 'find/a0'
        ? { items: [item('Cache key ignores the locale', 'low')] }
        : call.id === 'find/a1'
          ? {
              items: [
                item('Cache key ignores the locale', 'critical'),
                item('Cache key does not ignore the locale', 'low')
              ]
            }
          : text('Real.\nVERDICT: PASS')
    )
    const items = plan.runs.find[0].items!
    expect(items.map((entry) => [entry.title, entry.severity, entry.repeats])).toEqual([
      ['Cache key ignores the locale', 'critical', 1],
      ['Cache key does not ignore the locale', 'low', 0]
    ])
  })

  it('refuses blank and "no findings" placeholder items so the finder is asked again', () => {
    const detail = 'A concrete failure scenario here.'
    for (const title of ['', 'No issues found', 'None.', 'N/A']) {
      expect(
        graphItemsProblem({ items: [{ title, detail, location: '', severity: 'none' }] })
      ).toContain('placeholder')
    }
    expect(graphItemsProblem({ items: [] })).toBeNull()
  })
})

describe('cross-model review regressions, round 2', () => {
  const finding = (title: string, severity: string) => ({
    title,
    detail: 'A concrete failure scenario here.',
    location: 'src/cache.ts:10',
    severity
  })

  it('NEW-001: a merge never loses a claim; the other wording reaches the verifier and the report', () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        { id: 'find', kind: 'do', title: 'Find', agents: [{}, {}], list: { maxItems: 4 } },
        {
          id: 'verify',
          kind: 'review',
          title: 'Verify',
          agents: [{ route: 'codex' }],
          inputs: ['find'],
          forEach: { step: 'find', limit: 10 }
        },
        { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['verify'] }
      ]
    })
    const opposite = 'Cache key includes locale but should not'
    const plan = drive(spec, (call) =>
      call.id === 'find/a0'
        ? { items: [finding('Cache key does not include locale', 'high')] }
        : call.id === 'find/a1'
          ? { items: [finding(opposite, 'high')] }
          : text('Checked.\nVERDICT: PASS')
    )
    const [item] = plan.runs.find[0].items!
    expect(item.alsoReported?.map((report) => report.title)).toEqual([opposite])
    const verify = plan.calls.filter((call) => call.stepId === 'verify')
    expect(verify).toHaveLength(1)
    expect(verify[0].prompt).toContain(opposite)
    expect(plan.calls.find((call) => call.stepId === 'report')!.prompt).toContain(opposite)
    expect(plan.outcome?.state).toBe('completed')
  })

  it('NEW-002: a later round rating a known item worse raises it for the report only', () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        { id: 'find', kind: 'do', title: 'Find', agents: [{}], list: { maxItems: 1 } },
        {
          id: 'verify',
          kind: 'review',
          title: 'Verify',
          agents: [{ route: 'codex' }],
          inputs: ['find'],
          forEach: { step: 'find', limit: 3 }
        },
        { id: 'report', kind: 'synthesize', title: 'Report', inputs: ['verify'] }
      ],
      repeat: { do: 'find', review: 'verify', until: 'nothing-new', maxRounds: 2 }
    })
    const plan = drive(spec, (call) =>
      call.id === 'find/r1/a0'
        ? { items: [finding('Cache key ignores locale', 'low')] }
        : call.id === 'find/r2/a0'
          ? { items: [finding('Cache key ignores locale', 'critical')] }
          : text('Real.\nVERDICT: PASS')
    )
    const report = plan.calls.find((call) => call.stepId === 'report')!
    expect(report.prompt).toContain('[critical]')
    expect(report.prompt).not.toContain('[low]')
    // Round 1's own record, and the verify prompt built from it, are left as they were.
    expect(plan.runs.find[0].items![0].severity).toBe('low')
    expect(plan.calls.find((call) => call.stepId === 'verify')!.prompt).toContain('[low]')
    expect(plan.outcome?.state).toBe('completed')
  })

  it('NEW-003: once recovery has failed, an unaccepted call is final, not waiting', () => {
    const spec = normalizeWorkflowSpec({
      steps: [{ id: 'work', kind: 'do', title: 'Work', agents: [{}] }]
    })
    const outcomes = graphOutcomesFromRecords({
      records: [{ call_id: 'work/a0', result_json: null, result_digest: null, quarantined: 0 }],
      attempts: [{ id: '1', call_id: 'work/a0', ordinal: 1, state: 'failed', receipt_json: null }],
      results: new Map(),
      active: false,
      state: 'recovery_failed',
      attemptLimit: 3,
      spec
    })
    expect(outcomes.get('work/a0')).toEqual({ failed: true })
  })

  it('NEW-004: a real defect may quote "No findings found"; a bare placeholder may not', () => {
    const quoted = {
      title: 'No findings found',
      detail: 'The UI shows this after every scanner timed out, hiding the incomplete result.',
      location: 'src/results/status.ts:41',
      severity: 'high'
    }
    expect(graphItemsProblem({ items: [quoted] })).toBeNull()
    expect(graphItemsProblem({ items: [{ ...quoted, location: '' }] })).toContain('placeholder')
    expect(graphItemsProblem({ items: [{ ...quoted, severity: 'none' }] })).toContain('placeholder')
  })
})

describe('cross-model review regressions, round 3', () => {
  const report = (title: string, detail: string) => ({
    title,
    detail,
    location: 'src/cache.ts:10',
    severity: 'high'
  })
  const verifySpec = (repeat?: boolean) =>
    normalizeWorkflowSpec({
      steps: [
        { id: 'find', kind: 'do', title: 'Find', agents: [{}, {}], list: { maxItems: 8 } },
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
      ...(repeat
        ? { repeat: { do: 'find', review: 'verify', until: 'nothing-new', maxRounds: 2 } }
        : {})
    })

  it('NEW-001: every merged report but an exact copy reaches the verifier, however many', () => {
    const claims = Array.from(
      { length: 6 },
      (_, index) => `Claim ${index}: the locale is dropped on path ${index}.`
    )
    const plan = drive(verifySpec(), (call) =>
      call.id === 'find/a0'
        ? { items: [report('Cache key ignores the locale', 'The original claim, in full.')] }
        : call.id === 'find/a1'
          ? {
              items: [
                report('Cache key ignores the locale', 'The original claim, in full.'),
                ...claims.map((claim) => report('Cache key ignores the locale', claim))
              ]
            }
          : text('Checked.\nVERDICT: PASS')
    )
    const [item] = plan.runs.find[0].items!
    expect(item.repeats).toBe(7)
    expect(item.alsoReported?.map((entry) => entry.detail)).toEqual(claims)
    const verify = plan.calls.find((call) => call.stepId === 'verify')!
    for (const claim of claims) {
      expect(verify.prompt).toContain(claim)
    }
    expect(verify.prompt).not.toContain('… and')
  })

  it('NEW-006: the item a call works on is inside the prompt budget, and a cut is stated', () => {
    const long = 'x'.repeat(8_000)
    const many = Array.from({ length: 12 }, (_, index) =>
      report('Cache key ignores the locale', `${index} ${long}`)
    )
    const plan = drive(verifySpec(), (call) =>
      call.id === 'find/a0'
        ? { items: [report('Cache key ignores the locale', long)] }
        : call.id === 'find/a1'
          ? { items: many.slice(0, 8) }
          : text('Checked.\nVERDICT: PASS')
    )
    const verify = plan.calls.find((call) => call.stepId === 'verify')!
    expect(verify.prompt).toContain('[… cut:')
    expect(verify.prompt.length).toBeLessThan(70_000)
    expect(plan.runs.verify[0].notes.join(' ')).toContain('Item find.r1.1 from Find')
    expect(plan.outcome?.gaps.join(' ')).toContain('cut to fit a prompt')
  })

  it('NEW-005: finders see every merged wording as already reported', () => {
    const plan = drive(verifySpec(true), (call) =>
      call.id === 'find/r1/a0'
        ? { items: [report('Cache key does not include locale', 'Missing locale in the key.')] }
        : call.id === 'find/r1/a1'
          ? {
              items: [
                report('Cache key includes locale but should not', 'The locale must not be keyed.')
              ]
            }
          : call.stepId === 'find'
            ? { items: [] }
            : text('Checked.\nVERDICT: PASS')
    )
    const round2 = plan.calls.find((call) => call.id.startsWith('find/r2/'))!
    expect(round2.prompt).toContain('- Cache key does not include locale (src/cache.ts:10)')
    expect(round2.prompt).toContain(
      '  - also reported as: Cache key includes locale but should not (src/cache.ts:10)'
    )
  })
})
