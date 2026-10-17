import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bestOfN } from './fixtures/best-of-n-legacy-builder'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import type { DecisionRequest, DecisionResult } from '../../../../shared/structured-decisions'
import { createWorkflowProgramContext } from '../workflow-program-context'
import { createGraphJevJudge, graphJevBallot } from './graph-jev'
import { GraphJevStore } from './graph-jev-store'
import { runWorkflowGraphProgram } from './graph-program'
import type { GraphCall, GraphJevRequest } from './graph-plan-types'
import { configFor, drive, task, text } from './graph-test-harness'

const ROUTES = ['claude', 'codex', 'grok'] as const

/** Best of N with these judges: `null` for the model judges alone, absent for the default. */
function bestOf(jev?: { method: 'auto' | 'rubric' | 'pairwise'; only?: boolean } | null) {
  const spec = normalizeWorkflowSpec(bestOfN(ROUTES), ROUTES)
  return normalizeWorkflowSpec(
    {
      ...spec,
      steps: spec.steps.map((step) => {
        if (step.kind !== 'rank' || jev === undefined) {
          return step
        }
        const { jev: _jev, ...rest } = step
        return jev ? { ...rest, jev } : rest
      })
    },
    ROUTES
  )
}

const ballot = (...labels: string[]) =>
  text(`Reasons.\n\nFINAL RANKING:\n${labels.map((label, i) => `${i + 1}. ${label}`).join('\n')}`)

/** Answers every generator, then ballots: JEV ranks D first, the models rank A first. */
function answer(jev: 'ok' | 'fail') {
  return (call: GraphCall) => {
    if (call.jev) {
      return jev === 'ok'
        ? ballot('Response D', 'Response C', 'Response B', 'Response A')
        : undefined
    }
    return call.stepId === 'generate'
      ? text(`Version ${call.agentIndex + 1}`)
      : ballot('Response A', 'Response B', 'Response C', 'Response D')
  }
}

describe('Best of N', () => {
  it('judges with JEV first by default', () => {
    expect(bestOf().steps.find((step) => step.kind === 'rank')?.jev).toEqual({
      method: 'auto',
      only: true
    })
  })

  it('ends with the winning version itself and the rankings', () => {
    const spec = bestOf(null)
    expect(spec.template).toBe('best-of-n')
    expect(spec.steps.map((step) => step.kind)).toEqual(['do', 'rank'])
    expect(new Set(spec.steps[0]!.agents.map((agent) => agent.angle)).size).toBe(4)
    const plan = drive(spec, answer('ok'))
    expect(plan.outcome).toMatchObject({ state: 'completed' })
    const markdown = plan.outcome?.state === 'completed' ? (plan.outcome.final?.markdown ?? '') : ''
    expect(markdown).toContain('## Ranked first:')
    expect(markdown).toContain('Version 1')
  })

  it('counts JEV as one more ballot beside the model judges', () => {
    const plan = drive(bestOf({ method: 'rubric' }), answer('ok'))
    const judge = plan.runs.judge!.at(-1)!
    expect(judge.calls.filter((view) => view.jev)).toHaveLength(1)
    expect(judge.calls.filter((view) => !view.jev)).toHaveLength(3)
    // D came from the Claude seat, so Claude's own vote is set aside; JEV's ballot counts.
    expect(judge.standings?.find((standing) => standing.label === 'Response D')?.votes).toBe(3)
    expect(judge.calls.find((view) => view.jev)?.ranking?.[0]).toBe('Response D')
  })

  it('with JEV alone, no model judge runs and JEV names the winner', () => {
    const plan = drive(bestOf({ method: 'pairwise', only: true }), answer('ok'))
    const judge = plan.runs.judge!.at(-1)!
    expect(judge.calls.map((view) => view.jev === true)).toEqual([true])
    expect(plan.outcome).toMatchObject({ state: 'completed' })
    const markdown = plan.outcome?.state === 'completed' ? (plan.outcome.final?.markdown ?? '') : ''
    expect(markdown).toContain('Version 4')
  })

  it('falls back to the model judges when JEV cannot judge, and says so', () => {
    const plan = drive(bestOf({ method: 'rubric', only: true }), answer('fail'))
    const judge = plan.runs.judge!.at(-1)!
    expect(judge.calls.filter((view) => !view.jev)).toHaveLength(3)
    expect(judge.state).toBe('done')
    expect(judge.notes.join(' ')).toContain('JEV could not judge')
    expect(plan.outcome).toMatchObject({ state: 'completed' })
  })

  it('never sends a JEV call to an agent', async () => {
    const spec = bestOf({ method: 'rubric', only: true })
    const agent = vi.fn(async (call: GraphCall) => answer('ok')(call))
    const judgeWithJev = vi.fn(async (call: GraphCall) => ({ value: answer('ok')(call) }))
    const context = createWorkflowProgramContext({
      agent: agent as never,
      phase: () => {},
      log: () => {},
      guard: () => {},
      isFatal: () => false
    })
    const result = await runWorkflowGraphProgram(
      context,
      { ...configFor(spec), judgeWithJev },
      task
    )
    expect(judgeWithJev).toHaveBeenCalledTimes(1)
    expect(agent.mock.calls.every(([call]) => !call.jev)).toBe(true)
    expect(result.final.markdown).toContain('Version 4')
  })
})

