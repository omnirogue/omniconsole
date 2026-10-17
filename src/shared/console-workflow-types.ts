import type { z } from 'zod'
import type { sessionOutcomeCurrentSource } from './session-outcome-current-inputs'
import type {
  ConsoleWorkflowFolderWorkspace,
  ConsoleWorkflowNodeWorkspace
} from './console-workflow-workspace'
export type {
  ConsoleWorkflowFolderWorkspace,
  ConsoleWorkflowNodeWorkspace
} from './console-workflow-workspace'
import type { ConsoleWorkflowAcceptanceCommand } from './console-workflow-acceptance'
import type { ConsoleTaskSetup } from './console-task-setup'
import type { ConsoleWorkflowMechanicalExecution } from './console-workflow-mechanical-execution'
import type {
  ConsoleConversationHandoffReport,
  ConsoleConversationHandoffOutput
} from './console-conversation-handoff-report'
import type { ConsoleJobArtifactReceipt } from './console-job-results'
import type { ConsoleWorkflowJobPolicy } from './console-workflow-job-policy-types'
import type { ConsoleConversationFleetSourceFile } from './console-conversation-fleet-types'
import type {
  ConsoleConversationPersonHandoff,
  ConsoleConversationPersonHandoffRequest
} from './console-conversation-person-handoff'

export type ConsoleWorkflowJson =
  | null
  | boolean
  | number
  | string
  | ConsoleWorkflowJson[]
  | { [key: string]: ConsoleWorkflowJson }

export type ConsoleWorkflowError = {
  code: string
  message: string
  status?: number
  /** Structured facts the console attached to a refusal (e.g. the stored `seq` on a 409). */
  details?: Record<string, unknown>
  taskSetup?: ConsoleTaskSetup
  launchDisposition?: 'not-started' | 'unverifiable'
}

export type ConsoleWorkflowResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ConsoleWorkflowError }

export type ConsoleWorkflowMode = 'single_shot' | 'sequential' | 'parallel' | 'hybrid'
export type ConsoleWorkflowActor = 'ai' | 'human' | 'mechanical'
export type ConsoleWorkflowAction =
  | 'execute'
  | 'review'
  | 'repair'
  | 'approve'
  | 'decide'
  | 'check'
  | 'notify'

export type ConsoleWorkflowStep = {
  handoff_report?: ConsoleConversationHandoffReport
  output_artifacts?: ConsoleConversationHandoffOutput[]
  person_handoff?: ConsoleConversationPersonHandoffRequest
  workspace?: ConsoleWorkflowFolderWorkspace
  key?: string
  title: string
  detail?: string | null
  brief?: string
  prompt?: string
  actor?: string | null
  actor_id?: string
  openrouter_candidates?: string[]
  actor_type?: ConsoleWorkflowActor
  action?: ConsoleWorkflowAction
  department?: string
  repo?: string
  placement?: 'local' | 'fleet'
  machine?: string
  base_branch?: string
  base_sha?: string
  effort?: string | null
  acceptance?: string
  acceptance_commands?: ConsoleWorkflowAcceptanceCommand[]
  timing?: 'now' | 'scheduled' | 'later'
  after?: string[]
  parallel_group?: string | null
  files?: string[]
  timeout_minutes?: number
  engineering?: Record<string, ConsoleWorkflowJson>
  loop?: {
    kind: 'gap' | 'review' | 'adversarial'
    participants: string[]
    participant_ids?: string[]
    participant_efforts?: Record<string, string | null>
    max_rounds: number
    stop_rule: 'all_gaps_closed' | 'zero_blockers' | 'max_rounds'
  } | null
}

export type ConsoleWorkflowClassification = {
  workspace?: ConsoleWorkflowFolderWorkspace
  title: string
  company_slug: string
  domain_id?: string | null
  repo?: string
  acceptance?: string
  execution_mode?: ConsoleWorkflowMode
  policy?: Record<string, ConsoleWorkflowJson>
  steps: ConsoleWorkflowStep[]
}

export type ConsoleWorkflowNode = {
  mechanical_execution?: ConsoleWorkflowMechanicalExecution
  handoff_report?: ConsoleConversationHandoffReport
  output_artifacts?: ConsoleConversationHandoffOutput[]
  person_handoff?: ConsoleConversationPersonHandoff
  workspace?: ConsoleWorkflowNodeWorkspace
  source_files?: ConsoleConversationFleetSourceFile[]
  source_deletions?: string[]
  source_overlay?: boolean
  key: string
  title: string
  brief: string
  actor_type: ConsoleWorkflowActor
  actor_id: string
  action: ConsoleWorkflowAction
  after: string[]
  owned_paths: string[] | null
  provider?: string
  model?: string
  openrouter_candidates?: string[]
  effort?: string | null
  repo?: string | null
  placement?: 'local' | 'fleet'
  machine?: string
  base_branch?: string | null
  base_sha?: string
  acceptance?: string
  acceptance_commands?: ConsoleWorkflowAcceptanceCommand[]
  department?: string
  agent?: string
  timing?: string
  timeout_minutes?: number
  loop?: Record<string, ConsoleWorkflowJson>
  loop_stage?: Record<string, ConsoleWorkflowJson>
  current_source?: z.infer<typeof sessionOutcomeCurrentSource>
  external_predecessor?: Record<string, ConsoleWorkflowJson>
  parallel_group?: string
}

