import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  localWorkflowFindRequestSchema,
  localWorkflowFindSpec
} from '../../../../shared/local-workflow-find-request'
import type { DecisionRequest, DecisionResult } from '../../../../shared/structured-decisions'
import { DecisionProviderError } from '../../../../shared/structured-decisions'
import { jevScreen } from '../../../structured-decisions/jev-rank'
import { DECISION_SCENARIOS } from './graph-decision-test-scenarios'
import { createGraphJevScreener } from './graph-jev-screen'
import { GraphJevStore } from './graph-jev-store'
import type { GraphCall } from './graph-plan-types'
import { admittedDecisionRules, drive, text } from './graph-test-harness'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const findSpec = (count: number, top: number) =>
  localWorkflowFindSpec(
    localWorkflowFindRequestSchema.parse({
      prompt: 'Choose',
      items: Array.from({ length: count }, (_, index) => `Option ${index + 1}`),
      top
    }),
    ['claude', 'codex', 'grok'],
    []
  )

/** Each option scores by its place in the pool; `missing` are left unscored, with a reason. */
const screenLeaving =
  (missing: readonly number[], reason?: string) =>
  (call: GraphCall): unknown => {
    const ids = call.screen!.candidates.map((candidate) => candidate.id)
    const left = ids.filter((_, index) => missing.includes(index))
    return {
      markdown: 'screened',
      scores: Object.fromEntries(
        ids.flatMap((id, index) => (missing.includes(index) ? [] : [[id, 4 - index * 0.1]]))
      ),
      criteria: [],
      unscored: left,
      ...(reason ? { unscoredReasons: Object.fromEntries(left.map((id) => [id, reason])) } : {})
    }
  }

const ranking = (labels: readonly string[]) =>
  text(`FINAL RANKING:\n${labels.map((label, place) => `${place + 1}. ${label}`).join('\n')}`)

const firstShown = (call: GraphCall) => ranking(call.jev!.candidates.map((entry) => entry.label))

const byLine = DECISION_SCENARIOS.find(
  (scenario) => scenario.name === 'Find the best, your list and rubric lines'
)!

describe('find-screen@2: an option JEV could not score is never read as low', () => {
  it('sends it to the final unscored and names it, where @1 left it out', () => {
    const plan = drive(byLine.spec, byLine.answer, admittedDecisionRules(byLine.spec))
    const find = plan.find!
    expect(find.overall.map((pick) => pick.key)).toEqual([
      'list.3',
      'list.4',
      'list.5',
      'list.11',
      'list.12',
      'list.2'
    ])
    expect(find.notScored).toEqual([
      { key: 'list.2', title: 'Option 2', reason: 'JEV gave no score', finalist: true }
    ])
    const final = plan.calls.find((call) => call.id === 'judge/jev')!
    expect(final.jev!.candidates.map((entry) => entry.markdown)).toContain('Option 2')
    expect(find.rows!.find((row) => row.key === 'list.2')).toMatchObject({
      finalist: true,
      notScored: 'JEV gave no score'
    })
    expect(find.rows!.find((row) => row.key === 'list.2')).not.toHaveProperty('score')
    expect(plan.outcome!.gaps).toContain(
      "JEV could not score 1 option, so none was read as low: Option 2 (JEV gave no score). It went to the final unscored, so only the final's judges placed it."
    )
    expect(plan.outcome!.final!.markdown).toContain('**Option 2** (not scored by JEV)')
  })

  it('keeps @1 on a run frozen before decision rules, and on one frozen with @1', () => {
    const legacy = drive(byLine.spec, byLine.answer)
    const rules = admittedDecisionRules(byLine.spec)
    const pinned = drive(byLine.spec, byLine.answer, {
      ...rules,
      contracts: { ...rules.contracts, 'judge/screen': 'find-screen@1' }
    })
    for (const plan of [legacy, pinned]) {
      expect(plan.find!.overall.map((pick) => pick.key)).not.toContain('list.2')
      expect(plan.find).not.toHaveProperty('notScored')
      expect(plan.find!.rows!.at(-1)).toMatchObject({ key: 'list.2' })
      expect(plan.find!.rows!.at(-1)).not.toHaveProperty('notScored')
      expect(plan.outcome!.gaps).toContain('JEV could not score 1 option; it was left out.')
    }
    expect(pinned.calls.find((call) => call.screen)!.screen!.contract).toBe('find-screen@1')
  })

  it("names JEV's reason, and the ones the final had no room for, as a gap", () => {
    const spec = findSpec(12, 6)
    const answer = (call: GraphCall) =>
      call.screen
        ? screenLeaving([1, 2, 3], 'JEV answered invalid_response')(call)
        : firstShown(call)
    const plan = drive(spec, answer, admittedDecisionRules(spec))
    // Six scored finalists leave room for two of the three unscored in a final of eight.
    expect(plan.find!.overall).toHaveLength(8)
    expect(plan.find!.notScored).toEqual([
      { key: 'list.2', title: 'Option 2', reason: 'JEV answered invalid_response', finalist: true },
      { key: 'list.3', title: 'Option 3', reason: 'JEV answered invalid_response', finalist: true },
      { key: 'list.4', title: 'Option 4', reason: 'JEV answered invalid_response' }
    ])
    expect(plan.outcome!.gaps).toContain(
      "JEV could not score 3 options, so none was read as low: Option 2 (JEV answered invalid_response); Option 3 (JEV answered invalid_response); Option 4 (JEV answered invalid_response). 2 went to the final unscored, so only the final's judges placed them. The final had no room for 1 more option, so no judge compared it: Option 4."
    )
    expect(plan.find!.rows!.find((row) => row.key === 'list.4')).toMatchObject({
      notScored: 'JEV answered invalid_response'
    })
  })

  it('merges the reasons of every page', () => {
    const spec = findSpec(150, 3)
    const answer = (call: GraphCall) =>
      call.screen ? screenLeaving([0], `no score on ${call.id}`)(call) : firstShown(call)
    const plan = drive(spec, answer, admittedDecisionRules(spec))
    expect(plan.calls.filter((call) => call.screen).map((call) => call.id)).toEqual([
      'judge/screen/page.1',
      'judge/screen/page.2'
    ])
    expect(plan.find!.notScored).toEqual([
      {
        key: 'list.1',
        title: 'Option 1',
        reason: 'no score on judge/screen/page.1',
        finalist: true
      },
      {
        key: 'list.101',
        title: 'Option 101',
        reason: 'no score on judge/screen/page.2',
        finalist: true
      }
    ])
  })

  it('breaks a tie with an unscored finalist by the pool order, never by a missing score', () => {
    // JEV fails the final; two model judges put a scored and the unscored option first.
    const answer = (call: GraphCall): unknown => {
      if (call.screen) {
        return byLine.answer(call)
      }
      if (call.jev || call.agentIndex > 1) {
        return undefined
      }
      const labels = ['A', 'B', 'C', 'D', 'E', 'F'].map((letter) => `Response ${letter}`)
      const [a, f] = [labels[0]!, labels[5]!]
      const rest = labels.slice(1, 5)
      return ranking(call.agentIndex === 0 ? [a, f, ...rest] : [f, a, ...rest])
    }
    const plan = drive(byLine.spec, answer, admittedDecisionRules(byLine.spec))
    const standings = plan.runs.judge[0]!.standings!.filter((row) => row.place === 1)
    expect(standings.map((row) => row.label).sort()).toEqual(['Response A', 'Response F'])
    // Response A is list.3, the best screen score; Response F is list.2, unscored and first in the pool.
    expect(plan.find!.winner!.key).toBe('list.2')
    expect(plan.find!.decidedBy).toEqual(['models'])
  })
})