const request = (method: 'rubric' | 'pairwise'): GraphJevRequest => ({
  method,
  task: 'Write a tagline',
  instruction: '',
  candidates: ['A', 'B', 'C'].map((letter) => ({
    label: `Response ${letter}`,
    markdown: `Tagline ${letter}`
  }))
})

function result(answers: DecisionResult['answers']): DecisionResult {
  return {
    provider: 'typesafe',
    model: 'jev-1.13.0',
    answers,
    usage: { inputTokens: 1, outputTokens: 0 }
  }
}

const key = async () => 'k'.repeat(24)

/** Answers every Score question the request asked. */
function scoreAll(decision: DecisionRequest, score: (id: string) => number): DecisionResult {
  return result(
    Object.fromEntries(
      Object.keys(decision.questions).map((id) => [
        id,
        { type: 'score' as const, score: score(id), legend: {}, probabilities: {}, confidence: 0.8 }
      ])
    )
  )
}

describe('graphJevBallot', () => {
  it('ranks by rubric score', async () => {
    const scores: Record<string, number> = { 'Tagline A': 1, 'Tagline B': 3.5, 'Tagline C': 2 }
    const evaluate = async (decision: DecisionRequest) =>
      scoreAll(decision, (id) =>
        id === 'quality' ? scores[(decision.state as { response: string }).response]! : 2
      )
    const out = await graphJevBallot(request('rubric'), {
      evaluate,
      credential: key,
      environment: {}
    })
    expect('markdown' in out && out.markdown).toContain(
      'FINAL RANKING:\n1. Response B\n2. Response C\n3. Response A'
    )
  })

  it('scores each written criterion in the same request and names each criterion leader', async () => {
    const evaluate = vi.fn(async (decision: DecisionRequest) => {
      const response = (decision.state as { response: string }).response
      // A is best overall, C is the only one strong on evidence.
      return scoreAll(decision, (id) =>
        id === 'c2' ? (response === 'Tagline C' ? 4 : 1) : response === 'Tagline A' ? 3.5 : 2
      )
    })
    const out = await graphJevBallot(
      {
        ...request('rubric'),
        instruction: 'Judge taglines:\n- Memorable in five words\n- Backed by a proof point'
      },
      { evaluate, credential: key, environment: {} }
    )
    expect(evaluate).toHaveBeenCalledTimes(3)
    expect(Object.keys(evaluate.mock.calls[0]![0].questions)).toEqual(['quality', 'c1', 'c2'])
    const markdown = 'markdown' in out ? out.markdown : ''
    expect(markdown).toContain('- Backed by a proof point: Response C (4.00)')
    expect(markdown).toMatch(/FINAL RANKING:\n1\. Response A/)
  })

  it('ranks pairwise in both orders, so position cannot decide', async () => {
    // Always prefers whichever response is Tagline C, wherever it is shown.
    const evaluate = async (decision: DecisionRequest) => {
      const state = decision.state as { response_1: string; response_2: string }
      const first =
        state.response_1 === 'Tagline C' ? 0.9 : state.response_2 === 'Tagline C' ? 0.1 : 0.5
      return result({
        better: {
          type: 'choice',
          choice: first >= 0.5 ? 'response_1' : 'response_2',
          probabilities: { response_1: first, response_2: 1 - first },
          confidence: 0.8
        },
        driver: {
          type: 'choice',
          choice: 'c1',
          probabilities: { c1: 1 },
          confidence: 0.8
        }
      })
    }
    const spy = vi.fn(evaluate)
    const out = await graphJevBallot(
      {
        ...request('pairwise'),
        instruction: 'Judge taglines:\n- Memorable in five words\n- Backed by a proof point'
      },
      {
        evaluate: spy,
        credential: key,
        environment: {}
      }
    )
    // A against B ties at 0.5 shown one way, so it is not asked the other way round.
    expect(spy).toHaveBeenCalledTimes(5)
    expect(spy.mock.calls[0]![0].questions.driver).toMatchObject({
      criteria: { c1: 'Memorable in five words', c2: 'Backed by a proof point' }
    })
    const markdown = 'markdown' in out ? out.markdown : ''
    expect(markdown).toMatch(/FINAL RANKING:\n1\. Response C/)
    expect(markdown).toContain('comparisons most often turned on: Memorable in five words (5)')
  })

  it('gives no ballot without a key, when turned off, or when any call fails', async () => {
    expect(
      await graphJevBallot(request('rubric'), {
        credential: async () => undefined,
        environment: {}
      })
    ).toEqual({
      failed: expect.stringContaining('TYPESAFE_API_KEY')
    })
    expect(
      await graphJevBallot(request('rubric'), {
        credential: key,
        environment: { JEV_DECISIONS_DISABLED: '1' }
      })
    ).toEqual({ failed: expect.stringContaining('turned off') })
    const flaky = vi.fn(async () => {
      throw new Error('boom')
    })
    expect(
      await graphJevBallot(request('rubric'), { evaluate: flaky, credential: key, environment: {} })
    ).toEqual({
      failed: 'boom'
    })
  })
})