export type ConsoleWorkflowGraph = {
  schema_version: 1
  mode: ConsoleWorkflowMode
  title: string
  prompt: string
  company: string
  owner: string
  policy: Record<string, ConsoleWorkflowJson>
  nodes: ConsoleWorkflowNode[]
  columns: string[][]
  dispatch_id: string
  digest: string
}

export type ConsoleWorkflowJob = {
  id: string
  task_id: string
  node_id: string | null
  title: string
  status: string
  actor_type: ConsoleWorkflowActor
  provider: string | null
  model: string | null
  effort: string | null
  repo: string | null
  machine: string | null
  pr_url: string | null
  attempt: number | null
  lease_generation: number | null
  owned_paths: string[] | null
  updated_at: string | null
  execution_artifacts?: ConsoleJobArtifactReceipt[]
  policy: ConsoleWorkflowJobPolicy
  blockers: string[]
  workflow_state: string
  can_decide: boolean
}

export type ConsoleWorkflowPreviewRequest = {
  classification: ConsoleWorkflowClassification
  prompt?: string
  draft?: string
  title?: string
}
export type ConsoleWorkflowPreview = {
  graph: ConsoleWorkflowGraph
  digest: string
  workflow_id: string
  jobs: ConsoleWorkflowJob[]
}
export type ConsoleWorkflowAdmitRequest = {
  filing_root_task_id?: string
  filing_root_expected_revision?: number
  graph: ConsoleWorkflowGraph
  digest: string
  card_id?: string
  expected_revision?: number
  adopt_stage?: string
  objective: ConsoleWorkflowObjective
  org_unit_id: string
  expected_authority_epoch: number
}
export type ConsoleWorkflowObjective = {
  goal_id: string
  title: string
  desired_result: string
  acceptance_policy: Record<string, ConsoleWorkflowJson>
  verification_policy: Record<string, ConsoleWorkflowJson>
}
export type ConsoleWorkflowProgress = {
  workflow_id: string
  jobs: ConsoleWorkflowJob[]
}
export type ConsoleWorkflowAdmission = ConsoleWorkflowProgress & {
  receipt: ConsoleWorkflowJson
}
/** What a conversation tells the hub about itself so a task can hold it. */
export type ConsoleSessionIngestRequest = {
  /** The desktop's own stable id for this conversation (its pane key). */
  sessionRef: string
  cwd: string
  provider: string
  title?: string
  model?: string
  description?: string
}
export type ConsoleSessionRecord = { sessionId: string }
export type ConsoleSessionAttachRequest = { sessionId: string; taskId: string }
export type { ConsoleSessionTaskContextRequest } from './console-session-task-binding'
export type {
  ConsoleTaskContextSnapshot,
  ConsoleSessionAttachResult
} from './console-session-task-context-types'
/** One task read whole, plus every session that has worked it. */
export type ConsoleTaskCard = {
  id: string
  title: string
  status: string | null
  ownerEmployeeId: string | null
  companySlug: string | null
  nextAction: string | null
  description: string | null
  dueDate: string | null
  updatedAt: string | null
  blocked: boolean
}
export type ConsoleTaskSession = {
  id: string
  title: string | null
  state: string | null
  model: string | null
  provider: string | null
  machineId: string | null
  startedAt: string | null
  updatedAt: string | null
}
export type { TaskConversation } from './console-task-conversation-types'
export type ConsoleDecisionsBulkDismissRequest = {
  dryRun: boolean
  note?: string
}
/** The hub's accounting for one bulk dismiss: what matched, what it closed, and by which noise class. */
export type ConsoleDecisionsBulkDismiss = {
  matched: number
  dismissed: number
  by_class: Record<string, number>
  dry_run: boolean
}
export type ConsoleWorkflowDecisionRequest = {
  jobId: string
  decision: 'approve' | 'reject' | 'complete'
  note: string
}
export type ConsoleWorkflowDecision = {
  job: ConsoleWorkflowJob
  duplicate?: boolean
  hub?: ConsoleWorkflowJson
}

export type {
  ConsoleWorkflowClassifyRequest,
  ConsoleWorkflowInventory,
  ConsoleWorkflowTemplate
} from './console-workflow-inventory-types'

export type {
  ConsoleJobClaim,
  ConsoleJobBinding,
  ConsoleExecutionObservation,
  ConsoleExecutionAck
} from './console-workflow-execution-types'
export type {
  ConsoleWorkflowApi,
  ConsoleWorkflowCapability,
  ConsoleWorkflowCapabilities
} from './console-workflow-api'
export type {
  ConsoleJobRecord,
  ConsoleJobEvent,
  ConsoleTaskRecord,
  ConsoleTaskPreviewRequest,
  ConsoleTaskAdmitRequest
} from './console-workflow-task-types'
