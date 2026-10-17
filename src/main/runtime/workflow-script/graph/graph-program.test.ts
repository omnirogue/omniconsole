import { configFor, fakeContext, Fatal, text, task, research } from './graph-program-test-harness'
import { describe, expect, it } from 'vitest'
import { normalizeWorkflowSpec } from '../../../../shared/workflow-graph-normalize'
import { workflowTemplate } from '../../../../shared/workflow-graph-templates'
import { createWorkflowProgramContext } from '../workflow-program-context'
import { runWorkflowGraphProgram } from './graph-program'
import { planWorkflowGraph, type GraphConfig, type GraphOutcome } from './graph-plan'
import {
  graphJudgesCompareEveryPair,
  graphStandings,
  graphTally,
  parseGraphVerdict
} from './graph-parse'
import { graphCallSuperseded } from './graph-supersede'

describe('workflow graph program', () => {
  it('runs research → critics → synthesis with parallel fan-out and blind review', async () => {
    const { context, calls } = fakeContext((call) =>
      call.id.startsWith('research')
        ? text(`finding from ${call.seatId}`)
        : call.id.startsWith('critics')
          ? text(`Response B is weak.\nVERDICT: FAIL`)
          : text('The final answer.')
    )
    const result = await runWorkflowGraphProgram(context, configFor(research), task)
    expect(result).toEqual({ final: { stepId: 'final', markdown: 'The final answer.' }, gaps: [] })
    expect(calls.map((call) => call.id)).toEqual([
      'research/a0',
      'research/a1',
      'research/a2',
      'research/a3',
      'critics/a0',
      'critics/a1',
      'final/a0'
    ])
    const critic = calls.find((call) => call.id === 'critics/a0')!
    // Critics see anonymous labels, never model names.
    expect(critic.prompt).toContain('### Response A\nfinding from seat-claude')
    expect(critic.prompt).not.toContain('Claude Opus 5')
    expect(critic.prompt).toContain('VERDICT: PASS')
    const final = calls.find((call) => call.id === 'final/a0')!
    expect(final.prompt).toContain('### Response A — Claude Opus 5')
    expect(final.prompt).toContain('VERDICT: FAIL')
    expect(final.dependencies).toEqual([
      'critics/a0',
      'critics/a1',
      'research/a0',
      'research/a1',
      'research/a2',
      'research/a3'
    ])
  })

  it('degrades visibly when an agent fails and still completes', async () => {
    const { context } = fakeContext((call) =>
      call.id === 'research/a2'
        ? new Error('Grok timed out')
        : call.id.startsWith('critics')
          ? text('ok\nVERDICT: PASS')
          : text(`answer ${call.id}`)
    )
    const result = await runWorkflowGraphProgram(context, configFor(research), task)
    expect(result.gaps).toEqual(['Research: 1 agent call of 4 did not return a result.'])
  })

  it('fails the run, marks everything downstream not run, and never calls it', async () => {
    const { context, calls } = fakeContext((call) =>
      call.id.startsWith('research') ? new Error('down') : text('x\nVERDICT: PASS')
    )
    await expect(runWorkflowGraphProgram(context, configFor(research), task)).rejects.toThrow(
      'Research failed: none of its 4 agent calls returned a result.'
    )
    expect(calls.every((call) => call.id.startsWith('research'))).toBe(true)
    const outcomes = new Map<string, GraphOutcome>(
      calls.map((call) => [call.id, { failed: true } as const])
    )
    const plan = planWorkflowGraph(configFor(research), task, outcomes)
    expect(plan.runs.critics[0]).toMatchObject({
      state: 'not-run',
      reason: 'Not run: Research failed.'
    })
    expect(plan.runs.final[0].state).toBe('not-run')
    expect(plan.outcome?.state).toBe('failed')
  })

  it('stops launching and rethrows on a fatal error', async () => {
    const { context, calls } = fakeContext((call) =>
      call.id === 'research/a1' ? new Fatal('Workflow stopped') : text('x')
    )
    await expect(runWorkflowGraphProgram(context, configFor(research), task)).rejects.toThrow(
      'Workflow stopped'
    )
    expect(calls.some((call) => call.id.startsWith('critics'))).toBe(false)
  })

  it('runs Karpathy’s council: blind full ballots, self-votes removed and renumbered', async () => {
    const { finalCheck: _check, ...council } = workflowTemplate('council')
    const { context, calls } = fakeContext((call) => {
      if (call.id.startsWith('answer')) {
        return text(`answer from ${call.seatId}`)
      }
      if (call.id.startsWith('rank')) {
        // Every ranker puts itself first, then A, B, C, D in order.
        const own = { 'seat-claude': 'A', 'seat-codex': 'B', 'seat-grok': 'C' }[call.seatId]!
        const order = [own, ...['A', 'B', 'C', 'D'].filter((letter) => letter !== own)]
        return text(
          `Thoughts.\n\nFINAL RANKING:\n${order.map((letter, index) => `${index + 1}. Response ${letter}`).join('\n')}`
        )
      }
      return text('Chairman answer')
    })
    const result = await runWorkflowGraphProgram(context, configFor(council), task)
    expect(result.final.markdown).toBe('Chairman answer')
    // Gemini answers but never ranks or chairs.
    expect(calls.filter((call) => call.id.startsWith('rank')).map((call) => call.seatId)).toEqual([
      'seat-claude',
      'seat-codex',
      'seat-grok'
    ])
    // Each ranker sees every answer, its own included, in a rotated order.
    const secondRanker = calls.find((call) => call.id === 'rank/a1')!.prompt
    expect(secondRanker.indexOf('Response B:')).toBeLessThan(secondRanker.indexOf('Response A:'))
    const chair = calls.find((call) => call.id === 'chair/a0')!.prompt
    expect(chair).toContain('You are the Chairman of an LLM Council')
    // Removing self-votes and normalizing each remaining pool leaves A clearly first.
    expect(chair).toContain('| 1 | Claude Opus 5 | Response A | 1.00 | 2 |')
    expect(chair).toContain('| 4 | Gemini 3.8 Flash | Response D | 4.00 | 3 |')
  })

  it('ranks only the answers that came back and says so', async () => {
    const { finalCheck: _check, ...council } = workflowTemplate('council')
    const { context } = fakeContext((call) => {
      if (call.id.startsWith('answer')) {
        return call.id === 'answer/a0' ? text('only answer') : new Error('down')
      }
      return text('chair')
    })
    const result = await runWorkflowGraphProgram(context, configFor(council), task)
    expect(result.gaps).toEqual([
      'First opinions: 3 agent calls of 4 did not return a result.',
      'Peer rankings: Nothing to rank: only 1 answer came back. The steps after it went on without a ranking.'
    ])
    const plan = planWorkflowGraph(
      configFor(council),
      task,
      new Map([
        ['answer/a0', { value: text('only answer') }],
        ['answer/a1', { failed: true }],
        ['answer/a2', { failed: true }],
        ['answer/a3', { failed: true }]
      ])
    )
    expect(plan.runs.rank[0]).toMatchObject({
      state: 'empty',
      reason: 'Nothing to rank: only 1 answer came back.'
    })
  })

  it('asks again for a ballot that leaves a response out', async () => {
    const { finalCheck: _check, ...council } = workflowTemplate('council')
    let attempts = 0
    const { context } = fakeContext((call) => {
      if (call.id.startsWith('answer')) {
        return text('a')
      }
      if (call.id === 'rank/a0') {
        attempts++
      }
      return call.id.startsWith('rank')
        ? text('FINAL RANKING:\n1. Response A\n2. Response B')
        : text('chair')
    })
    const result = await runWorkflowGraphProgram(context, configFor(council), task)
    // The fake port does not retry; a partial ballot fails validation. Every ranker failing
    // leaves the chairman to decide from the answers alone, and the run says so.
    expect(attempts).toBe(1)
    expect(result.final.markdown).toBe('chair')
    expect(result.gaps).toEqual([
      'Peer rankings failed: none of its 3 agent calls returned a result. The steps after it went on without it.'
    ])
  })

  it('replays byte-identical calls from recorded outcomes (no new launches)', async () => {
    const { context, calls } = fakeContext((call) =>
      call.id.startsWith('critics') ? text('fine\nVERDICT: PASS') : text(`answer ${call.id}`)
    )
    await runWorkflowGraphProgram(context, configFor(research), task)
    const outcomes = new Map<string, GraphOutcome>()
    for (const call of calls) {
      outcomes.set(call.id, {
        value: call.id.startsWith('critics')
          ? text('fine\nVERDICT: PASS')
          : text(`answer ${call.id}`)
      })
    }
    const replayed = planWorkflowGraph(configFor(research), task, outcomes)
    expect(replayed.ready).toEqual([])
    expect(replayed.calls.map((call) => [call.id, call.prompt])).toEqual(
      calls.map((call) => [call.id, call.prompt])
    )
    expect(replayed.outcome?.state).toBe('completed')
  })

  it('starts no check once the run is stopping', async () => {
    const spec = workflowTemplate('improve', ['claude', 'codex'])
    let stopping = false
    const checked: string[] = []
    const context = createWorkflowProgramContext({
      agent: async () => {
        stopping = true
        return text('v1')
      },
      phase: () => {},
      log: () => {},
      guard: () => {
        if (stopping) {
          throw new Fatal('Workflow stopped')
        }
      },
      isFatal: (error) => error instanceof Fatal
    })
    const config: GraphConfig = {
      ...configFor({ ...spec, repeat: { ...spec.repeat!, check: { command: 'npm test' } } }),
      checkCandidate: async (call) => {
        checked.push(call.id)
        return { value: { markdown: 'check', passed: true, detail: '' } }
      }
    }
    await expect(runWorkflowGraphProgram(context, config, task)).rejects.toThrow('Workflow stopped')
    expect(checked).toEqual([])
  })
})