describe('the kept JEV judgment', () => {
  it('keeps rubric certainty and pairwise probabilities beside an unchanged ballot', async () => {
    const levels = { '0': 0, '1': 0, '2': 0.5, '3': 0.5, '4': 0 }
    const rubric = await graphJevBallot(request('rubric'), {
      evaluate: async (decision) =>
        result(
          Object.fromEntries(
            Object.keys(decision.questions).map((id) => [
              id,
              {
                type: 'score' as const,
                score: 2.5,
                legend: { '0': 'a', '1': 'b', '2': 'c', '3': 'd', '4': 'e' },
                probabilities: levels,
                confidence: 0.6
              }
            ])
          )
        ),
      credential: key,
      environment: {}
    })
    expect('judgment' in rubric && rubric.judgment).toMatchObject({
      method: 'rubric',
      certainty: { 'Response A': { confidence: 0.6, levels: [0, 0, 0.5, 0.5, 0] } },
      usage: { inputTokens: 3, outputTokens: 0 },
      calls: 3
    })
    const pairwise = await graphJevBallot(request('pairwise'), {
      evaluate: async () =>
        result({
          better: {
            type: 'choice',
            choice: 'response_1',
            probabilities: { response_1: 0.7, response_2: 0.3 },
            confidence: 0.5
          },
          driver: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 }
        }),
      credential: key,
      environment: {}
    })
    const judgment = 'judgment' in pairwise ? pairwise.judgment : undefined
    expect(judgment?.pairs).toHaveLength(6)
    expect(judgment?.pairs?.[0]).toEqual({
      first: 'Response A',
      second: 'Response B',
      probability: 0.7
    })
  })
})

let root = ''
afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true })
    root = ''
  }
})

describe('createGraphJevJudge', () => {
  it('asks once and replays the kept ballot; a replay-only judge never asks', async () => {
    root = mkdtempSync(join(tmpdir(), 'graph-jev-'))
    const store = GraphJevStore.forExecution('exec-1', root)
    const evaluate = vi.fn(async (decision: DecisionRequest) => scoreAll(decision, () => 2))
    const judge = createGraphJevJudge({ store, evaluate, credential: key, environment: {} })
    const call = { id: 'judge/jev', stepId: 'judge', jev: request('rubric') } as GraphCall
    const first = await judge(call)
    const second = await judge(call)
    expect(first).toEqual(second)
    expect(evaluate).toHaveBeenCalledTimes(3)
    const replay = createGraphJevJudge({ store, cacheOnly: true })
    expect(await replay(call)).toEqual(first)
    await expect(replay({ ...call, id: 'other/jev' })).rejects.toThrow('not recorded')
  })
})

describe('Best of N on one model family', () => {
  it("counts the model judges when every version is their own model's", async () => {
    const { validateWorkflowSpec } = await import('../../../../shared/workflow-graph-validate')
    const one = ['claude'] as const
    const spec = normalizeWorkflowSpec(
      {
        ...normalizeWorkflowSpec(bestOfN(one), one),
        steps: normalizeWorkflowSpec(bestOfN(one), one).steps.map((step) => {
          const { jev: _jev, ...rest } = step
          return rest
        })
      },
      one
    )
    expect(validateWorkflowSpec(spec, { available: one }).problems).toEqual([])
    const plan = drive(spec, (call) =>
      call.stepId === 'generate'
        ? text(`Version ${call.agentIndex + 1}`)
        : ballot('Response C', 'Response A', 'Response B', 'Response D')
    )
    expect(plan.outcome).toMatchObject({ state: 'completed' })
    const markdown = plan.outcome?.state === 'completed' ? (plan.outcome.final?.markdown ?? '') : ''
    expect(markdown).toContain('Version 3')
  })
})
