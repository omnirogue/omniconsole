import { localJobEvents } from './console-workflow-records'
import { requestConsoleWorkflow } from './console-workflow-transport'

export function readConsoleWorkflowEventPage(
  jobId: string,
  after: number,
  limit = 200,
  principal?: string
) {
  return requestConsoleWorkflow(
    `/api/gtd/workflow-jobs/${jobId}/events?after=${after}&limit=${limit}`,
    'GET',
    localJobEvents.refine(
      (value) =>
        value.job_id === jobId &&
        value.events.every(
          (event, index) =>
            event.job_id === jobId && event.id > (value.events[index - 1]?.id ?? after)
        ) &&
        value.next_after === (value.events.at(-1)?.id ?? after)
    ),
    undefined,
    15_000,
    false,
    principal
  )
}
