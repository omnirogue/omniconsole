import type { ConsoleLocalExecutionView } from '../../../shared/console-local-execution'
import type { ConsoleJobRecord } from '../../../shared/console-workflow-types'

export type WorkflowJobRow = {
  id: string
  workflowId: string | undefined
  job: ConsoleJobRecord | undefined
  execution: ConsoleLocalExecutionView | undefined
}

export function workflowJobRows(
  jobs: ConsoleJobRecord[],
  executions: ConsoleLocalExecutionView[],
  taskId: string | null
): WorkflowJobRow[] {
  const local = executions.filter((execution) => !taskId || execution.cardId === taskId)
  const byJob = new Map(local.map((execution) => [execution.jobId, execution]))
  const workflowIds = new Set(local.map((execution) => execution.workflowId))
  const rows = jobs.flatMap((job): WorkflowJobRow[] => {
    const execution = byJob.get(job.id)
    const workflow = job.policy.workflow
    const workflowId = workflow?.workflow_id ?? workflow?.dispatch_id ?? execution?.workflowId
    const included = taskId
      ? job.task_id === taskId
      : execution || (workflowId && workflowIds.has(workflowId))
    return included ? [{ id: job.id, workflowId, job, execution }] : []
  })
  const visible = new Set(rows.map((row) => row.id))
  return [
    ...rows,
    ...local
      .filter((execution) => !visible.has(execution.jobId))
      .map((execution) => ({
        id: execution.jobId,
        workflowId: execution.workflowId,
        job: undefined,
        execution
      }))
  ]
}
