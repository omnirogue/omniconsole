import { councilFinalCheckSteps, councilFinalCheckInvalid } from './workflow-council-final-check'
import { oneAnswerProblems } from './workflow-one-answer'
import { decideSkepticProblems } from './workflow-decide-guard'
import { isIndependentLineage, modelLineage } from './model-lineage'
import { workflowStepSharesLineage, workflowAgentModelKnown } from './workflow-graph-lineage'
import {
  WORKFLOW_MAX_AGENTS_PER_STEP,
  WORKFLOW_MAX_CALLS,
  WORKFLOW_MAX_RANK_CANDIDATES,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_STEP_ID,
  workflowKindJudges,
  workflowRouteMayJudge,
  type WorkflowProblem,
  type WorkflowRoute,
  type WorkflowSpec,
  type WorkflowStep,
  type WorkflowValidation
} from './workflow-graph'
import { planWorkflowCalls, workflowTopology } from './workflow-graph-topology'
import { findJudgeStep } from './workflow-graph-find'
import { validateFind } from './workflow-graph-validate-find'
import { validateRepeat } from './workflow-graph-validate-repeat'
import { validateWeb } from './workflow-graph-validate-web'
import { decideStepProblems } from './workflow-graph-decide-fields'
import { workflowReviewTriageProblems } from './workflow-graph-review-triage'

const workProducing = (step: WorkflowStep | undefined): boolean =>
  !!step && (step.kind === 'do' || step.kind === 'synthesize')

/**
 * Every rule a runnable workflow must satisfy, each message pinned to a step when it concerns
 * one. Problems block Start; warnings are shown and do not.
 */
