import { describe, expect, it } from 'vitest'
import type { WorkflowCheck, WorkflowSpec } from '../../../../shared/workflow-graph'
import { planWorkflowCalls } from '../../../../shared/workflow-graph-topology'
import { graphFinalCheckCallId } from './graph-improve-final'
import { IMPROVE_RULES } from './graph-improve-rules'
import { planWorkflowGraph, type GraphCall, type GraphConfig } from './graph-plan'
import { configFor, drive, task, text } from './graph-test-harness'

const SECRET = ['kept-back-alpha', 'kept-back-beta', 'kept-back-gamma', 'kept-back-delta']
const CODE: WorkflowCheck = {
  command: 'npm test -- {case}',
  cases: ['practice-one', 'practice-two'],
  apply: 'patch',
  sealed: { command: 'npm run final-secret -- {case}', cases: SECRET }
}
const TEXT: WorkflowCheck = {
  command: 'node grade.mjs {case}',
  cases: ['practice-one'],
  sealed: { cases: SECRET.slice(0, 3) }
}

function improve(check: WorkflowCheck, agents = 1): WorkflowSpec {
  return {
    version: 1,
    title: 'Improve',
    template: 'improve',
    steps: [
      {
        id: 'improve',
        kind: 'do',
        title: 'Improve',
        instruction: '',
        agents: Array.from({ length: agents }, () => ({ route: 'claude' as const })),
        inputs: []
      },
      {
        id: 'judge',
        kind: 'rank',
        title: 'Judge',
        instruction: '',
        agents: [{ route: 'codex' }],
        inputs: ['improve'],
        jev: { method: 'auto', only: true }
      }
    ],
    repeat: {
      do: 'improve',
      review: 'judge',
      until: 'plateau',
      maxRounds: 3,
      patience: 1,
      explore: 'low',
      check
    }
  }
}

const RULES_2: Partial<GraphConfig> = {
  access: 'workspace-read',
  improveUnresolvedRounds: true,
  improveRules: IMPROVE_RULES
}
const BEST = graphFinalCheckCallId('improve', 'best')
const START = graphFinalCheckCallId('improve', 'start')

/** Round 1's change passes practice where the code fails; the final test gives each side `final`. */
function answer(final: { best?: number; start?: number }, cases = 4) {
  return (call: GraphCall): unknown => {
    if (call.check?.sealed) {
      const passed = call.id === BEST ? final.best : final.start
      return passed === undefined
        ? undefined
        : {
            markdown: 'final',
            passed: passed === cases,
            detail: `${passed} of ${cases} kept-back cases passed.`,
            cases: { total: cases, passed, unavailable: 0 }
          }
    }
    if (call.check) {
      const passed = !call.check.unchanged && /PASS/.test(call.check.candidate)
      return {
        markdown: 'check',
        passed,
        detail: 'ok',
        cases: { total: 2, passed: passed ? 2 : 0, unavailable: 0 }
      }
    }
    if (call.jev || call.stepId === 'judge') {
      return undefined
    }
    return text(
      call.round === 1
        ? 'Round 1: PASS\n```diff\n-a\n+b\n```'
        : `Round ${call.round}: FAIL\n\`\`\`diff\n-a\n+c\n\`\`\``
    )
  }
}

const story = (plan: ReturnType<typeof drive>) =>
  plan.outcome!.final!.markdown.split('\n\n---\n\n')[1]!

