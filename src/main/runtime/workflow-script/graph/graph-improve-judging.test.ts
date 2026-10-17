import { describe, expect, it, vi } from 'vitest'
import type { DecisionRequest, DecisionResult } from '../../../../shared/structured-decisions'
import type { WorkflowRoute, WorkflowSpec } from '../../../../shared/workflow-graph'
import { workflowPatchStep } from '../../../../shared/workflow-graph-edit'
import { workflowSetImprove } from '../../../../shared/workflow-graph-improve'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { graphJevBallot } from './graph-jev'
import { graphJudgingEntries } from './graph-judging-record'
import type { GraphCall } from './graph-plan-types'
import { configFor, drive, task, text } from './graph-test-harness'

const ROUTES: WorkflowRoute[] = ['claude', 'codex', 'grok']

function improve(candidates = 1, maxRounds = 2): WorkflowSpec {
  const spec = workflowSetImprove(workflowTemplate('improve', ROUTES), { candidates }, ROUTES)
  return { ...spec, repeat: { ...spec.repeat!, maxRounds } }
}

/** Ranks by the number in each version ("v2.1" beats "v1.0"); ties keep the shown order. */
function byNumber(call: GraphCall) {
  const ordered = [...call.jev!.candidates].sort(
    (left, right) =>
      Number(right.markdown.replace(/\D/g, '')) - Number(left.markdown.replace(/\D/g, ''))
  )
  return text(`FINAL RANKING:\n${ordered.map((entry, i) => `${i + 1}. ${entry.label}`).join('\n')}`)
}

const version = (call: GraphCall) => text(`v${call.round}.${call.agentIndex}`)

