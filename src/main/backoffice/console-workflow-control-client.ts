import { fleetExecutionControlsAvailable } from '../../shared/fleet-execution-controls'
import {
  requestConsoleWorkflow as request,
  validated,
  unavailable
} from './console-workflow-transport'
import { jobRequest, workflowRequest } from '../../shared/console-workflow-schemas'
import { workflowCancellation, workflowJobControl } from './console-workflow-responses'
import type { ConsoleWorkflowApi } from '../../shared/console-workflow-types'

/** Cancel and retry for admitted workflow stages; the console decides who may, per signed person. */
export const consoleWorkflowControlClient: Pick<
  ConsoleWorkflowApi,
  'cancelWorkflow' | 'cancelJob' | 'retryJob'
> = {
  cancelWorkflow: (args) =>
    !fleetExecutionControlsAvailable
      ? unavailable('execution-host cancellation acknowledgement')
      : validated(args, workflowRequest, ({ workflowId }) =>
          request(
            `/api/gtd/workflow-graphs/${workflowId}/cancel`,
            'POST',
            workflowCancellation.refine((value) => value.workflow_id === workflowId),
            {}
          )
        ),
  cancelJob: (args) =>
    !fleetExecutionControlsAvailable
      ? unavailable('execution-host cancellation acknowledgement')
      : validated(args, jobRequest, ({ jobId }) =>
          request(
            `/api/gtd/workflow-jobs/${jobId}/cancel`,
            'POST',
            workflowJobControl.refine((value) => value.job.id === jobId),
            {}
          )
        ),
  retryJob: (args) =>
    !fleetExecutionControlsAvailable
      ? unavailable('execution-host retry fencing')
      : validated(args, jobRequest, ({ jobId }) =>
          request(
            `/api/gtd/workflow-jobs/${jobId}/retry`,
            'POST',
            workflowJobControl.refine((value) => value.job.id === jobId),
            {}
          )
        )
}
