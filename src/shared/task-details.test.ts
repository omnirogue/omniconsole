import { expect, it } from 'vitest'
import { taskPlan, taskPlanFromSteps } from './task-details'

it('keeps people attached to their step when reordered', () => {
  const plan = taskPlanFromSteps(['Draft', 'Review'])
  plan.steps[1].actor_ids = ['emp_gamma']
  plan.steps.reverse()
  expect(taskPlan.parse(plan).steps).toEqual([
    { id: 'step_2', title: 'Review', actor_ids: ['emp_gamma'] },
    { id: 'step_1', title: 'Draft', actor_ids: [] }
  ])
})

it('rejects ambiguous step identities and invalid people', () => {
  const plan = taskPlanFromSteps(['Draft', 'Review'])
  plan.steps[1].id = plan.steps[0].id
  expect(taskPlan.safeParse(plan).success).toBe(false)
  plan.steps[1].id = 'step_2'
  plan.steps[1].actor_ids = ['']
  expect(taskPlan.safeParse(plan).success).toBe(false)
})