describe('Improve rules 2: the final test, kept back', () => {
  it('runs after the last round on the winner and on "No change", in fresh copies', () => {
    const plan = drive(improve(CODE), answer({ best: 4, start: 2 }), RULES_2)
    const ids = plan.calls.map((call) => call.id)
    const lastRound = Math.max(
      ...plan.calls.filter((call) => !call.check?.sealed).map((c) => ids.indexOf(c.id))
    )
    expect(ids.indexOf(BEST)).toBeGreaterThan(lastRound)
    expect(ids.indexOf(START)).toBeGreaterThan(lastRound)
    const [best, start] = [BEST, START].map((id) => plan.calls.find((call) => call.id === id)!)
    expect(best!.check).toMatchObject({
      command: 'npm run final-secret -- {case}',
      cases: SECRET,
      apply: 'patch',
      sealed: true,
      candidate: 'Round 1: PASS\n```diff\n-a\n+b\n```'
    })
    expect(best!.check!.unchanged).toBeUndefined()
    expect(start!.check).toMatchObject({ unchanged: true, sealed: true, cases: SECRET })
    expect(plan.loop?.improve?.final).toEqual({
      verdict: 'held',
      cases: 4,
      start: 'unchanged',
      best: { passed: 4 },
      started: { passed: 2 }
    })
    expect(story(plan).split('\n')[0]).toBe(
      '**Final test (4 cases kept back): the new version passed 4, what you started with passed 2. The improvement held.**'
    )
    expect(plan.outcome?.gaps.join('\n')).not.toMatch(/Final test/)
    expect(plan.outcome?.final?.markdown).toMatch(/^Round 1: PASS/)
  })

  it('says a tie may not carry over, and names it as a gap', () => {
    const plan = drive(improve(CODE), answer({ best: 3, start: 3 }), RULES_2)
    const line =
      'Final test (4 cases kept back): both passed 3. It did no better on cases it never saw, so the gain may not carry over.'
    expect(story(plan).split('\n')[0]).toBe(`**${line}**`)
    expect(plan.outcome?.gaps).toContain(line)
    expect(plan.loop?.improve?.final?.verdict).toBe('tied')
  })

  it('still publishes the winner when it does worse, and says to keep what you have', () => {
    const plan = drive(improve(CODE), answer({ best: 2, start: 3 }), RULES_2)
    const line =
      'Final test (4 cases kept back): the new version passed 2, what you started with passed 3. Keep what you have.'
    expect(story(plan).split('\n')[0]).toBe(`**${line}**`)
    expect(plan.outcome?.gaps).toContain(line)
    expect(plan.outcome?.state).toBe('completed')
    expect(plan.outcome?.final?.markdown).toMatch(/^Round 1: PASS/)
  })

  it('never calls a final test that could not run held, nor counts it as a version', () => {
    const plan = drive(improve(CODE), answer({ best: 4 }), RULES_2)
    expect(plan.loop?.improve?.final?.verdict).toBe('unavailable')
    const gaps = plan.outcome!.gaps.join('\n')
    expect(gaps).toContain('Final test (4 cases kept back): it could not run in full')
    expect(gaps).not.toMatch(/The check could not run on/)
    expect(story(plan)).not.toMatch(/held/)
  })

  it('publishes nothing while the final test runs', () => {
    const config = { ...configFor(improve(CODE)), ...RULES_2 }
    const outcomes = new Map()
    let plan = planWorkflowGraph(config, task, outcomes)
    const reply = answer({ best: 4, start: 2 })
    for (let pass = 0; pass < 20 && !plan.ready.some((call) => call.check?.sealed); pass++) {
      for (const call of plan.ready) {
        const value = reply(call)
        outcomes.set(call.id, value === undefined ? { failed: true } : { value })
      }
      plan = planWorkflowGraph(config, task, outcomes)
    }
    expect(plan.ready.map((call) => call.id).sort()).toEqual([BEST, START].sort())
    expect(plan.loop?.status).toBe('running')
    expect(plan.loop?.improve?.stop).toBe('plateau')
    expect(plan.loop?.improve?.final).toEqual({ cases: 4, start: 'unchanged' })
    expect(plan.outcome).toBeUndefined()
  })

  it("compares text with round 1's best version, named as such", () => {
    const plan = drive(
      improve(TEXT),
      (call) => {
        if (call.check?.sealed) {
          const passed = call.id === BEST ? 3 : 1
          return {
            markdown: 'f',
            passed: passed === 3,
            detail: '',
            cases: { total: 3, passed, unavailable: 0 }
          }
        }
        if (call.check) {
          const passed = /PASS/.test(call.check.candidate) ? 1 : 0
          return {
            markdown: 'c',
            passed: !!passed,
            detail: '',
            cases: { total: 1, passed, unavailable: 0 }
          }
        }
        return call.jev || call.stepId === 'judge'
          ? undefined
          : text(call.round === 2 ? 'Round 2: PASS' : `Round ${call.round}: FAIL`)
      },
      RULES_2
    )
    const start = plan.calls.find((call) => call.id === START)!
    expect(start.check).toMatchObject({ candidate: 'Round 1: FAIL', cases: SECRET.slice(0, 3) })
    expect(start.check!.unchanged).toBeUndefined()
    expect(start.check!.command).toBe('node grade.mjs {case}')
    expect(story(plan).split('\n')[0]).toBe(
      "**Final test (3 cases kept back): the new version passed 3, round 1's best version passed 1. The improvement held.**"
    )
  })

  it('needs no final test when nothing beat the code as it is', () => {
    const noChange = drive(
      improve(CODE),
      (call) =>
        call.check && !call.check.sealed
          ? {
              markdown: 'c',
              passed: false,
              detail: '',
              cases: { total: 2, passed: 0, unavailable: 0 }
            }
          : answer({})(call),
      RULES_2
    )
    expect(noChange.calls.some((call) => call.check?.sealed)).toBe(false)
    expect(noChange.loop?.improve?.final?.verdict).toBe('same')
    expect(story(noChange).split('\n')[0]).toBe(
      '**Final test (4 cases kept back): not needed, since the result is your code as it is.**'
    )
    expect(noChange.outcome?.gaps.join('\n')).not.toMatch(/Final test/)
  })

  it('never puts a kept-back case or command into any prompt, brief, judge or feedback', () => {
    const secrets = [...SECRET, 'final-secret']
    for (const check of [CODE, TEXT]) {
      // Every round runs, and ties on the check go to the judges, whose notes feed the next round.
      const spec = improve(check, 3)
      spec.repeat = { ...spec.repeat!, patience: 3 }
      const plan = drive(
        spec,
        (call) => {
          if (call.check) {
            return { markdown: 'c', passed: false, detail: 'failed', score: call.agentIndex }
          }
          if (call.jev) {
            return { markdown: 'FINAL RANKING:\n1. Response B\n2. Response A', unsure: true }
          }
          return call.stepId === 'judge'
            ? text('FINAL RANKING:\n1. Response B\n2. Response A')
            : text(
                `Round ${call.round} version ${call.agentIndex}\n\`\`\`diff\n-a\n+b${call.round}-${call.agentIndex}\n\`\`\``
              )
        },
        RULES_2
      )
      expect(plan.calls.filter((call) => call.check?.sealed)).toHaveLength(2)
      expect(
        plan.calls.some((call) => call.prompt.includes('What the judges said last round'))
      ).toBe(true)
      for (const call of plan.calls) {
        const seen = JSON.stringify([
          call.prompt,
          call.jev ?? null,
          call.check?.sealed ? null : (call.check ?? null)
        ])
        for (const secret of secrets) {
          expect(seen).not.toContain(secret)
        }
      }
    }
  })

  it('runs only under rules 2, and counts its two host calls only when set', () => {
    const older = drive(improve(CODE), answer({ best: 4, start: 2 }), {
      access: 'workspace-read',
      improveUnresolvedRounds: true,
      improveRules: 1
    })
    expect(older.calls.some((call) => call.check?.sealed)).toBe(false)
    expect(older.loop?.improve?.final).toBeUndefined()
    const { sealed: _sealed, ...plain } = CODE
    expect(planWorkflowCalls(improve(CODE)).hostTotal).toBe(
      planWorkflowCalls(improve(plain)).hostTotal + 2
    )
  })
})
