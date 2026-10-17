import { isBoardTaskId } from './board-task-id'
import { workPlanNodeInstruction } from './work-plan-instruction'
import {
  WORK_PLAN_MAX_AI_SEATS,
  WORK_PLAN_MAX_SEATS,
  WORK_PLAN_MAX_STAGES,
  WORK_PLAN_ROLE_PRESET,
  workPlanNodeSeatCount,
  workPlanOutcomeOf,
  workPlanSeatTotal,
  workPlanStageCount,
  type WorkPlan,
  type WorkPlanContext,
  type WorkPlanNode,
  type WorkPlanProblem
} from './work-plan-types'
import { workPlanEdgeProblems } from './work-plan-validate-edges'
import { workPlanSeatProblems } from './work-plan-validate-seats'

/**
 * The ONE validator: the commit path, the CLI, upsert, the AI team path and the proposer all
 * ask this and nothing else. Pure — it reads the plan and the host's context, never the disk.
 */
function block(code: string, message: string, nodeId?: string): WorkPlanProblem {
  return { code, message, severity: 'block', ...(nodeId ? { nodeId } : {}) }
}

const OUTCOME_RELATIVE_ROLES = ['plan', 'analyze', 'research'] as const
/** The same ceiling `condition.verification` carries in session-outcome-types.ts. */
const COMMAND_ARG_LIMIT = 128

/** A step with no text and no preset text compiles to an empty prompt and is dropped on save. */
function promptProblems(plan: WorkPlan, node: WorkPlanNode): WorkPlanProblem[] {
  if (node.kind === 'finish') {
    return []
  }
  if (node.kind === 'worker' && !WORK_PLAN_ROLE_PRESET[node.role]) {
    return [block('role-preset-missing', `${node.id} has a role this build cannot run.`, node.id)]
  }
  const problems: WorkPlanProblem[] = []
  if (!workPlanNodeInstruction(plan, node).trim()) {
    problems.push(
      block(
        'role-preset-empty-instruction',
        `${node.id} would run with no instruction at all.`,
        node.id
      )
    )
  }
  // Seats thinking side by side only diverge usefully against a stated end; without one they
  // all restate the prompt, and the default instruction has nothing to be relative to.
  if (
    node.kind === 'worker' &&
    workPlanNodeSeatCount(node) > 1 &&
    (OUTCOME_RELATIVE_ROLES as readonly string[]).includes(node.role) &&
    workPlanOutcomeOf(plan).doneWhen.length === 0 &&
    !node.instruction.trim()
  ) {
    problems.push(
      block(
        'parallel-plan-needs-outcome',
        `${node.id} runs several seats of ${node.role} with nothing to aim at. Say when this is done, or give the step its own instruction.`,
        node.id
      )
    )
  }
  return problems
}

/** The desired state sits above the chain: it is what every transform below is measured against. */
function outcomeProblems(plan: WorkPlan, ctx: WorkPlanContext): WorkPlanProblem[] {
  const problems: WorkPlanProblem[] = []
  if (!workPlanOutcomeOf(plan).title.trim()) {
    problems.push(block('outcome-no-title', 'Name what this should achieve.'))
  }
  const seen = new Set<string>()
  for (const entry of workPlanOutcomeOf(plan).doneWhen) {
    if (!entry.id.trim() || seen.has(entry.id)) {
      problems.push(
        block('outcome-done-when-duplicate-id', `Every done-when entry needs its own name.`)
      )
    }
    seen.add(entry.id)
    if (!entry.text.trim()) {
      problems.push(block('outcome-done-when-no-text', 'Say what each done-when entry means.'))
    }
    if (entry.evidence === 'file' && !entry.path?.trim()) {
      problems.push(
        block('outcome-done-when-no-path', `Name the file that proves "${entry.text}".`)
      )
    }
    if (
      entry.evidence === 'command' &&
      (!entry.command?.program.trim() || entry.command.args.length > COMMAND_ARG_LIMIT)
    ) {
      problems.push(
        block('outcome-done-when-no-command', `Name the check that proves "${entry.text}".`)
      )
    }
    // Why the author matters: the host RUNS this. A person may ask for a check of their own; a
    // model-written plan may never hand the host a program to execute.
    if ((entry.command || entry.evidence === 'command') && ctx.commitSource !== 'user') {
      problems.push(
        block(
          'outcome-command-not-user',
          `Only you can ask for a check that runs a program. Remove it from "${entry.text}", or write it yourself.`
        )
      )
    }
  }
  const outcome = workPlanOutcomeOf(plan)
  if (outcome.taskRef !== undefined && !isBoardTaskId(outcome.taskRef)) {
    problems.push(
      block('outcome-task-ref-invalid', 'That is not the name of a card this board can hold.')
    )
  }
  // One plan, one completion contract: a second outcome anywhere in it would mean two answers to
  // "is this done?", and the plan could satisfy one while failing the other.
  const nested = plan.nodes.find((node) => {
    const raw = node as { outcome?: unknown; doneWhen?: unknown; outcomeId?: unknown }
    return raw.outcome !== undefined || raw.doneWhen !== undefined || raw.outcomeId !== undefined
  })
  if (nested) {
    problems.push(
      block(
        'plan-second-outcome',
        `${nested.id} states an outcome of its own. A plan has one outcome; its steps are how that outcome is reached.`,
        nested.id
      )
    )
  }
  const finish = plan.nodes.find((node) => node.kind === 'finish')
  return workPlanOutcomeOf(plan).doneWhen.length === 0 &&
    finish?.kind === 'finish' &&
    finish.how !== 'my-review'
    ? [
        ...problems,
        block(
          'outcome-done-when-empty',
          'Say when this is done, or finish by handing it back to you to decide.'
        )
      ]
    : problems
}

