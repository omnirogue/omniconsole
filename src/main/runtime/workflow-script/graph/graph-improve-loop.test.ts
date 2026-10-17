import { describe, expect, it } from 'vitest'
import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowSetImprove } from '../../../../shared/workflow-graph-improve'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { validateWorkflowSpec } from '../../../../shared/workflow-graph-validate'
import { graphCallSuperseded } from './graph-supersede'
import { planWorkflowGraph, type GraphCall } from './graph-plan'
import { configFor, drive, task, text } from './graph-test-harness'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']

/** How good each version is: the scripted judges rank by this, never by recency. */
type Quality = Record<string, number>

function improve(
  options: {
    candidates?: number
    multi?: boolean
    explore?: 'low' | 'normal' | 'high'
    maxRounds?: number
  } = {}
): WorkflowSpec {
  let spec = workflowTemplate('improve', ROUTES)
  spec = workflowSetImprove(
    spec,
    {
      ...(options.candidates ? { candidates: options.candidates } : {}),
      ...(options.multi ? { models: { mode: 'multi' as const } } : {})
    },
    ROUTES
  )
  return {
    ...spec,
    repeat: {
      ...spec.repeat!,
      ...(options.explore ? { explore: options.explore } : {}),
      ...(options.maxRounds ? { maxRounds: options.maxRounds } : {})
    }
  }
}

/** A JEV ballot ordering the answers by quality (ties keep the shown order). */
function jevBallot(call: GraphCall, quality: Quality, extra: object = {}) {
  const ordered = [...call.jev!.candidates].sort(
    (left, right) => (quality[right.markdown] ?? 0) - (quality[left.markdown] ?? 0)
  )
  return {
    markdown: `FINAL RANKING:\n${ordered.map((entry, index) => `${index + 1}. ${entry.label}`).join('\n')}`,
    ...extra
  }
}

/** Each improver writes "v<round>" (or "v<round>.<agent>" with several). */
function versions(quality: Quality, several = false) {
  return (call: GraphCall) => {
    if (call.jev) {
      return jevBallot(call, quality)
    }
    return call.stepId === 'improve'
      ? text(several ? `v${call.round}.${call.agentIndex}` : `v${call.round}`)
      : undefined
  }
}

const trailOf = (plan: ReturnType<typeof drive>) => plan.loop!.improve!
const results = (plan: ReturnType<typeof drive>) =>
  trailOf(plan).rounds.map((round) => round.result)
const promptOf = (plan: ReturnType<typeof drive>, id: string) =>
  plan.calls.find((call) => call.id === id)!.prompt

