// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkPlanComposerDialog } from './WorkPlanComposerDialog'
import { canonicalWorkPlanNodes } from './work-plan-composer-canonical'
import { councilWorkPlan } from '../../../../../shared/__fixtures__/work-plan/council-work-plan'
import { samWorkPlan } from '../../../../../shared/__fixtures__/work-plan/sal-work-plan'
import { samWorkPlan as executableSamWorkPlan } from '../../../../../shared/__fixtures__/work-plan/wp2/sal-work-plan'
import { workPlanFixtureContext } from '../../../../../shared/__fixtures__/work-plan/work-plan-context'
import { modelLineage } from '../../../../../shared/model-lineage'
import { workPlanFromShape } from '../../../../../shared/work-plan-shapes'
import { workPlanNotation } from '../../../../../shared/work-plan-notation'
import { workPlanProblems } from '../../../../../shared/work-plan-validate'
import {
  isWorkPlanWorkerNode,
  workPlanNodeActors,
  type WorkPlan,
  type WorkPlanOutcome,
  type WorkPlanWorkerNode
} from '../../../../../shared/work-plan-types'

vi.mock('@/components/ui/select', async () =>
  (await import('./work-plan-composer-test-doubles')).selectDouble()
)
vi.mock('@/components/ui/dialog', async () =>
  (await import('./work-plan-composer-test-doubles')).dialogDouble()
)

const ctx = workPlanFixtureContext()
afterEach(cleanup)

/** Solo is where every chain starts: one seat, and the Outcome the bar proposed above it. */
function openOnSolo(outcome: WorkPlanOutcome): { used: WorkPlan[] } {
  const used: WorkPlan[] = []
  render(
    <WorkPlanComposerDialog
      capacity={3}
      ctx={ctx}
      onCancel={vi.fn()}
      onUse={(plan) => used.push(plan)}
      open
      plan={workPlanFromShape('solo', {
        prompt: 'Ship the launch page',
        outcome,
        planMode: false,
        ctx
      })}
    />
  )
  return { used }
}

const stage = (index: number): HTMLElement => screen.getAllByRole('listitem')[index - 1]!
const set = (index: number, label: string, value: string): void => {
  fireEvent.change(within(stage(index)).getByLabelText(label), { target: { value } })
}
const press = (index: number, name: string): void => {
  fireEvent.click(within(stage(index)).getByRole('button', { name }))
}

it("builds Sal's example through the dialog's own controls", () => {
  const { used } = openOnSolo(samWorkPlan().outcome)
  // Solo → ⑂3 Research, with the role's own words instead of the prompt it started from.
  set(1, 'Action', 'research')
  set(1, 'Instruction', '')
  set(1, 'Seats', '3')
  press(1, 'Synthesize')
  press(2, 'Add stage after')
  set(3, 'Action', 'plan')
  set(3, 'Seats', '3')
  press(3, 'Judge')
  press(4, 'Add stage after')
  set(5, 'Action', 'improve')
  fireEvent.click(within(stage(5)).getByRole('checkbox', { name: 'Run on the winner' }))
  // The verify stage measures the work against every Done When entry, not only the two the
  // proposed Outcome already had evidence kinds for.
  fireEvent.click(
    within(stage(6)).getByRole('checkbox', {
      name: 'Done When: the page file is in the workspace'
    })
  )
  expect(screen.getByLabelText('Live chain').textContent).toContain(
    '⑂3 Research → ◇ → ⑂3 📝 → ⚖ → ✨ → ✓ → 👤'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Use this chain' }))
  const built = used.at(-1)!
  expect(built.nodes).toHaveLength(7)
  const expected = executableSamWorkPlan()
  delete expected.outcome.outcomeId
  expect(canonicalWorkPlanNodes(built)).toEqual(canonicalWorkPlanNodes(expected))
  expect(built.outcome).toEqual(expected.outcome)
  expect(workPlanProblems(built, ctx)).toEqual([])
  expect(workPlanNotation(built)).toBe(workPlanNotation(expected))
})

it('seats a judge no candidate shares a family with', () => {
  const { used } = openOnSolo(samWorkPlan().outcome)
  set(1, 'Action', 'plan')
  set(1, 'Seats', '3')
  press(1, 'Judge')
  press(2, 'Add stage after')
  set(3, 'Action', 'improve')
  fireEvent.click(within(stage(3)).getByRole('checkbox', { name: 'Run on the winner' }))
  fireEvent.click(screen.getByRole('button', { name: 'Use this chain' }))
  const plan = used.at(-1)!
  const workers = plan.nodes.filter(isWorkPlanWorkerNode)
  const judge = workers.find((node) => node.role === 'judge')!
  const candidates = workers
    .filter((node) => node.role === 'plan')
    .flatMap((node) => workPlanNodeActors(node))
    .map((actor) => modelLineage(actor.agent, actor.model))
  const family = modelLineage(judge.actor.agent, judge.actor.model)
  expect(candidates).not.toContain(family)
  expect(workPlanProblems(plan, ctx)).toEqual([])
})

it('builds a Council: answers ×3, critiques that read each other, one judge', () => {
  const { used } = openOnSolo(councilWorkPlan().outcome)
  set(1, 'Seats', '3')
  press(1, 'Critique each other')
  press(1, 'Judge')
  press(3, 'Add stage after')
  set(4, 'Action', 'synthesize')
  fireEvent.click(within(stage(4)).getByRole('checkbox', { name: 'Run on the winner' }))
  expect(screen.getByLabelText('Live chain').textContent).toContain(
    '⑂3 Implement → ⑂3 Critique → ⚖ → ◇ → ✓ → 👤'
  )
  fireEvent.click(screen.getByRole('button', { name: 'Use this chain' }))
  const plan = used.at(-1)!
  const workers: WorkPlanWorkerNode[] = plan.nodes.filter(isWorkPlanWorkerNode)
  const answers = workers.filter((node) => node.role === 'implement')
  const critiques = workers.filter((node) => node.role === 'critique')
  const judge = workers.find((node) => node.verdict?.consumed === 'select-winner')!
  expect(answers).toHaveLength(3)
  expect(critiques).toHaveLength(3)
  // Each critique reads the OTHER answers: a Council is not a review round over one candidate.
  for (const critique of critiques) {
    expect(critique.readsFrom).toHaveLength(2)
    expect(critique.readsFrom).not.toContain(answers[critiques.indexOf(critique)]!.id)
    expect(critique.verdict).toEqual({
      kind: 'critique',
      over: critique.readsFrom,
      consumed: 'record'
    })
  }
  expect(judge.verdict!.over).toEqual(answers.map((node) => node.id))
  expect(judge.readsFrom).toEqual([
    ...answers.map((node) => node.id),
    ...critiques.map((node) => node.id)
  ])
  expect(workPlanProblems(plan, ctx)).toEqual([])
})
