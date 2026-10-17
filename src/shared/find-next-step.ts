import type { WorkflowFindRow, WorkflowFindTrail } from './workflow-find-trail'
import type { WorkflowRoute, WorkflowSpec } from './workflow-graph'
import { workflowPatchStep } from './workflow-graph-edit'
import { findJudgeStep } from './workflow-graph-find'
import { workflowTemplate } from './workflow-graph-templates'
import { workflowReadsWeb } from './workflow-graph-web'

/** How many options a next step reads whole: enough to mix strengths, few enough to read. */
export const FIND_NEXT_STEP_MAX = 5

export type FindNextStep = 'improve' | 'build' | 'combine' | 'look-closer'

/** Only Find hands options on, and never from a run that read pages: they would travel unfenced. */
export const findNextStepAllowed = (spec: WorkflowSpec): boolean =>
  !!spec.find && !workflowReadsWeb(spec)

/** What the chosen options allow: Improve or build one, Combine a few, Look closer at up to five. */
export function findNextSteps(chosen: number): FindNextStep[] {
  if (chosen < 1 || chosen > FIND_NEXT_STEP_MAX) {
    return []
  }
  return chosen === 1 ? ['improve', 'build', 'look-closer'] : ['combine', 'look-closer']
}

// The judge-safe text a continuation builds its task from: never row.detail, which a GitHub
// repository's owner wrote and could word as instructions to whatever reads it next. The
// host-fetched facts (never an owner's own words) travel alongside it, as every judge saw both.
const described = (row: WorkflowFindRow) =>
  row.facts ? `${row.judgeText}\n${row.facts}` : row.judgeText

/**
 * The task the next conversation starts from: the question Find the best answered, and the chosen
 * options whole, best first: one to make better, to build (Build + Review) or to look at closely
 * (Decide), or a few to combine into one better than each, or to weigh against each other.
 */
export function findNextStepPrompt(
  task: string,
  trail: WorkflowFindTrail,
  step: FindNextStep,
  keys: readonly string[]
): string {
  const chosen = (trail.rows ?? []).filter((row) => keys.includes(row.key))
  if (!findNextSteps(chosen.length).includes(step)) {
    throw new Error(
      `Choose one option to improve, two to ${FIND_NEXT_STEP_MAX} to combine, or up to ${FIND_NEXT_STEP_MAX} to look closer at.`
    )
  }
  const question = task.trim()
  if (chosen.length === 1) {
    const only = chosen[0]!
    const standing =
      only.key === trail.winner?.key ? `the best of ${trail.pool}` : `one of ${trail.pool} options`
    if (step === 'build') {
      return `${question}\n\nBuild this in the workspace. It was ${standing} in Find the best:\n\n${described(only)}\n\nMake the change it describes, with tests that show it works.`
    }
    return step === 'look-closer'
      ? `${question}\n\nLook closer at this option before choosing it. It was ${standing} in Find the best:\n\n${described(only)}\n\nIs it the right choice for the task? What would make it fail, what is it missing, and what should be checked before relying on it?`
      : `${question}\n\nMake this better. It was ${standing} in Find the best:\n\n${described(only)}`
  }
  const list = chosen.map((row, index) => `${index + 1}. ${described(row)}`).join('\n\n')
  return step === 'look-closer'
    ? `${question}\n\nLook closer at these ${chosen.length} options from Find the best before choosing one:\n\n${list}\n\nWhich is the right choice for the task? What would make each one fail, what is each missing, and what should be checked before relying on it?`
    : `${question}\n\nCombine the strengths of these ${chosen.length} options from Find the best into one that is better than each of them:\n\n${list}`
}

/** Improve, judged by what good meant in the Find the best run, with the models it used. */
export function findNextStepSpec(find: WorkflowSpec): WorkflowSpec {
  const routes = [
    ...new Set(find.steps.flatMap((step) => step.agents.map((agent) => agent.route)))
  ] as WorkflowRoute[]
  const improve = workflowTemplate('improve', routes)
  const rubric = findJudgeStep(find)?.instruction ?? ''
  return rubric.trim() && improve.repeat
    ? workflowPatchStep(improve, improve.repeat.review, { instruction: rubric })
    : improve
}