describe('Improve, one model, one version at a time (the default)', () => {
  it('keeps a challenger only when the judges prefer it, and returns the best, not the newest', () => {
    const plan = drive(improve(), versions({ v1: 1, v2: 2, v3: 3 }))
    expect(results(plan)).toEqual(['first', 'new-best', 'new-best', 'kept', 'kept', 'kept'])
    expect(trailOf(plan).rounds.map((round) => round.mode)).toEqual([
      'first',
      'improve',
      'improve',
      'improve',
      'improve',
      'divergent'
    ])
    expect(trailOf(plan).stop).toBe('plateau')
    expect(trailOf(plan).best).toMatchObject({ round: 3 })
    expect(plan.outcome).toMatchObject({ state: 'completed' })
    const markdown = plan.outcome?.final?.markdown ?? ''
    expect(markdown.startsWith('v3')).toBe(true)
    expect(markdown).toContain('How this was found')
    expect(markdown).toContain('2 rounds in a row brought no improvement')
  })

  it('starts with one version, then improves the best one, anchored to the original task', () => {
    const plan = drive(improve(), versions({ v1: 1, v2: 2, v3: 3 }))
    // One first version needs no judge.
    expect(plan.calls.some((call) => call.id.startsWith('judge/r1/'))).toBe(false)
    const second = promptOf(plan, 'improve/r2/a0')
    expect(second).toContain(task.prompt)
    expect(second).toContain('The best version so far')
    expect(second).toContain('v1')
    expect(second).toContain('never drift to an easier, narrower or different goal')
    // The divergent round asks for a fundamentally different approach.
    expect(promptOf(plan, 'improve/r6/a0')).toContain('fundamentally different approach')
  })

  it('lets JEV decide alone when it is sure', () => {
    const plan = drive(improve(), versions({ v1: 1, v2: 2 }))
    expect(plan.calls.filter((call) => call.stepId === 'judge' && !call.jev)).toEqual([])
    expect(trailOf(plan).rounds[1]).toMatchObject({ result: 'new-best', judgedBy: ['jev'] })
    expect(promptOf(plan, 'improve/r3/a0')).toContain('What the judges count as better work')
    expect(promptOf(plan, 'improve/r3/a0')).toContain('correct, complete, clear, and ready to use')
  })

  it('lets the model judge decide when JEV is unsure (the cascade), keeping JEV for the record', () => {
    const plan = drive(improve({ maxRounds: 2 }), (call) => {
      if (call.jev) {
        // JEV leans to the best version, unsure.
        return jevBallot(call, { v1: 2, v2: 1 }, { unsure: true })
      }
      if (call.stepId === 'improve') {
        return text(`v${call.round}`)
      }
      // Round 2 shows the best version first (Response A); the model judge prefers the challenger.
      return text('FINAL RANKING:\n1. Response B\n2. Response A')
    })
    expect(trailOf(plan).rounds[1]).toMatchObject({
      result: 'new-best',
      jevUnsure: true,
      agreed: false,
      judgedBy: ['jev', 'models']
    })
    expect(plan.outcome?.final?.markdown.startsWith('v2')).toBe(true)
    const judged = plan.runs.judge.find((run) => run.round === 2)!
    expect(judged.calls.find((view) => view.jev)?.ranking).toEqual(['Response A', 'Response B'])
  })

  it('with JEV and models both voting, an unsure JEV still counts, so a split keeps the best', () => {
    const spec = improve({ maxRounds: 2 })
    const both = {
      ...spec,
      steps: spec.steps.map((step) =>
        step.kind === 'rank' ? { ...step, jev: { method: 'auto' as const } } : step
      )
    }
    const plan = drive(both, (call) =>
      call.jev
        ? jevBallot(call, { v1: 2, v2: 1 }, { unsure: true })
        : call.stepId === 'improve'
          ? text(`v${call.round}`)
          : text('FINAL RANKING:\n1. Response B\n2. Response A')
    )
    expect(trailOf(plan).rounds[1]).toMatchObject({ result: 'kept' })
    expect(plan.outcome?.final?.markdown.startsWith('v1')).toBe(true)
  })

  it('calls in the model judge when JEV is unsure, and keeps the best version it prefers', () => {
    const quality = { v1: 1, v2: 2 }
    const plan = drive(improve({ maxRounds: 2 }), (call) => {
      if (call.jev) {
        return jevBallot(call, quality, { unsure: true })
      }
      if (call.stepId === 'improve') {
        return text(`v${call.round}`)
      }
      // Round 2 shows the best version first (Response A); the model judge prefers it.
      return text('FINAL RANKING:\n1. Response A\n2. Response B')
    })
    const round = trailOf(plan).rounds[1]
    expect(round).toMatchObject({ result: 'kept', jevUnsure: true, judgedBy: ['jev', 'models'] })
    expect(plan.outcome?.final?.markdown.startsWith('v1')).toBe(true)
  })

  it('keeps the best version when JEV is unsure and no model judge can settle it', () => {
    const plan = drive(improve({ maxRounds: 2 }), (call) =>
      call.jev
        ? jevBallot(call, { v1: 1, v2: 2 }, { unsure: true })
        : call.stepId === 'improve'
          ? text(`v${call.round}`)
          : undefined
    )
    expect(trailOf(plan).rounds[1]).toMatchObject({ result: 'unjudged' })
    expect(plan.outcome?.final?.markdown.startsWith('v1')).toBe(true)
    expect(plan.outcome?.gaps.join(' ')).toContain('JEV was not sure')
  })

  it('lets the model judge decide when JEV is unavailable', () => {
    const plan = drive(improve({ maxRounds: 2 }), (call) =>
      call.jev
        ? undefined
        : call.stepId === 'improve'
          ? text(`v${call.round}`)
          : // The challenger is Response B in round 2.
            text('FINAL RANKING:\n1. Response B\n2. Response A')
    )
    expect(trailOf(plan).rounds[1]).toMatchObject({ result: 'new-best', judgedBy: ['models'] })
    expect(plan.outcome?.final?.markdown.startsWith('v2')).toBe(true)
  })

  it('never loses the best version when a round brings nothing back', () => {
    const plan = drive(improve({ maxRounds: 3 }), (call) =>
      call.jev
        ? jevBallot(call, { v1: 1, v3: 3 })
        : call.stepId === 'improve' && call.round !== 2
          ? text(`v${call.round}`)
          : undefined
    )
    expect(results(plan)).toEqual(['first', 'failed', 'new-best'])
    expect(plan.outcome?.final?.markdown.startsWith('v3')).toBe(true)
    expect(plan.outcome?.gaps.join(' ')).toContain('round 2')
  })

  it('fails only when not even a first version came back', () => {
    const plan = drive(improve(), () => undefined)
    expect(plan.outcome).toMatchObject({ state: 'failed' })
  })

  it('with exploring low, stops at the plateau without a divergent round', () => {
    const plan = drive(improve({ explore: 'low' }), versions({ v1: 1, v2: 2 }))
    expect(results(plan)).toEqual(['first', 'new-best', 'kept', 'kept'])
    expect(trailOf(plan).rounds.some((round) => round.mode === 'divergent')).toBe(false)
  })

  it('says when the round limit stopped it while it was still improving', () => {
    const plan = drive(improve({ maxRounds: 3 }), versions({ v1: 1, v2: 2, v3: 3 }))
    expect(trailOf(plan).stop).toBe('max-rounds')
    expect(plan.outcome?.gaps.join(' ')).toContain('Still improving')
  })

  it('plans the same run from the same outcomes (replay)', () => {
    const spec = improve()
    const plan = drive(spec, versions({ v1: 1, v2: 2, v3: 3 }))
    const outcomes = new Map(plan.calls.map((call) => [call.id, { value: {} }]))
    const again = (ids: Map<string, { value: unknown }>) =>
      JSON.stringify(planWorkflowGraph(configFor(spec), task, ids).calls.map((call) => call.id))
    expect(again(outcomes)).toEqual(again(outcomes))
  })
})

