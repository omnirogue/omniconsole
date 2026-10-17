import { translate } from '@/i18n/i18n'
import { localWorkflowProviderLabel } from '../../../../shared/local-workflow-model-label'
import {
  streamedLocalWorkflowCatalog,
  type LocalWorkflowSeatCatalog,
  type LocalWorkflowSeatChoice
} from '../../../../shared/local-workflow-seats'
import { WORKFLOW_ROUTES } from '../../../../shared/workflow-graph'

/** Each model family a workflow cannot use here, with the host's own reason. */
export function workflowUnavailableRoutes(
  catalog: readonly LocalWorkflowSeatCatalog[],
  team: readonly LocalWorkflowSeatChoice[]
): { label: string; reason: string }[] {
  const streamed = streamedLocalWorkflowCatalog(catalog)
  return WORKFLOW_ROUTES.filter((route) => !team.some((seat) => seat.agent === route)).map(
    (route) => ({
      label: localWorkflowProviderLabel(route),
      reason:
        streamed.find((entry) => entry.agent === route && entry.unavailableReason)
          ?.unavailableReason ??
        translate('localWorkflow.setup.routeNotSetUp', 'Not set up on this computer.')
    })
  )
}

/**
 * Why a family is missing from the workflow's agents. Without it a family the host rejected
 * (an old CLI, a missing key) simply vanished from every picker. Mount it only for a catalog the
 * host answered: an unanswered one says nothing about any family.
 */
export function WorkflowUnavailableRoutes({
  catalog,
  team
}: {
  catalog: readonly LocalWorkflowSeatCatalog[]
  team: readonly LocalWorkflowSeatChoice[]
}) {
  const missing = workflowUnavailableRoutes(catalog, team)
  if (!missing.length) {
    return null
  }
  return (
    <ul className="space-y-0.5 px-1 text-xs text-muted-foreground">
      {missing.map((entry) => (
        <li key={entry.label}>
          {translate(
            'localWorkflow.setup.routeUnavailable',
            '{{label}} is not available: {{reason}}',
            {
              label: entry.label,
              reason: entry.reason
            }
          )}
        </li>
      ))}
    </ul>
  )
}
