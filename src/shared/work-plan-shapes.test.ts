import { sessionOutcomeSeatCount, sessionOutcomeStageCount } from './session-outcome-validation'
import { expect, it } from 'vitest'
import {
  WORK_PLAN_SHAPES,
  shapeAvailable,
  workPlanDraftFromShape,
  workPlanFromShape
} from './work-plan-shapes'
import { workPlanFixtureContext } from './__fixtures__/work-plan/work-plan-context'
import { workPlanProblems } from './work-plan-validate'
import { compileWorkPlanExecution } from './work-plan-compile'
import { goldenChain } from './__fixtures__/work-plan/wp2/compiled-chain'
import { workPlanNotation } from './work-plan-notation'

const ctx = workPlanFixtureContext()
ctx.usableAgents = ctx.usableAgents.slice(0, 3)
it('freezes the nine WP-8 shape names', () => {
  expect(WORK_PLAN_SHAPES).toEqual([
    'solo',
    'parallel',
    'sequential',
    'council',
    'bestOfN',
    'synthesis',
    'reviewLoop',
    'savedWorkflow',
    'custom'
  ])
})
it.each(WORK_PLAN_SHAPES)('%s validates on three families or explains its owner', (shape) => {
  const input = {
    prompt: 'Build a page',
    outcome: {
      title: 'Page',
      outputKind: 'work' as const,
      doneWhen: [{ id: 'page', text: 'Page exists', evidence: 'file' as const, path: 'page.html' }]
    },
    planMode: false,
    ctx
  }
  if (shape === 'savedWorkflow' || shape === 'custom') {
    expect(shapeAvailable(shape, ctx)).toEqual({ ok: false, reason: expect.any(String) })
    expect(() => workPlanFromShape(shape, input)).toThrow()
    return
  }
  const plan = workPlanFromShape(shape, input)
  expect(workPlanProblems(plan, ctx).filter((p) => p.severity === 'block')).toEqual([])
  const result = compileWorkPlanExecution(plan, ctx)
  expect(result.problems).toEqual([])
  const counts = {
    solo: [1, 1, 1],
    parallel: [3, 3, 1],
    sequential: [3, 3, 3],
    council: [8, 8, 4],
    bestOfN: [5, 5, 3],
    synthesis: [4, 4, 2],
    reviewLoop: [4, 3, 3]
  }
  expect([
    result.steps.length,
    sessionOutcomeSeatCount(result.outcomes[0]!, result.steps),
    sessionOutcomeStageCount(result.outcomes[0]!, result.steps)
  ]).toEqual(counts[shape])
  expect(workPlanNotation(goldenChain(plan))).toBe(workPlanNotation(plan))
})

it('a complete review loop has only declared file conditions, never reviewer receipts', () => {
  const plan = workPlanFromShape('reviewLoop', {
    prompt: 'Build a page',
    planMode: false,
    ctx,
    outcome: {
      title: 'Page',
      outputKind: 'work',
      doneWhen: [{ id: 'page', text: 'Page exists', evidence: 'file', path: 'page.html' }]
    }
  })
  plan.nodes[plan.nodes.length - 1] = { kind: 'finish', id: 'finish', how: 'complete' }
  const result = compileWorkPlanExecution(plan, ctx)
  expect(result.problems).toEqual([])
  expect(result.outcomes[0]!.conditions).toEqual([
    { id: 'page', label: 'Page exists', kind: 'file', target: 'page.html' }
  ])
})

it('can author incomplete fields without making them executable', () => {
  const input = {
    prompt: '',
    outcome: {
      title: '',
      outputKind: 'work' as const,
      doneWhen: [{ id: 'd1', text: '', evidence: 'human' as const }]
    },
    planMode: false,
    ctx
  }
  const draft = workPlanDraftFromShape('solo', input)
  expect(draft.outcome).toEqual(input.outcome)
  expect(draft.nodes.length).toBeGreaterThan(0)
  expect(compileWorkPlanExecution(draft, ctx).steps).toEqual([])
  expect(workPlanProblems(draft, ctx).map((problem) => problem.code)).toEqual(
    expect.arrayContaining(['outcome-no-title', 'outcome-done-when-no-text'])
  )
  expect(() => workPlanFromShape('solo', input)).toThrow('Name what this should achieve.')
  expect(() =>
    workPlanDraftFromShape('solo', { ...input, ctx: { ...ctx, usableAgents: [] } })
  ).toThrow('No usable agent on this execution host.')
})
