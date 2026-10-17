import type { TaskDependencySummary } from './task-dependencies-contract'
import type { TaskPlan } from './task-details'
import type {
  ConsoleJobArtifactReceipt,
  ConsolePersonHandoffDelivery,
  ConsolePersonHandoffStatus
} from './console-job-results'
import type {
  ConsoleWorkflowClassification,
  ConsoleWorkflowActor,
  ConsoleWorkflowGraph,
  ConsoleWorkflowJob,
  ConsoleWorkflowJson,
  ConsoleWorkflowObjective
} from './console-workflow-types'

export type ConsoleTaskPreviewRequest = {
  taskId: string
  expectedRevision: number
  placement: 'local' | 'fleet'
  prompt: string
  templateId?: string
  presetId?: string
  classification: ConsoleWorkflowClassification
}
export type ConsoleTaskAdmissionContext = {
  objective: ConsoleWorkflowObjective
  orgUnitId: string
  expectedAuthorityEpoch: number
  adoptStage: string
}
export type ConsoleTaskAdmitRequest = ConsoleTaskAdmissionContext & {
  taskId: string
  expectedRevision: number
  placement: 'local' | 'fleet'
  graph: ConsoleWorkflowGraph
  digest: string
}

/** Stored job read: computed workflow eligibility is supplied only by the graph projection. */
export type ConsoleJobRecord = {
  id: string
  task_id: string
  title: string
  status: string
  brief?: string
  acceptance?: string
  repo?: string | null
  base_branch?: string | null
  branch?: string | null
  machine?: string | null
  provider?: string | null
  model?: string | null
  effort?: string | null
  actor_type?: ConsoleWorkflowActor
  attempt?: number
  lease_generation?: number
  owned_paths?: string[] | null
  pr_url?: string | null
  output_tail?: string | null
  last_error?: string | null
  updated_at?: string | null
  execution_artifacts?: ConsoleJobArtifactReceipt[]
  policy: {
    workflow?: ConsoleWorkflowJob['policy']['workflow']
    human_result?: Record<string, ConsoleWorkflowJson>
    person_handoff_delivery?: ConsolePersonHandoffDelivery
    person_handoff_status?: ConsolePersonHandoffStatus
  }
  events?: ConsoleJobEvent[]
}
export type ConsoleJobEvent = {
  id: number
  job_id: string
  kind: string
  detail: Record<string, ConsoleWorkflowJson>
  created_at: string
  machine?: string | null
}
export type ConsoleTaskRecord = {
  /** Main-issued identity fence for later file uploads; never read from the Hub response. */
  publicationPrincipal?: string
  kanban_status?: string | null
  kanban_reason?: string | null
  kanban_disposition?: string | null
  kanban_eligible?: boolean | null
  parent_task_id?: string | null
  verified_at?: string | null
  verification_failed_at?: string | null
  id: string
  title: string
  status: string
  state_revision?: number | null
  next_action?: string | null
  owner_employee_id?: string | null
  acceptance_criteria?: string | null
  current_contract_id?: string | null
  /** The card as a reader sees it (Open task on a handoff for somebody else's card). */
  description?: string | null
  sequential_steps?: string[]
  task_plan?: TaskPlan | null
  due_date?: string | null
  company_slug?: string | null
  priority?: string | null
  requester_employee_id?: string | null
  blocked_reason?: string | null
  result_ref?: string | null
  tags?: string[] | null
  created_at?: string | null
  updated_at?: string | null
  /** Lane G: counts of this task's dependency edges by state; absent from an older hub. */
  dependency_summary?: TaskDependencySummary | null
}
