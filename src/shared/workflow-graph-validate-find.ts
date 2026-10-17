import {
  WORKFLOW_FIND_HARVEST_MAX,
  WORKFLOW_FIND_HARVEST_MAX_QUERY_CHARS,
  type WorkflowFind,
  type WorkflowSpec
} from './workflow-graph'
import { findJudgeStep, findOptionsStep } from './workflow-graph-find'

/** Find the best's own rules: its two steps, and a pool worth judging. */
export function validateFind(
  spec: WorkflowSpec,
  problem: (message: string, stepId?: string) => void
): void {
  const find = spec.find
  if (!find) {
    return
  }
  const options = findOptionsStep(spec)
  if (!options || !findJudgeStep(spec)) {
    problem(
      find.versions
        ? 'Find the best needs its Options step (one version per agent) and a Judge step that ranks it.'
        : 'Find the best needs its Options step (a list) and a Judge step that ranks it.'
    )
  } else if (find.versions && !find.items && options.agents.length < 2) {
    problem('Complete versions need at least two agents writing them.', options.id)
  }
  if (spec.repeat) {
    problem('Find the best cannot also repeat.')
  }
  if (find.items && find.items.length < 2) {
    problem('Give at least two options to choose from, one per line.')
  }
  validateHarvest(find.harvest, problem)
}

/** The person's GitHub search: what they typed has to be searchable, and bounded. */
function validateHarvest(
  harvest: WorkflowFind['harvest'],
  problem: (message: string, stepId?: string) => void
): void {
  if (!harvest) {
    return
  }
  if (!harvest.query.trim()) {
    problem('Type what to search GitHub for, for example "queue library language:go".')
  } else if (harvest.query.length > WORKFLOW_FIND_HARVEST_MAX_QUERY_CHARS) {
    problem(
      `The GitHub search is ${harvest.query.length} characters; keep it to ${WORKFLOW_FIND_HARVEST_MAX_QUERY_CHARS}.`
    )
  }
  if (
    !Number.isInteger(harvest.max) ||
    harvest.max < 1 ||
    harvest.max > WORKFLOW_FIND_HARVEST_MAX
  ) {
    problem(`Search GitHub for between 1 and ${WORKFLOW_FIND_HARVEST_MAX} repositories.`)
  }
}
