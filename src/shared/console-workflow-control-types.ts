import type { ConsoleWorkflowProgress } from './console-workflow-types'

/** A workflow-wide cancel: stages ended now, stages awaiting their fleet machine, and those already over. */
export type ConsoleWorkflowCancellation = ConsoleWorkflowProgress & {
  cancelled: string[]
  cancel_requested: string[]
  already_cancelled: string[]
  finished: string[]
  refused: { job_id: string; code: string; message: string }[]
}

/** The stage a cancel or retry acted on; the workflow read carries its full projection. */
export type ConsoleWorkflowJobControl = {
  job: { id: string; status: string }
  cancel_requested?: boolean
  already_cancelled?: boolean
}