describe('graph parsing', () => {
  it('reads verdicts through markdown and synonyms, last one wins', () => {
    expect(parseGraphVerdict('Looks good.\n**VERDICT: PASS**')).toBe('pass')
    expect(parseGraphVerdict('Verdict — approve.')).toBe('pass')
    expect(parseGraphVerdict('VERDICT: CHANGES REQUESTED')).toBe('fail')
    expect(parseGraphVerdict('verdict: refuted')).toBe('fail')
    expect(parseGraphVerdict('VERDICT: PASS\n...\nVERDICT: UNSURE')).toBe('unsure')
    expect(parseGraphVerdict('no verdict here')).toBeUndefined()
  })

  it('tallies by majority of configured votes; a missing vote never refutes', () => {
    expect(graphTally(['pass', 'pass', null])).toBe('confirmed')
    expect(graphTally(['fail', 'fail', 'pass'])).toBe('refuted')
    expect(graphTally(['fail', null, null])).toBe('unverified')
    expect(graphTally(['pass', 'unsure', 'fail'])).toBe('unverified')
  })

  it('scores a ballot with only one non-family answer at the neutral midpoint', () => {
    const standings = graphStandings(
      [
        { label: 'Response A', seatId: 'x' },
        { label: 'Response B', seatId: 'y' }
      ],
      [{ seatId: 'x', ranking: ['Response A', 'Response B'] }]
    )
    expect(standings).toEqual([
      { label: 'Response B', candidate: 1, averageRank: 1.5, votes: 1, place: 1 },
      { label: 'Response A', candidate: 0, averageRank: 0, votes: 0, place: 2 }
    ])
  })

  it('knows when no model judge may compare a pair of answers', () => {
    const answers = [
      { label: 'Response A', seatId: 'claude' },
      { label: 'Response B', seatId: 'codex' },
      { label: 'Response C', seatId: 'claude' }
    ]
    // Two families judging each other's work: A against B has no eligible judge.
    expect(graphJudgesCompareEveryPair(answers, ['claude', 'codex'])).toBe(false)
    // A third family compares everything; so does another family judging one model's work.
    expect(graphJudgesCompareEveryPair(answers, ['claude', 'codex', 'grok'])).toBe(true)
    const own = answers.map((answer) => ({ ...answer, seatId: 'claude' }))
    expect(graphJudgesCompareEveryPair(own, ['codex'])).toBe(true)
    expect(graphJudgesCompareEveryPair(own, ['claude'])).toBe(true)
  })
})

