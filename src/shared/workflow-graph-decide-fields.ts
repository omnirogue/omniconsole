import {
  WORKFLOW_MAX_CRITERIA,
  WORKFLOW_MAX_RANK_CANDIDATES,
  type WorkflowStep,
  type WorkflowTemplateId
} from './workflow-graph'

/**
 * A comparison by criterion's rounds: 1 is its overall order and 2 the final check; each rubric
 * line then takes two, as shown and reversed (graph-compare-line.ts). Nothing else may use them.
 */
export const WORKFLOW_COMPARE_FIRST_ROUND = 3
export const WORKFLOW_COMPARE_LAST_ROUND =
  WORKFLOW_COMPARE_FIRST_ROUND + 2 * WORKFLOW_MAX_CRITERIA - 1

export const WORKFLOW_TEMPLATE_IDS: ReadonlySet<WorkflowTemplateId> = new Set([
  'council',
  'discover',
  'quick-discover',
  'build-review',
  'best-of-n',
  'improve',
  'find',
  'decide',
  'investigate',
  'custom'
])

/** Decide's two step fields, kept only on the kind that uses them, with ids mapped. */
export function normalizeDecideStepFields(
  raw: Record<string, unknown> | undefined,
  kind: WorkflowStep['kind'],
  mapId: (value: unknown) => string | undefined
): Pick<WorkflowStep, 'byCriterion' | 'whenClose'> {
  const by = raw?.byCriterion as { rubricFrom?: unknown } | undefined
  const rubricFrom = kind === 'rank' && by && typeof by === 'object' && mapId(by.rubricFrom)
  const whenClose = kind === 'do' && mapId(raw?.whenClose)
  return {
    ...(rubricFrom ? { byCriterion: { rubricFrom } } : {}),
    ...(whenClose ? { whenClose } : {})
  }
}

/** The for-each step whose answers a comparison by criterion ranks. */
export function criterionCandidatesStep(
  step: WorkflowStep,
  byId: ReadonlyMap<string, WorkflowStep>
): WorkflowStep | undefined {
  return step.byCriterion
    ? step.inputs.map((id) => byId.get(id)).find((input) => input?.kind === 'do' && input.forEach)
    : undefined
}

/** What stops a comparison by criterion or a crux from running as written. */
export function decideStepProblems(
  step: WorkflowStep,
  byId: ReadonlyMap<string, WorkflowStep>,
  name: string
): string[] {
  const problems: string[] = []
  if (step.byCriterion) {
    const source = criterionCandidatesStep(step, byId)
    if (!step.inputs.includes(step.byCriterion.rubricFrom)) {
      problems.push(`${name} takes its rubric from a step it does not read.`)
    }
    if (!source) {
      problems.push(`${name} compares the answers of a for-each Do step; connect one.`)
    } else if (source.forEach!.limit * source.agents.length > WORKFLOW_MAX_RANK_CANDIDATES) {
      problems.push(`${name} can compare at most ${WORKFLOW_MAX_RANK_CANDIDATES} answers.`)
    }
  }
  if (step.whenClose && byId.get(step.whenClose)?.kind !== 'rank') {
    problems.push(`${name} runs only when a ranking is close, so it needs a Rank step to read.`)
  } else if (step.whenClose && !step.inputs.includes(step.whenClose)) {
    problems.push(`${name} runs only when a ranking is close; connect that ranking as an input.`)
  }
  return problems
}
