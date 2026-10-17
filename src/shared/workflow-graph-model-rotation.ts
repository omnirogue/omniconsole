import { localWorkflowRouteNamesModel } from './local-workflow-seats'
import {
  WORKFLOW_ROUTES,
  workflowKindJudges,
  workflowRouteMayJudge,
  type WorkflowRoute,
  type WorkflowStepKind
} from './workflow-graph'

/**
 * The routes agents rotate through by default: every available route with a default model, Claude first. Judging
 * steps skip Gemini. A step's agents start at an offset so reviewers tend to differ from the
 * family whose work they review.
 */
export function workflowRouteRotation(
  available: readonly WorkflowRoute[],
  kind: WorkflowStepKind
): WorkflowRoute[] {
  const ordered = WORKFLOW_ROUTES.filter(
    (route) => !localWorkflowRouteNamesModel(route) && available.includes(route)
  )
  const eligible = workflowKindJudges(kind)
    ? ordered.filter((route) => workflowRouteMayJudge(route))
    : ordered
  return eligible.length ? eligible : ['claude']
}
