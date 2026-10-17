import {
  WORKFLOW_MAX_IMPROVE_ROUNDS,
  WORKFLOW_MAX_ROUNDS,
  type WorkflowSpec,
  type WorkflowStep
} from './workflow-graph'
import { workflowDescendants } from './workflow-graph-topology'
import { validateImproveRepeat } from './workflow-improve-validate'

/** A repeat's rules: which steps loop, until what, and what each may read. */
export function validateRepeat(
  spec: WorkflowSpec,
  byId: Map<string, WorkflowStep>,
  problem: (message: string, stepId?: string) => void,
  warn: (message: string) => void = () => {}
): void {
  const repeat = spec.repeat
  if (!repeat) {
    return
  }
  const doStep = byId.get(repeat.do)
  const review = byId.get(repeat.review)
  if (!doStep || doStep.kind !== 'do') {
    problem('Repeat must loop a Do step.')
    return
  }
  if (repeat.until === 'plateau' ? review?.kind !== 'rank' : review?.kind !== 'review') {
    problem(
      repeat.until === 'plateau'
        ? 'Improving needs a Rank step that compares each round with the best version so far.'
        : 'Repeat must loop until a Review step says so.'
    )
    return
  }
  if (!review) {
    return
  }
  if (!review.inputs.includes(doStep.id)) {
    problem(
      `${review.title} must review ${doStep.title} for the two to repeat together.`,
      review.id
    )
  }
  const maxRounds = repeat.until === 'plateau' ? WORKFLOW_MAX_IMPROVE_ROUNDS : WORKFLOW_MAX_ROUNDS
  if (repeat.maxRounds < 1 || repeat.maxRounds > maxRounds) {
    problem(`Repeat at most ${maxRounds} rounds.`)
  }
  const afterDo = workflowDescendants(spec, doStep.id)
  for (const input of review.inputs) {
    if (input !== doStep.id && afterDo.has(input)) {
      problem(
        `${review.title} can only take ${doStep.title} and steps before it as input, because the two repeat together.`,
        review.id
      )
    }
  }
  if (doStep.inputs.includes(review.id)) {
    problem(
      `${doStep.title} already receives ${review.title}'s feedback each round; remove that input.`,
      doStep.id
    )
  }
  if (repeat.until === 'approved') {
    if (review.forEach) {
      problem(
        `${review.title} reviews items one by one, so it cannot approve the whole work. Use "until nothing new" or review the whole step.`,
        review.id
      )
    }
    if (doStep.agents.length !== 1 || doStep.forEach || doStep.list) {
      problem(
        `${doStep.title} revises one piece of work each round, so it needs exactly one agent and no list.`,
        doStep.id
      )
    }
  } else if (repeat.until === 'plateau') {
    if (doStep.forEach || doStep.list) {
      problem(
        `${doStep.title} makes whole versions of the work to compare, so it cannot list items or run for each item.`,
        doStep.id
      )
    }
    validateImproveRepeat(repeat, problem, warn)
  } else {
    if (!doStep.list) {
      problem(`"Until nothing new" needs ${doStep.title} to produce a list.`, doStep.id)
    }
    if (!review.forEach || review.forEach.step !== doStep.id) {
      problem(
        `"Until nothing new" needs ${review.title} to run for each item ${doStep.title} lists.`,
        review.id
      )
    }
  }
}
