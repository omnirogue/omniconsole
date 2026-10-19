import { describe, expect, it } from 'vitest'
import { compileWorkPlan, compileWorkPlanExecution } from './work-plan-compile'
import { samWorkPlan } from './__fixtures__/work-plan/wp2/sal-work-plan'
import { councilWorkPlan } from './__fixtures__/work-plan/wp2/council-work-plan'
import {
  workPlanFixtureContext,
  WORK_PLAN_FIXTURE_ACTORS
} from './__fixtures__/work-plan/work-plan-context'
import {
  sessionOutcomeSeatCount,
  sessionOutcomeStageCount,
  validateSessionOutcomeDefinitions
} from './session-outcome-validation'
import { reviewRoundContractProblems } from './session-chain-review-contract'
import { modelLineage } from './model-lineage'
import { workPlanFromShape, WORK_PLAN_SHAPES, shapeAvailable } from './work-plan-shapes'
import { workPlanProblems } from './work-plan-validate'
import { workPlanNotation, workPlanSummary } from './work-plan-notation'
import { workPlanFromChain } from './work-plan-read'
import type { WorkPlan } from './work-plan-types'
import { goldenChain } from './__fixtures__/work-plan/wp2/compiled-chain'

const ctx = workPlanFixtureContext()
const compile = (plan: WorkPlan) =>
  compileWorkPlanExecution(plan, { ...ctx, chainId: 'golden', workspacePath: '/workspace' })
describe('WP-2 one-outcome lowering', () => {
  it('compiles Sal to ten seats and six stages using the shipped counting contract', () => {
    const plan = samWorkPlan()
    const result = compile(plan)
    expect(result.problems).toEqual([])
    expect(result.draft.recipients).toEqual([])
    expect(result.outcomes).toHaveLength(1)
    const outcome = result.outcomes[0]!
    expect(result.steps).toHaveLength(10)
    expect(sessionOutcomeSeatCount(outcome, result.steps)).toBe(10)
    expect(sessionOutcomeStageCount(outcome, result.steps)).toBe(6)
    expect(outcome.stepIds).toEqual(result.steps.map((s) => s.id))
    const judge = result.steps.find((s) => s.planNodeId === 'plan-judge')!
    const candidates = result.steps.filter((s) => s.planNodeId === 'plan')
    expect(
      candidates.every(
        (s) => modelLineage(s.agent, s.model) !== modelLineage(judge.agent, judge.model)
      )
    ).toBe(true)
    expect(judge.verdict?.over).toEqual(candidates.map((s) => s.id))
    expect(result.steps.find((s) => s.planNodeId === 'improve')?.readsWinnerOf).toBe(judge.id)
    const verify = result.steps.find((s) => s.planNodeId === 'verify')!
    expect(verify.verdict?.over).toEqual(plan.outcome.doneWhen.map((d) => d.id))
    expect(outcome.conditions.find((c) => c.id === 'dw-review')).toMatchObject({
      kind: 'report',
      target: verify.id
    })
    expect(outcome.conditions.find((c) => c.id === 'dw-page')).toMatchObject({
      kind: 'file',
      target: 'index.html'
    })
    expect(outcome.conditions.some((c) => c.target.endsWith('manifest.md'))).toBe(false)
    expect(outcome.actions).toEqual([])
    expect(workPlanNotation(plan)).toBe('⑂3 Research → ◇ → ⑂3 📝 → ⚖ → ✨ → ✓ → 👤')
    expect(workPlanSummary(plan, 2)).toEqual({
      executions: 10,
      stages: 6,
      maxConcurrency: 2,
      queued: 1,
      newSessions: 10,
      continued: 0
    })
  })

  it('compiles Council as answers, peer critiques, judge and winner, never review rounds', () => {
    const plan = councilWorkPlan()
    const result = compile(plan)
    expect(result.problems).toEqual([])
    expect(result.steps).toHaveLength(9)
    expect(sessionOutcomeSeatCount(result.outcomes[0]!, result.steps)).toBe(9)
    expect(sessionOutcomeStageCount(result.outcomes[0]!, result.steps)).toBe(5)
    expect(result.steps.every((s) => !s.review)).toBe(true)
    for (const critique of result.steps.filter((s) => s.presetId === 'critique')) {
      expect(critique.readsFrom).toHaveLength(2)
      expect(critique.verdict).toMatchObject({ consumed: 'record', over: critique.readsFrom })
    }
    expect(workPlanNotation(plan)).toBe('⑂3 Implement → ⑂3 Critique → ⚖ → ◇ → ✓ → 👤')
  })

  it('maps human, command and plan-file Done When without a finish writer', () => {
    const plan = samWorkPlan()
    plan.outcome.doneWhen.push(
      { id: 'approve', text: 'I accept the result', evidence: 'human' },
      {
        id: 'check',
        text: 'The check passes',
        evidence: 'command',
        command: { program: 'node', args: ['check.js'], expectedStdout: 'PASS' }
      }
    )
    const result = compile(plan)
    expect(result.problems).toEqual([])
    expect(result.outcomes[0]!.conditions.find((c) => c.id === 'check')?.verification).toEqual(
      plan.outcome.doneWhen.at(-1)!.command
    )
    expect(result.outcomes[0]!.conditions.find((c) => c.id === 'approve')?.kind).toBe('review')
    expect(
      compileWorkPlan(plan, { ...ctx, commitSource: 'ai' }).problems.some(
        (p) => p.code === 'outcome-command-not-user'
      )
    ).toBe(true)
    const planned = workPlanFromShape('solo', {
      prompt: '(plan) build a page',
      outcome: { title: 'Page', doneWhen: [], outputKind: 'work' },
      planMode: true,
      ctx
    })
    const compiled = compile(planned)
    expect(compiled.problems).toEqual([])
    expect(compiled.outcomes[0]).toMatchObject({
      outputKind: 'plan',
      finish: 'complete',
      conditions: [
        {
          kind: 'file',
          target: 'plan.json',
          fileVersions: [{ path: 'plan.json', schema: 'work-plan-v1' }]
        }
      ]
    })
  })

  it('refuses missing Verify and names the node that exceeds the brief budget', () => {
    const plan = samWorkPlan()
    const result = compileWorkPlanExecution(plan, { ...ctx, reportExcerptChars: 40_000 })
    expect(
      result.problems.some((p) => p.code === 'brief-over-cap' && p.nodeId === 'synthesis')
    ).toBe(true)
    plan.nodes = plan.nodes.filter((n) => n.id !== 'verify')
    expect(compile(plan).problems.some((p) => p.message.includes('needs a Verify worker'))).toBe(
      true
    )
  })

  it('round trips plan to persisted notation and authoring notation, including taskRef', () => {
    const chain = goldenChain()
    Object.assign(chain.outcomeSet!.outcomes[0]!, { taskRef: { taskId: 'btk_9fA2' } })
    const read = workPlanFromChain(chain)
    expect(read.outcome.taskRef).toBe('btk_9fA2')
    expect(workPlanNotation(chain)).toBe(workPlanNotation(samWorkPlan()))
    expect(workPlanNotation(read)).toBe(workPlanNotation(chain))
  })
})