describe('the screen keeps why JEV could not score an option', () => {
  const request = {
    task: 'Choose',
    rubric: '',
    candidates: ['a', 'b'].map((id) => ({ id, text: id }))
  }

  it('records the reasons only for a run under decision rules', async () => {
    const screen = async () => ({
      model: 'jev-1.13.0',
      scores: { a: 3 },
      criteria: [],
      unscored: ['b'],
      retryableUnscored: [],
      unscoredReasons: { b: 'JEV answered invalid_response' },
      calls: 2
    })
    const read = async (contract?: 'find-screen@2') => {
      const dir = mkdtempSync(join(tmpdir(), 'find-unscored-'))
      dirs.push(dir)
      const store = new GraphJevStore(join(dir, 'jev-ballots.json'))
      const call = {
        id: 'judge/screen',
        screen: { ...request, ...(contract ? { contract } : {}) }
      } as GraphCall
      return (await createGraphJevScreener({ store, screen })(call)) as {
        value: Record<string, unknown>
      }
    }
    expect((await read()).value).not.toHaveProperty('unscoredReasons')
    expect((await read('find-screen@2')).value.unscoredReasons).toEqual({
      b: 'JEV answered invalid_response'
    })
  })

  it("names each option's own failure", async () => {
    const evaluate = async (decision: DecisionRequest): Promise<DecisionResult> => {
      if ((decision.state as { response: string }).response === 'b') {
        throw new DecisionProviderError('invalid_response')
      }
      return {
        provider: 'typesafe',
        model: 'jev-1.13.0',
        answers: Object.fromEntries(
          Object.keys(decision.questions).map((id) => [
            id,
            { type: 'score' as const, score: 3, legend: {}, probabilities: {}, confidence: 1 }
          ])
        ),
        usage: { inputTokens: 1, outputTokens: 0 }
      }
    }
    const options = { evaluate, credential: async () => 'k'.repeat(24), environment: {} }
    expect(await jevScreen(request, options)).toMatchObject({
      unscored: ['b'],
      unscoredReasons: { b: 'JEV answered invalid_response' }
    })
    const scored = await jevScreen({ ...request, candidates: [request.candidates[0]!] }, options)
    expect(scored).not.toHaveProperty('unscoredReasons')
  })
})