describe('Improve with several candidates (Best of N)', () => {
  it('judges every challenger against the best version, blind, and keeps the strongest', () => {
    const quality = { 'v1.0': 1, 'v1.1': 3, 'v1.2': 2, 'v2.0': 4, 'v2.1': 0, 'v2.2': 0 }
    const plan = drive(
      improve({ candidates: 3, multi: true, maxRounds: 2 }),
      versions(quality, true)
    )
    expect(results(plan)).toEqual(['first', 'new-best'])
    expect(plan.outcome?.final?.markdown.startsWith('v2.0')).toBe(true)
    const round = trailOf(plan).rounds[1]
    expect(round.candidates).toHaveLength(4)
    expect(round.candidates.filter((candidate) => candidate.accepted)).toHaveLength(1)
    // Multi-model: the improvers rotate across the families.
    expect(new Set(round.candidates.map((candidate) => candidate.seatId)).size).toBe(3)
  })

  it('sends one explorer after a different approach, building on the best losing alternative', () => {
    const quality = { 'v1.0': 1, 'v1.1': 3, 'v1.2': 2 }
    const plan = drive(improve({ candidates: 3, maxRounds: 2 }), versions(quality, true))
    const exploit = promptOf(plan, 'improve/r2/a0')
    const explore = promptOf(plan, 'improve/r2/a2')
    expect(exploit).toContain('The best version so far')
    expect(exploit).not.toContain('A promising alternative approach')
    expect(explore).toContain('A promising alternative approach')
    // The round-one runner-up (v1.2 ranked second behind v1.1) is the alternative.
    expect(explore).toContain('v1.2')
  })
})

describe('Improve as a graph', () => {
  it('is valid by default, one model at a time, with JEV first', () => {
    const spec = improve()
    expect(validateWorkflowSpec(spec, { available: ROUTES }).problems).toEqual([])
    expect(spec.steps[0].agents).toHaveLength(1)
    // The model that does the work never judges it when another family can.
    expect(spec.steps[1].agents.map((agent) => agent.route)).toEqual(['codex'])
    const alone = workflowTemplate('improve', ['claude'])
    expect(alone.steps[1].agents.map((agent) => agent.route)).toEqual(['claude'])
    expect(spec.steps[1].jev).toEqual({ method: 'auto', only: true })
    expect(spec.repeat).toMatchObject({ until: 'plateau', patience: 2, maxRounds: 6 })
  })

  it('refuses shapes that cannot improve whole versions', () => {
    const spec = improve()
    const listing = {
      ...spec,
      steps: spec.steps.map((step) =>
        step.id === 'improve' ? { ...step, list: { maxItems: 5 } } : step
      )
    }
    expect(validateWorkflowSpec(listing, { available: ROUTES }).problems.length).toBeGreaterThan(0)
    const tooMany = workflowSetImprove(spec, { candidates: 20 }, ROUTES)
    expect(tooMany.steps[0].agents).toHaveLength(7)
    expect(validateWorkflowSpec(tooMany, { available: ROUTES }).problems).toEqual([])
    const tooLong = { ...spec, repeat: { ...spec.repeat!, maxRounds: 11 } }
    expect(validateWorkflowSpec(tooLong, { available: ROUTES }).problems.length).toBeGreaterThan(0)
  })

  it('closes a round once a later round has recorded a call', () => {
    const spec = improve()
    expect(graphCallSuperseded(spec, 'improve/r1/a0', ['improve/r2/a0'])).toBe(true)
    expect(graphCallSuperseded(spec, 'judge/r2/jev', ['improve/r3/a0'])).toBe(true)
    expect(graphCallSuperseded(spec, 'judge/r2/jev', ['judge/r2/a0'])).toBe(false)
  })
})
