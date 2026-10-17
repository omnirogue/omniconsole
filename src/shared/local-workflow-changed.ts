import type { LocalWorkflowChangedEvent } from './local-workflow-rpc'
import type { LocalWorkflowView } from './local-workflow-view'

/** Main → renderer window channel carrying `LocalWorkflowChangedEvent`. */
export const LOCAL_WORKFLOW_CHANGED_CHANNEL = 'localWorkflow:changed'

/** The small status a tab strip or sidebar row needs, derived from one projected view. */
export function localWorkflowChangedEvent(
  view: LocalWorkflowView,
  conversationId: string
): LocalWorkflowChangedEvent {
  const planned = view.stages.reduce((sum, stage) => sum + (stage.total ?? 0), 0)
  return {
    conversationId,
    executionId: view.executionId,
    preset: view.preset,
    state: view.state,
    running: view.calls.filter((call) => call.state === 'running').length,
    completed: view.calls.filter((call) => call.state === 'completed').length,
    total: Math.max(view.calls.length, planned),
    ...(view.phase ? { phase: view.phase } : {}),
    ...(view.placement?.host ? { host: view.placement.host.name } : {}),
    ...(view.placement?.mode === 'dispatched-seats' && view.placement.host?.ssh
      ? { sshHost: view.placement.host.ssh }
      : {}),
    ...(view.requestedBy ? { requestedBy: view.requestedBy } : {}),
    ...(view.requestedById ? { requestedById: view.requestedById } : {})
  }
}