describe('executable shapes', () => {
  const three = workPlanFixtureContext({ usableAgents: ctx.usableAgents.slice(0, 3) })
  it.each(WORK_PLAN_SHAPES.filter((shape) => shapeAvailable(shape, ctx).ok))(
    '%s validates and compiles on three families',
    (shape) => {
      const plan = workPlanFromShape(shape, {
        prompt: 'Make the page',
        outcome: {
          title: 'Page',
          doneWhen: [{ id: 'file', text: 'Page exists', evidence: 'file', path: 'index.html' }],
          outputKind: 'work'
        },
        planMode: false,
        ctx: three
      })
      expect(workPlanProblems(plan, three).filter((p) => p.severity === 'block')).toEqual([])
      const result = compile(plan)
      expect(result.problems).toEqual([])
      expect(() =>
        validateSessionOutcomeDefinitions(result.outcomes, { steps: result.steps })
      ).not.toThrow()
      expect(
        result.steps.flatMap((step) => reviewRoundContractProblems({ steps: result.steps }, step))
      ).toEqual([])
    }
  )
  it('does not offer a judge without an independent permitted family', () => {
    expect(
      shapeAvailable(
        'bestOfN',
        workPlanFixtureContext({ usableAgents: ctx.usableAgents.slice(0, 1) })
      ).ok
    ).toBe(false)
    expect(
      shapeAvailable(
        'reviewLoop',
        workPlanFixtureContext({ usableAgents: [ctx.usableAgents.at(-1)!] })
      ).ok
    ).toBe(false)
    expect(WORK_PLAN_FIXTURE_ACTORS.gemini.agent).toBe('gemini')
  })
})

it('round trips the controlled sentence and notation for both fixtures', async () => {
  const { workPlanSentence, workPlanNotationFromSentence } = await import('./work-plan-sentence.js')
  for (const plan of [samWorkPlan(), councilWorkPlan()]) {
    expect(workPlanNotationFromSentence(workPlanSentence(plan))).toBe(workPlanNotation(plan))
  }
})