describe('graph supersede rule', () => {
  it('makes a failure final once a downstream step recorded a call', () => {
    expect(graphCallSuperseded(research, 'research/a2', ['research/a0'])).toBe(false)
    expect(graphCallSuperseded(research, 'research/a2', ['critics/a0'])).toBe(true)
    expect(graphCallSuperseded(research, 'critics/a1', ['final/a0'])).toBe(true)
  })

  it('orders a repeat by round, the Do step before its Review', () => {
    const spec = normalizeWorkflowSpec({
      steps: [
        { id: 'draft', kind: 'do', title: 'Draft' },
        { id: 'critic', kind: 'review', title: 'Critic', inputs: ['draft'] },
        { id: 'final', kind: 'synthesize', title: 'Final', inputs: ['draft', 'critic'] }
      ],
      repeat: { do: 'draft', review: 'critic', until: 'approved', maxRounds: 3 }
    })
    // A retry of round 2's draft is still allowed after round 1's review.
    expect(graphCallSuperseded(spec, 'draft/r2/a0', ['draft/r1/a0', 'critic/r1/a0'])).toBe(false)
    expect(graphCallSuperseded(spec, 'draft/r2/a0', ['critic/r2/a0'])).toBe(true)
    expect(graphCallSuperseded(spec, 'critic/r1/a0', ['draft/r2/a0'])).toBe(true)
    expect(graphCallSuperseded(spec, 'critic/r3/a0', ['final/a0'])).toBe(true)
  })
})