describe('Improve judging', () => {
  it('holds every version to the improvement instruction, for JEV and the model judges', () => {
    const spec = workflowPatchStep(improve(), 'improve', { instruction: 'Keep it under 50 words.' })
    const plan = drive(spec, (call) =>
      call.jev
        ? { ...byNumber(call), unsure: true }
        : call.stepId === 'improve'
          ? version(call)
          : text('FINAL RANKING:\n1. Response B\n2. Response A')
    )
    const jev = plan.calls.find((call) => call.id === 'judge/r2/jev')!
    expect(jev.jev!.task).toContain(task.prompt)
    expect(jev.jev!.task).toContain('Keep it under 50 words.')
    expect(plan.calls.find((call) => call.id === 'judge/r2/a0')!.prompt).toContain(
      'Every version must also follow this instruction: Keep it under 50 words.'
    )
    // Without an instruction JEV reads the task exactly as typed, so recorded ballots replay.
    const plain = drive(improve(), (call) =>
      call.jev ? byNumber(call) : call.stepId === 'improve' ? version(call) : undefined
    )
    expect(plain.calls.find((call) => call.id === 'judge/r2/jev')!.jev!.task).toBe(task.prompt)
  })

  it("aims every version at the person's criteria, from the first one on", () => {
    const criteria = '- Names one concrete use\n- No hype words'
    const spec = workflowPatchStep(improve(), 'judge', { instruction: criteria })
    const plan = drive(spec, (call) =>
      call.jev ? byNumber(call) : call.stepId === 'improve' ? version(call) : undefined
    )
    // Round one has no judges' notes yet (one first version is not judged), yet both rounds'
    // makers know what the judges will count as better.
    for (const id of ['improve/r1/a0', 'improve/r2/a0']) {
      const prompt = plan.calls.find((call) => call.id === id)!.prompt
      expect(prompt).toContain('What the judges count as better work')
      expect(prompt).toContain('- No hype words')
    }
    expect(plan.calls.find((call) => call.id === 'improve/r2/a0')!.prompt).not.toContain(
      'What the judges said last round'
    )
  })

  it('tells JEV which answer is the best version so far, and records it as defending', () => {
    const plan = drive(improve(2), (call) =>
      call.jev ? byNumber(call) : call.stepId === 'improve' ? version(call) : undefined
    )
    const round2 = plan.runs.judge.find((run) => run.round === 2)!
    const defending = round2.candidates!.filter((candidate) => candidate.incumbent)
    expect(defending).toHaveLength(1)
    expect(defending[0]!.markdown).toBe('v1.1')
    expect(plan.calls.find((call) => call.id === 'judge/r2/jev')!.jev!.incumbent).toBe(
      defending[0]!.label
    )
    const record = graphJudgingEntries(configFor(improve(2)), task, plan, 'run-1', 1)
    const second = record.find((entry) => entry.round === 2)!
    expect(second.candidates.filter((candidate) => candidate.incumbent)).toEqual([
      expect.objectContaining({ label: defending[0]!.label })
    ])
    // One challenger against the best version: the top-two rule already is this test.
    const single = drive(improve(1), (call) =>
      call.jev ? byNumber(call) : call.stepId === 'improve' ? version(call) : undefined
    )
    expect(single.calls.find((call) => call.id === 'judge/r2/jev')!.jev!.incumbent).toBeUndefined()
  })

  it('lets a JEV that barely prefers a challenger to the best version call in the models', async () => {
    // Not transitive: B clearly beats C, but only just beats A, the best version so far.
    const beats: Record<string, number> = { 'B>C': 0.95, 'B>A': 0.6, 'C>A': 0.9 }
    const evaluate = vi.fn(async (decision: DecisionRequest): Promise<DecisionResult> => {
      const state = decision.state as { response_1: string; response_2: string }
      const first = beats[`${state.response_1}>${state.response_2}`]
      const wins = first ?? 1 - beats[`${state.response_2}>${state.response_1}`]!
      return {
        provider: 'typesafe',
        model: 'jev',
        usage: { inputTokens: 1, outputTokens: 0 },
        answers: {
          better: {
            type: 'choice',
            choice: wins >= 0.5 ? 'response_1' : 'response_2',
            probabilities: { response_1: wins, response_2: 1 - wins },
            confidence: 1
          },
          driver: {
            type: 'choice',
            choice: 'task_fit',
            probabilities: { task_fit: 1 },
            confidence: 1
          }
        }
      }
    })
    const request = {
      method: 'pairwise' as const,
      task: 'Task',
      instruction: '',
      candidates: ['A', 'B', 'C'].map((label) => ({ label, markdown: label }))
    }
    const options = { evaluate, credential: async () => 'k'.repeat(24), environment: {} }
    expect(await graphJevBallot(request, options)).toMatchObject({ unsure: false })
    const defended = await graphJevBallot({ ...request, incumbent: 'A' }, options)
    expect(defended).toMatchObject({ unsure: true })
    expect('markdown' in defended && defended.markdown).toContain('best version so far')
  })

  it('says a first version was taken unjudged, once, when no judge vote counted', () => {
    const plan = drive(improve(2, 2), (call) =>
      call.stepId === 'improve' ? version(call) : undefined
    )
    const first = plan.loop!.improve!.rounds[0]!
    expect(first).toMatchObject({ result: 'first' })
    expect(first.reason).toContain('first version that came back was taken unjudged')
    const gaps = plan.outcome!.gaps
    expect(gaps.filter((gap) => gap.includes('round 1') || gap.startsWith('Round 1'))).toEqual([
      expect.stringContaining('taken unjudged')
    ])
    expect(gaps.join(' ')).not.toContain('Judge (round 1)')
    // Round two could not be judged either: named once, and the best version stays.
    expect(gaps.filter((gap) => /round 2/i.test(gap))).toHaveLength(1)
    expect(plan.outcome?.final?.markdown).toContain('not judged, the first that came back')
  })

  it("takes an unsure JEV's lean in round one, said to be unjudged, when no model can settle it", () => {
    const plan = drive(improve(2, 1), (call) =>
      call.jev
        ? { ...byNumber(call), unsure: true }
        : call.stepId === 'improve'
          ? version(call)
          : undefined
    )
    expect(plan.loop!.improve!.rounds[0]).toMatchObject({
      result: 'first',
      reason: expect.stringContaining("JEV's closer pick was taken unjudged")
    })
    expect(plan.outcome?.final?.markdown.startsWith('v1.1')).toBe(true)
    expect(plan.outcome?.final?.markdown).toContain("not judged, JEV's closer pick became the best")
  })

  it("counts an unsure JEV when two families judge each other's work and no model may compare them", () => {
    const two: WorkflowRoute[] = ['claude', 'codex']
    const base = workflowSetImprove(
      workflowTemplate('improve', two),
      { candidates: 2, models: { mode: 'multi' } },
      two
    )
    const spec = { ...base, repeat: { ...base.repeat!, maxRounds: 1 } }
    expect(spec.steps[1].agents.map((agent) => agent.route)).toEqual(['claude', 'codex'])
    // Each model judge may place only the other family's answer: alone, they tie on the midpoint.
    const plan = drive(spec, (call) =>
      call.jev
        ? { ...byNumber(call), unsure: true }
        : call.stepId === 'improve'
          ? version(call)
          : text('FINAL RANKING:\n1. Response A\n2. Response B')
    )
    expect(plan.loop!.improve!.rounds[0]).toMatchObject({
      result: 'first',
      jevUnsure: true,
      jevCounted: true,
      judgedBy: ['jev', 'models']
    })
    // JEV's lean (the GPT version) settles what no model judge could compare.
    expect(plan.outcome?.final?.markdown.startsWith('v1.1')).toBe(true)
    expect(plan.outcome?.final?.markdown).toContain('decided by JEV and models; JEV was unsure)')
    const record = graphJudgingEntries(configFor(spec), task, plan, 'run-1', 1)
    expect(record[0]!.jev).toMatchObject({ unsure: true, counted: true })
  })

  it('sets an unsure JEV aside when the model judge can compare every answer, and says so', () => {
    const plan = drive(improve(2, 1), (call) =>
      call.jev
        ? { ...byNumber(call), unsure: true }
        : call.stepId === 'improve'
          ? version(call)
          : text('FINAL RANKING:\n1. Response A\n2. Response B')
    )
    const first = plan.loop!.improve!.rounds[0]!
    expect(first).toMatchObject({ result: 'first', jevUnsure: true })
    expect(first.jevCounted).toBeUndefined()
    // The model judge (another family) decides against JEV's lean.
    expect(plan.outcome?.final?.markdown.startsWith('v1.0')).toBe(true)
    expect(plan.outcome?.final?.markdown).toContain(
      'decided by models; JEV was unsure, so it stood aside'
    )
    const record = graphJudgingEntries(configFor(improve(2, 1)), task, plan, 'run-1', 1)
    expect(record[0]!.jev).toMatchObject({ unsure: true, counted: false })
  })
})
