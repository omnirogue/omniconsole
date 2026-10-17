import { expect, it } from 'vitest'
import {
  appendWorkPlanFragment,
  fragmentAvailable,
  type WorkPlanFragment
} from './work-plan-fragments'
import { workPlanFromShape } from './work-plan-shapes'
import {
  workPlanFixtureContext,
  WORK_PLAN_FIXTURE_ACTORS
} from './__fixtures__/work-plan/work-plan-context'
import { compileWorkPlanExecution } from './work-plan-compile'
const ctx = workPlanFixtureContext()
const outcome = {
  title: 'Page works',
  outputKind: 'work' as const,
  doneWhen: [{ id: 'page', text: 'Page exists', evidence: 'file' as const, path: 'index.html' }]
}
const solo = () => workPlanFromShape('solo', { prompt: 'Build it', outcome, planMode: false, ctx })
const fragment: WorkPlanFragment = {
  action: 'improve',
  topology: 'solo',
  route: 'new-session',
  actor: WORK_PLAN_FIXTURE_ACTORS.codex
}
it('inserts WHAT/HOW/WHERE after the anchor without mutating the original', () => {
  const plan = solo()
  const before = structuredClone(plan)
  const result = appendWorkPlanFragment(plan, 'work', fragment)
  expect(plan).toEqual(before)
  expect(result.nodes[1]).toMatchObject({
    kind: 'worker',
    role: 'improve',
    actor: WORK_PLAN_FIXTURE_ACTORS.codex,
    readsFrom: ['work'],
    route: 'new-session'
  })
  expect(fragmentAvailable(plan, 'work', fragment, ctx)).toEqual({ ok: true })
  expect(compileWorkPlanExecution(result, ctx).problems).toEqual([])
})
it('requires at least two candidates for Judge or Synthesize', () => {
  expect(fragmentAvailable(solo(), 'work', { ...fragment, action: 'judge' }, ctx).ok).toBe(false)
  expect(fragmentAvailable(solo(), 'work', { ...fragment, action: 'synthesize' }, ctx).ok).toBe(
    false
  )
})
it('adds a synthesis after a widened anchor and a human finish', () => {
  const plan = workPlanFromShape('parallel', {
    prompt: 'Build alternatives',
    outcome,
    planMode: false,
    ctx
  })
  const next = appendWorkPlanFragment(plan, 'work', {
    ...fragment,
    action: 'synthesize',
    route: 'human'
  })
  expect(compileWorkPlanExecution(next, ctx).problems).toEqual([])
  expect(next.nodes.at(-1)).toMatchObject({ how: 'my-review', route: 'human' })
})
it('reports unsupported routes and missing anchors', () => {
  expect(fragmentAvailable(solo(), 'work', { ...fragment, route: 'same-session' }, ctx).ok).toBe(
    false
  )
  expect(fragmentAvailable(solo(), 'missing', fragment, ctx).ok).toBe(false)
})

it('a judge fragment uses the selected independent actor and consumes its winner', () => {
  const plan = workPlanFromShape('parallel', { prompt: 'Propose', outcome, planMode: false, ctx })
  const judge: WorkPlanFragment = {
    action: 'judge',
    topology: 'solo',
    route: 'new-session',
    actor: WORK_PLAN_FIXTURE_ACTORS.kimi
  }
  expect(fragmentAvailable(plan, 'work', judge, ctx)).toEqual({ ok: true })
  const compiled = compileWorkPlanExecution(appendWorkPlanFragment(plan, 'work', judge), ctx)
  expect(compiled.problems).toEqual([])
  const step = compiled.steps.find((step) => step.presetId === 'judge')!
  expect(step.agent).toBe('kimi')
  expect(compiled.steps.find((s) => s.readsWinnerOf)?.readsWinnerOf).toBe(step.id)
})