function structureProblems(plan: WorkPlan): WorkPlanProblem[] {
  const problems: WorkPlanProblem[] = []
  if (plan.nodes.length === 0) {
    return [block('plan-no-nodes', 'Add at least one step before sending.')]
  }
  const seen = new Set<string>()
  for (const node of plan.nodes) {
    if (!node.id.trim() || seen.has(node.id)) {
      problems.push(
        block(
          'plan-duplicate-node-id',
          `Every step needs its own name; ${node.id || '(unnamed)'} is used twice.`,
          node.id
        )
      )
    }
    seen.add(node.id)
  }
  const finishes = plan.nodes.filter((node) => node.kind === 'finish')
  if (finishes.length === 0) {
    problems.push(
      block('plan-no-finish', 'Say how this plan finishes: on its own, or back to you.')
    )
  }
  if (finishes.length > 1) {
    problems.push(block('plan-multiple-finish', 'A plan finishes once.'))
  }
  if (finishes.length === 1 && plan.nodes.at(-1)?.kind !== 'finish') {
    problems.push(
      block('plan-finish-not-last', 'The finish is the last step of a plan.', finishes[0]!.id)
    )
  }
  return problems
}

function capProblems(plan: WorkPlan, ctx: WorkPlanContext): WorkPlanProblem[] {
  const problems: WorkPlanProblem[] = []
  const stages = workPlanStageCount(plan)
  if (stages > WORK_PLAN_MAX_STAGES) {
    problems.push(
      block(
        'stages-over-cap',
        `Choose up to ${WORK_PLAN_MAX_STAGES} stages; this plan has ${stages}. Seats side by side in one group count as one stage.`
      )
    )
  }
  const seats = workPlanSeatTotal(plan)
  if (seats > WORK_PLAN_MAX_SEATS) {
    problems.push(
      block('seats-over-cap', `Choose up to ${WORK_PLAN_MAX_SEATS} seats; this plan runs ${seats}.`)
    )
  }
  if (ctx.commitSource === 'ai' && seats > WORK_PLAN_MAX_AI_SEATS) {
    problems.push(
      block(
        'ai-seats-over-cap',
        `A team an agent planned runs up to ${WORK_PLAN_MAX_AI_SEATS} seats; this one runs ${seats}.`
      )
    )
  }
  return problems
}

export function workPlanProblems(plan: WorkPlan, ctx: WorkPlanContext): WorkPlanProblem[] {
  const structure = structureProblems(plan)
  if (structure.some((problem) => problem.code === 'plan-no-nodes')) {
    return structure
  }
  return [
    ...structure,
    ...outcomeProblems(plan, ctx),
    ...plan.nodes.flatMap((node) => promptProblems(plan, node)),
    ...workPlanEdgeProblems(plan),
    ...workPlanSeatProblems(plan, ctx),
    ...capProblems(plan, ctx)
  ]
}

export function workPlanBlocks(problems: readonly WorkPlanProblem[]): WorkPlanProblem[] {
  return problems.filter((problem) => problem.severity === 'block')
}
