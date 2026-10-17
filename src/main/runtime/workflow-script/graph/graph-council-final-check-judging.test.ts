import {
  workflowFinishReserve,
  planWorkflowCalls
} from '../../../../shared/workflow-graph-topology'
import { graphCallSuperseded } from './graph-supersede'
import { describe, expect, it } from 'vitest'
import type { WorkflowRoute } from '../../../../shared/workflow-graph'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { createWorkflowProgramContext } from '../workflow-program-context'
import { runWorkflowGraphProgram } from './graph-program'
import type { GraphCall } from './graph-plan-types'
import { configFor, drive, task, text } from './graph-test-harness'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']

describe('Council final check judging', () => {
  const ballot = (first = 'A') =>
    text(`FINAL RANKING:\n1. Response ${first}\n2. Response ${first === 'A' ? 'B' : 'A'}`)
  const council = () => workflowTemplate('council', ROUTES)
  const initial = (call: GraphCall) =>
    call.stepId === 'answer'
      ? text(`Opinion ${call.agentIndex}`)
      : call.stepId === 'chair'
        ? text('Chair answer')
        : text('FINAL RANKING:\n1. Response A\n2. Response B\n3. Response C')

  it.each([
    ['chair wins', 'B', false, 'B', 'chair', 'Chair answer', 'and kept', ['jev']],
    ['first opinion wins', 'A', false, 'A', 'first-opinion', 'Opinion 0', 'judged better', ['jev']],
    [
      'models settle unsure JEV',
      'B',
      true,
      'A',
      'first-opinion',
      'Opinion 0',
      'judged better',
      ['jev', 'models']
    ],
    ['unsure without models', 'A', true, '', 'inconclusive', 'Chair answer', 'not decisive', []],
    ['no votes', '', false, '', 'failed', 'Chair answer', 'could not run', []],
    ['tie', '', false, 'tie', 'inconclusive', 'Chair answer', 'not decisive', []],
    [
      'JEV failed outright, models decide alone',
      '',
      false,
      'B',
      'chair',
      'Chair answer',
      'and kept',
      ['models']
    ]
  ])('%s', (_name, jev, unsure, models, result, shipped, note, judgedBy) => {
    const plan = drive(council(), (call) => {
      if (call.round !== 2) {
        return initial(call)
      }
      if (call.jev) {
        return jev ? { ...ballot(String(jev)), unsure } : undefined
      }
      if (models === 'tie' && call.agentIndex === 0) {
        return undefined
      }
      return models
        ? ballot(models === 'tie' ? (call.agentIndex === 2 ? 'B' : 'A') : String(models))
        : undefined
    })
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.outcome?.final?.markdown).toMatch(new RegExp(`^${shipped}\\n\\n`))
    expect(plan.outcome?.final?.markdown).toContain(note)
    expect(plan.runs.chair[0].finalCheck?.result).toBe(result)
    expect(plan.runs.chair[0].finalCheck?.judgedBy).toEqual(judgedBy)
    // Models are only ever attempted when JEV was unsure or could not answer at all — never
    // when a sure JEV verdict came back.
    const modelCallsMade = plan.calls.filter((call) => call.round === 2 && !call.jev).length
    expect(modelCallsMade > 0).toBe(unsure || !jev)
    expect(plan.calls.filter((call) => !call.jev).length).toBeLessThanOrEqual(
      planWorkflowCalls(council()).total
    )
  })

  it('skips without peer votes and keeps the chair', () => {
    const plan = drive(council(), (call) => (call.stepId === 'rank' ? undefined : initial(call)))
    expect(plan.outcome?.final?.markdown).toContain('Peer rankings counted no votes')
    expect(plan.runs.chair[0].finalCheck?.result).toBe('no-peer-votes')
    expect(plan.runs.chair[0].finalCheck?.judgedBy).toEqual([])
    // Peer rankings itself also gaps (no agent answered it at all); the final check's own gap
    // note is still present and last.
    expect(plan.outcome?.gaps?.at(-1)).toBe(
      "The final check was skipped: Peer rankings counted no votes, so the chairman's answer is shown unchecked."
    )
    expect(plan.calls.some((call) => call.round === 2)).toBe(false)
  })

  it('refuses the whole check when finishing and still reserves only the chair', () => {
    const spec = council()
    const plan = drive(spec, initial, { refused: (id) => id.startsWith('rank/r2/') })
    expect(workflowFinishReserve(spec)).toEqual({ finalStepId: 'chair', reserve: 1 })
    expect(plan.runs.chair[0].finalCheck?.result).toBe('finished-early')
    expect(plan.runs.chair[0].finalCheck?.judgedBy).toEqual([])
    expect(plan.outcome?.final?.markdown).toBe(
      'Chair answer\n\nThe final check was skipped: the run finished early.'
    )
    expect(plan.outcome?.gaps).toEqual(['The final check was skipped: the run finished early.'])
    expect(plan.calls.some((call) => call.round === 2)).toBe(false)
    expect(graphCallSuperseded(spec, 'rank/r2/a0', ['chair/a0'])).toBe(false)
    expect(graphCallSuperseded(spec, 'rank/a0', ['chair/a0'])).toBe(true)
  })

  it('still reports finished-early when only the JEV probe id would have been refused', () => {
    // Round 2 always starts with the JEV ballot (jev.only is forced on), never an agent call:
    // a refused() that only recognizes the real jev id must still be caught before it is built.
    const spec = council()
    const plan = drive(spec, initial, { refused: (id) => id === 'rank/r2/jev' })
    expect(plan.runs.chair[0].finalCheck?.result).toBe('finished-early')
    expect(plan.calls.some((call) => call.round === 2)).toBe(false)
  })

  it('F4: a round-2 JEV call already in flight when Finish now lands settles finished-early, never a bare failure', async () => {
    const spec = council()
    const context = createWorkflowProgramContext({
      agent: async (call) => text(call.id.startsWith('chair') ? 'Chair answer' : 'First opinion'),
      phase: () => {},
      log: () => {},
      guard: () => {},
      isFatal: () => false
    })
    // `started` flips only once the round-2 JEV call is actually dispatched, so `refused` is
    // false while it is built and sent (it must really go through graph-program.ts's `settle()`
    // JEV branch, in flight) and only true once Finish now lands mid-call.
    let started = false
    const result = await runWorkflowGraphProgram(
      context,
      {
        ...configFor(spec),
        refused: (id) => id === 'rank/r2/jev' && started,
        judgeWithJev: async (call) => {
          if (call.round === 2) {
            started = true
            return undefined as never
          }
          return { value: text('FINAL RANKING:\n1. Response A\n2. Response B\n3. Response C') }
        }
      },
      task
    )
    expect(result.final.markdown).toBe(
      'Chair answer\n\nThe final check was skipped: the run finished early.'
    )
    expect(result.gaps.at(-1)).toBe('The final check was skipped: the run finished early.')
  })
})