export function validateWorkflowSpec(
  spec: WorkflowSpec,
  options: { available?: readonly WorkflowRoute[] } = {}
): WorkflowValidation {
  const problems: WorkflowProblem[] = []
  const warnings: WorkflowProblem[] = []
  const problem = (message: string, stepId?: string) =>
    problems.push({ message, ...(stepId ? { stepId } : {}) })
  const warn = (message: string, stepId?: string) =>
    warnings.push({ message, ...(stepId ? { stepId } : {}) })
  const byId = new Map(spec.steps.map((step) => [step.id, step]))

  if (spec.finalCheck && !councilFinalCheckSteps(spec)) {
    problem(councilFinalCheckInvalid())
  }
  oneAnswerProblems(spec).forEach((message) => problem(message, spec.oneAnswer?.step))
  decideSkepticProblems(spec).forEach((message) => problem(message))
  if (!spec.steps.length) {
    problem('Add at least one step.')
    return { problems, warnings }
  }
  if (spec.steps.length > WORKFLOW_MAX_STEPS) {
    problem(`Use at most ${WORKFLOW_MAX_STEPS} steps.`)
  }
  if (byId.size !== spec.steps.length) {
    problem('Two steps have the same id.')
  }

  for (const step of spec.steps) {
    for (const route of ['openrouter', 'ollama'] as const) {
      if (step.agents.some((agent) => agent.route === route && !workflowAgentModelKnown(agent))) {
        const label = route === 'ollama' ? 'Ollama' : 'OpenRouter'
        problem(`Choose an ${label} model with a known family.`, step.id)
      }
    }
    const name = step.title || step.id
    if (!WORKFLOW_STEP_ID.test(step.id)) {
      problem(`${name}: the step id must be a short lowercase slug.`, step.id)
    }
    if (!step.title.trim()) {
      problem('Give this step a title.', step.id)
    }
    for (const input of step.inputs) {
      if (input === step.id) {
        problem(`${name} cannot take its own output as input.`, step.id)
      } else if (!byId.has(input)) {
        problem(`${name} takes input from a step that does not exist (${input}).`, step.id)
      }
    }
    if (step.agents.length < 1 || step.agents.length > WORKFLOW_MAX_AGENTS_PER_STEP) {
      problem(`${name} needs 1 to ${WORKFLOW_MAX_AGENTS_PER_STEP} agents.`, step.id)
    }
    if (options.available) {
      for (const agent of step.agents) {
        if (!options.available.includes(agent.route)) {
          problem(`${name}: ${agent.route} is not available on this computer.`, step.id)
        }
      }
    }
    if (
      workflowKindJudges(step.kind) &&
      step.agents.some((agent) => !workflowRouteMayJudge(agent.route, agent.model))
    ) {
      problem(`${name}: Gemini can do work but never reviews, ranks or synthesizes.`, step.id)
    }
    const inputSteps = step.inputs.map((input) => byId.get(input)).filter(Boolean) as WorkflowStep[]

    if (step.list && step.kind !== 'do') {
      problem(`${name}: only a Do step can produce a list.`, step.id)
    }
    if (step.kind === 'review') {
      if (!inputSteps.length) {
        problem(`${name} has nothing to review. Connect the step whose work it reviews.`, step.id)
      } else if (inputSteps.some((input) => !workProducing(input))) {
        problem(
          `${name} must review work from a Do or Synthesize step, not a review or ranking.`,
          step.id
        )
      }
    }
    // Find the best's judge ranks the options JEV put on top, not its input's answers.
    if (step.kind === 'rank' && findJudgeStep(spec)?.id !== step.id && !step.byCriterion) {
      // An Improve judge also compares the best version so far with each round's challengers.
      const improving = spec.repeat?.until === 'plateau' && spec.repeat.review === step.id
      const candidates =
        inputSteps.reduce((sum, input) => sum + input.agents.length, 0) + (improving ? 1 : 0)
      if (step.forEach) {
        problem(
          `${name}: a ranking compares whole answers, so it cannot run for each item.`,
          step.id
        )
      }
      if (inputSteps.some((input) => !workProducing(input))) {
        problem(`${name} can only rank answers from Do or Synthesize steps.`, step.id)
      } else if (inputSteps.some((input) => input.list || input.forEach)) {
        problem(`${name} can only rank whole answers, not list items.`, step.id)
      } else if (candidates < 2) {
        problem(
          `${name} needs at least two answers to compare. Give its input step two or more agents.`,
          step.id
        )
      } else if (candidates > WORKFLOW_MAX_RANK_CANDIDATES) {
        problem(`${name} can compare at most ${WORKFLOW_MAX_RANK_CANDIDATES} answers.`, step.id)
      }
    }
    if (step.kind === 'synthesize') {
      if (step.agents.length !== 1) {
        problem(`${name}: a synthesis is written by exactly one agent.`, step.id)
      }
      const combined = inputSteps.reduce(
        (sum, input) => sum + (input.list || input.forEach ? 2 : input.agents.length),
        0
      )
      if (!inputSteps.length) {
        problem(`${name} has nothing to synthesize. Connect the steps it combines.`, step.id)
      } else if (combined < 2) {
        problem(
          `${name} only receives one result, so there is nothing to combine. Add agents upstream or remove this step.`,
          step.id
        )
      }
      if (step.forEach) {
        problem(
          `${name}: a synthesis combines everything once; it cannot run for each item.`,
          step.id
        )
      }
    }
    if (step.forEach) {
      const source = byId.get(step.forEach.step)
      if (!source) {
        problem(`${name} runs for each item of a step that does not exist.`, step.id)
      } else if (!source.list) {
        problem(
          `${name} runs for each item of ${source.title}, but ${source.title} does not produce a list.`,
          step.id
        )
      }
    }
    workflowReviewTriageProblems(step, name, byId).forEach((message) => problem(message, step.id))
    decideStepProblems(step, byId, name).forEach((message) => problem(message, step.id))
  }

  const topology = workflowTopology(spec)
  if (!topology.order) {
    if (!problems.some((entry) => entry.message.includes('does not exist'))) {
      problem('The steps depend on each other in a circle. Remove one of the connections.')
    }
  } else {
    if (topology.sinks.length > 1) {
      for (const id of topology.sinks) {
        const step = byId.get(id)!
        problem(
          `${step.title}'s output isn't used by anything. Connect it to a later step, or remove it.`,
          id
        )
      }
    }
    const final = topology.sinks.length === 1 ? byId.get(topology.sinks[0]) : undefined
    const renderedQuickList =
      spec.template === 'quick-discover' &&
      spec.steps.length === 1 &&
      final?.id === 'find' &&
      final.kind === 'do' &&
      final.agents.length === 1
    if (final?.list && !renderedQuickList) {
      problem(
        `${final.title} is the last step, so its list would never be used. Turn off "list" or add a step after it.`,
        final.id
      )
    }
    if (final && final.agents.length > 1 && final.kind === 'do' && !final.forEach) {
      warn(
        `${final.title} ends with ${final.agents.length} separate answers. Add a Synthesize step to get one answer.`,
        final.id
      )
    }
  }

  validateRepeat(spec, byId, problem, warn)
  if (spec.template === 'discover' && spec.repeat?.until === 'nothing-new') {
    const finders = byId.get(spec.repeat.do)?.agents ?? []
    const reviewers = byId.get(spec.repeat.review)?.agents ?? []
    if (
      finders.some(
        (finder) =>
          !reviewers.some(
            (reviewer) =>
              workflowRouteMayJudge(reviewer.route, reviewer.model) &&
              isIndependentLineage(
                modelLineage(finder.route, finder.model),
                modelLineage(reviewer.route, reviewer.model)
              )
          )
      )
    ) {
      problem(
        'Thorough Discover needs an independent verifier for every finder family. Set up another model family that can verify (Claude, Codex or Grok), or use Quick Discover.',
        spec.repeat.review
      )
    }
  }

  for (const step of spec.steps) {
    if (step.kind !== 'review' && step.kind !== 'rank') {
      continue
    }
    if (workflowStepSharesLineage(step, byId)) {
      warn(
        `${step.title} is done by the same model families that did the work. Add another family for an independent check.`,
        step.id
      )
    }
  }

  validateFind(spec, problem)
  validateWeb(spec, problem)
  const plan = planWorkflowCalls(spec)
  if (plan.total > WORKFLOW_MAX_CALLS) {
    problem(
      `This workflow could make up to ${plan.total} agent calls; the limit is ${WORKFLOW_MAX_CALLS}. Lower an agent count or a for-each limit.`
    )
  }
  return { problems, warnings }
}
