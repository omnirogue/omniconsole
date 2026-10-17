import { planWorkflowGraph } from './graph-plan'
import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { runWorkflowGraphProgram } from './graph-program'
import { configFor, fakeContext, text, task } from './graph-program-test-harness'

describe('workflow graph program loops', () => {
  it('revises until the reviewers approve', async () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft', agents: [{ route: 'claude' }] },
        {
          id: 'critic',
          kind: 'review',
          title: 'Critic',
          inputs: ['draft'],
          agents: [{ route: 'codex' }, { route: 'grok' }]
        }
      ],
      repeat: { do: 'draft', review: 'critic', until: 'approved', maxRounds: 3 }
    })
    const { context, calls } = fakeContext((call) => {
      if (call.id.startsWith('draft')) {
        return text(call.id === 'draft/r1/a0' ? 'draft one' : 'draft two')
      }
      return text(
        call.id.startsWith('critic/r1') ? 'Too vague.\nVERDICT: FAIL' : 'Good.\n**VERDICT: PASS**'
      )
    })
    const result = await runWorkflowGraphProgram(context, configFor(spec), task)
    expect(calls.map((call) => call.id)).toEqual([
      'draft/r1/a0',
      'critic/r1/a0',
      'critic/r1/a1',
      'draft/r2/a0',
      'critic/r2/a0',
      'critic/r2/a1'
    ])
    const revise = calls.find((call) => call.id === 'draft/r2/a0')!.prompt
    expect(revise).toContain('Your previous version:\ndraft one')
    expect(revise).toContain('### Reviewer 1 — VERDICT: FAIL\nToo vague.')
    expect(result.final.markdown).toContain('draft two')
    expect(result.final.markdown).toContain('**Approved in round 2.**')
    expect(result.gaps).toEqual([])
  })

  it('finishes with a gap when the reviewers never approve', async () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft', agents: [{ route: 'claude' }] },
        {
          id: 'critic',
          kind: 'review',
          title: 'Critic',
          inputs: ['draft'],
          agents: [{ route: 'codex' }]
        }
      ],
      repeat: { do: 'draft', review: 'critic', until: 'approved', maxRounds: 2 }
    })
    const { context } = fakeContext((call) =>
      call.id.startsWith('draft') ? text('draft') : text('no\nVERDICT: FAIL')
    )
    const result = await runWorkflowGraphProgram(context, configFor(spec), task)
    expect(result.gaps).toEqual(['Not approved after 2 rounds.'])
    expect(result.final.markdown).toContain('**Not approved after 2 rounds.**')
  })

  it('runs Discover: scout, find for each area, merge repeats, verify each finding, loop until dry', async () => {
    const discover = workflowTemplate('discover')
    const finding = (title: string, location: string) => ({
      title,
      detail: `A concrete failure scenario for ${title}.`,
      location,
      severity: 'high'
    })
    const { context, calls, logs, outcomes } = fakeContext((call) => {
      if (call.id === 'scout/a0') {
        return {
          items: [
            {
              title: 'Cache',
              detail: 'The cache layer matters here.',
              location: 'src/cache',
              severity: 'none'
            },
            {
              title: 'Store',
              detail: 'The store layer matters here.',
              location: 'src/store',
              severity: 'none'
            }
          ]
        }
      }
      if (call.id.startsWith('find/r1/scout.r1.1')) {
        // Every lens reports the same defect with slightly different words.
        return { items: [finding('Cache key ignores locale', 'src/cache/key.ts:10')] }
      }
      if (call.id.startsWith('find/r1/scout.r1.2')) {
        return call.id.endsWith('a0')
          ? { items: [finding('Store write races flush', 'src/store/write.ts:40')] }
          : { items: [] }
      }
      if (call.id.startsWith('find/r2')) {
        // Round 2 only repeats what round 1 found: the loop is dry.
        return { items: [finding('Cache key ignores locale', 'src/cache/key.ts:10')] }
      }
      if (call.id === 'verify/r1/impact') {
        // Two different defects: rated, and neither a repeat of the other.
        return {
          items: [
            { key: 'find.r1.1', impact: 4, why: 'wrong locale served', sameAs: '' },
            { key: 'find.r1.2', impact: 5, why: 'lost writes', sameAs: '' }
          ]
        }
      }
      if (call.id.startsWith('verify')) {
        return call.id.includes('find.r1.1')
          ? text('Real.\nVERDICT: PASS')
          : call.id.endsWith('a0')
            ? text('Refuted by the lock.\nVERDICT: FAIL')
            : text('Cannot tell.\nVERDICT: UNSURE')
      }
      return text('Report')
    })
    const result = await runWorkflowGraphProgram(context, configFor(discover), task)
    expect(result.final.markdown).toBe('Report')
    const ids = calls.map((call) => call.id)
    expect(ids.filter((id) => id.startsWith('find/r1'))).toHaveLength(6)
    // Two distinct findings after merging repeats, the lost write rated first: one review each, then
    // the other two reviewers only on the refuted one. Every finder runs on Haiku, so the first
    // reviewer (another family) is independent of all of them and needs no second opinion.
    expect(ids.filter((id) => id.startsWith('verify/r1'))).toEqual([
      'verify/r1/impact',
      'verify/r1/find.r1.2/a0',
      'verify/r1/find.r1.1/a0',
      'verify/r1/find.r1.2/a1',
      'verify/r1/find.r1.2/a2'
    ])
    expect(logs).toContain(
      'Verify round 1: 1 item went to 3 reviewers (the first review did not pass, or the item is critical).'
    )
    expect(ids.filter((id) => id.startsWith('find/r2'))).toHaveLength(6)
    expect(ids.some((id) => id.startsWith('verify/r2'))).toBe(false)
    expect(logs).toContain(
      'Find round 1: 4 items reported, 2 new items, 2 repeated within the round.'
    )
    expect(logs).toContain('Find round 2: 6 items reported, 0 new items, 6 already known.')
    const report = calls.find((call) => call.id === 'report/a0')!.prompt
    expect(report).toContain('### Confirmed (1)')
    expect(report).toContain('### Unverified after review (1)')
    const round2 = calls.find((call) => call.id === 'find/r2/scout.r1.1/a0')!.prompt
    expect(round2).toContain('Already reported in earlier rounds')
    expect(round2).toContain('Cache key ignores locale (src/cache/key.ts:10)')
    // Discover has no JEV screen by default: no screen call, so nothing about one in the log.
    expect(logs.some((line) => line.includes('JEV could not screen'))).toBe(false)
    // Live JEV verify is on by default; this harness has no JEV, so it answered nothing and the
    // run is the one it was without JEV: the same tallies, report and loop.
    outcomes.set('verify/r1/jev-verify', { failed: true })
    const plan = planWorkflowGraph(configFor(discover), task, outcomes)
    expect(plan.runs.find.map((run) => run.state)).toEqual(['done', 'done'])
    expect(plan.runs.verify.map((run) => run.state)).toEqual(['done', 'empty'])
    expect(plan.loop).toEqual({ round: 2, maxRounds: 2, status: 'dry' })
    // The lost write, rated higher, was checked first.
    expect(plan.runs.verify[0].targets?.map((target) => target.tally)).toEqual([
      'unverified',
      'confirmed'
    ])
  })
})