it('folds repeated review rounds using the merged seat/stage rule and feeds repairs forward', () => {
  const plan = workPlanFromShape('reviewLoop', {
    prompt: 'Build',
    outcome: {
      title: 'Page',
      outputKind: 'work',
      doneWhen: [{ id: 'file', text: 'Page exists', evidence: 'file', path: 'page.html' }]
    },
    planMode: false,
    ctx
  })
  const result = compile(plan)
  expect(result.problems).toEqual([])
  expect(result.steps).toHaveLength(4)
  expect(sessionOutcomeSeatCount(result.outcomes[0]!, result.steps)).toBe(3)
  expect(sessionOutcomeStageCount(result.outcomes[0]!, result.steps)).toBe(3)
  const repair = result.steps.find((s) => s.reviewRepair)!
  const roundTwo = result.steps.find((s) => s.review?.round === 2)!
  expect(roundTwo.readsFrom).toContain(repair.id)
  expect(repair.readsFrom).toContain(result.steps.find((s) => s.review?.round === 1)!.id)
})

it('lets the review round, not each seat, gate a review node', () => {
  const plan = workPlanFromShape('reviewLoop', {
    prompt: 'Plan it',
    outcome: {
      title: 'Plan',
      outputKind: 'plan',
      doneWhen: [{ id: 'file', text: 'Plan exists', evidence: 'file', path: 'plan.md' }]
    },
    planMode: false,
    ctx
  })
  const seats = compile(plan).steps.filter((s) => s.review)
  expect(seats.length).toBeGreaterThan(0)
  for (const seat of seats) {
    // A per-seat gate would name the reviewed step as a done-when entry and be refused.
    expect(seat.verdict?.consumed).toBe('record')
    expect(seat.review?.gate).toBe(true)
  }
})

it('reads a gated review back as a gate, so a recompiled plan keeps it', () => {
  const plan = workPlanFromShape('reviewLoop', {
    prompt: 'Plan it',
    outcome: {
      title: 'Plan',
      outputKind: 'plan',
      doneWhen: [{ id: 'file', text: 'Plan exists', evidence: 'file', path: 'plan.md' }]
    },
    planMode: false,
    ctx
  })
  const read = workPlanFromChain(goldenChain(plan))
  expect(read.nodes.find((node) => node.kind === 'review')?.verdict?.consumed).toBe('gate')
  const recompiled = compile(read).steps.filter((step) => step.review)
  expect(recompiled.every((seat) => seat.review?.gate === true)).toBe(true)
})

it('counts continued sessions and estimates source and winner context', () => {
  const plan = samWorkPlan()
  const improve = plan.nodes.find((n) => n.id === 'improve')!
  improve.route = 'same-session'
  expect(workPlanSummary(plan, 3).continued).toBe(1)
  expect(workPlanSummary(plan, 3).newSessions).toBe(9)
  expect(
    compileWorkPlan(plan, {
      ...ctx,
      capabilities: { sameConversationRoute: true },
      sourceContextChars: 100_000
    }).problems.some((p) => p.code === 'brief-over-cap')
  ).toBe(true)
})

it.each(WORK_PLAN_SHAPES.filter((shape) => shapeAvailable(shape, ctx).ok))(
  '%s is also executable in Plan Mode',
  (shape) => {
    const three = workPlanFixtureContext({ usableAgents: ctx.usableAgents.slice(0, 3) })
    const plan = workPlanFromShape(shape, {
      prompt: 'Plan the page',
      outcome: { title: 'Page plan', doneWhen: [], outputKind: 'work' },
      planMode: true,
      ctx: three
    })
    expect(plan.outcome.outputKind).toBe('plan')
    expect(compileWorkPlanExecution(plan, three).problems).toEqual([])
    expect(workPlanNotation(goldenChain(plan))).toBe(workPlanNotation(plan))
  }
)

it('finish-only edits preserve Done When conditions and outcome identity', async () => {
  const { sessionOutcomeIdentity } = await import('./session-outcome-identity.js')
  const plan = samWorkPlan()
  const before = compile(plan)
  plan.nodes[plan.nodes.length - 1] = { kind: 'finish', id: 'finish', how: 'complete' }
  const after = compile(plan)
  expect(after.problems).toEqual([])
  expect(after.outcomes[0]!.conditions).toEqual(before.outcomes[0]!.conditions)
  expect(after.outcomes[0]!.conditions).toHaveLength(plan.outcome.doneWhen.length)
  expect(sessionOutcomeIdentity(after.outcomes[0]!)).toEqual(
    sessionOutcomeIdentity(before.outcomes[0]!)
  )
  expect(after.draft.end).toBe('done')
  expect(before.draft.end).toBe('me')
})

it('report evidence requires a verify gate, never a record or review receipt', async () => {
  const { workPlanDoneWhenConditions } = await import('./work-plan-conditions.js')
  const plan = samWorkPlan()
  const result = compile(plan)
  const verify = result.steps.find((s) => s.presetId === 'verify')!
  verify.verdict!.consumed = 'record'
  expect(() => workPlanDoneWhenConditions(plan, result.steps, 'golden')).toThrow(
    'needs a Verify worker'
  )
  verify.verdict!.consumed = 'gate'
  verify.presetId = 'review'
  expect(() => workPlanDoneWhenConditions(plan, result.steps, 'golden')).toThrow(
    'needs a Verify worker'
  )
})
