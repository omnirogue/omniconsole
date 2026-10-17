import type { ConsoleWorkflowApi } from '../../shared/console-workflow-api'
import { taskTransitionRequest } from '../../shared/console-task-lifecycle'
import { taskLifecycleResult } from './console-workflow-records'
import { requestConsoleWorkflow as request, validated } from './console-workflow-transport'

export const transitionConsoleTask: ConsoleWorkflowApi['transitionTask'] = (args) =>
  validated(args, taskTransitionRequest, (input) =>
    // Why not `taskMutation`: the lifecycle verb answers with the moved card, not an `ok` flag.
    request(`/api/collab/board/${input.taskId}/lifecycle`, 'POST', taskLifecycleResult, {
      action: input.action,
      expected_revision: input.expectedRevision,
      ...(input.nextAction ? { next_action: input.nextAction } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.resultRef ? { result_ref: input.resultRef } : {}),
      ...(input.waitingOn ? { waiting_on: input.waitingOn } : {}),
      ...(input.followUpAt ? { follow_up_at: input.followUpAt } : {}),
      ...(input.deferUntil ? { defer_until: input.deferUntil } : {})
    })
  )
