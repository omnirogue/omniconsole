import type { z } from 'zod'
import type { sessionOutcomeCurrentSource } from './session-outcome-current-inputs'
import type {
  ConsoleWorkflowMode,
  ConsoleWorkflowActor,
  ConsoleWorkflowAction,
  ConsoleWorkflowJson,
  ConsoleWorkflowNodeWorkspace
} from './console-workflow-types'
import type { ConsoleConversationFleetSourceFile } from './console-conversation-fleet-types'
import type { ConsoleWorkflowMechanicalExecution } from './console-workflow-mechanical-execution'
import type {
  ConsoleConversationHandoffReport,
  ConsoleConversationHandoffOutput
} from './console-conversation-handoff-report'
import type { ConsoleConversationPersonHandoff } from './console-conversation-person-handoff'
import type {
  ConsolePersonHandoffDelivery,
  ConsolePersonHandoffStatus
} from './console-job-results'

export type ConsoleWorkflowJobPolicy = {
  workflow: {
    version: 1
    digest: string
    mode: ConsoleWorkflowMode
    dispatch_id: string
    workflow_id?: string
    placement?: 'local' | 'fleet'
    key: string
    actor_type: ConsoleWorkflowActor
    actor_id: string
    openrouter_candidates?: string[]
    action: ConsoleWorkflowAction
    after: string[]
    after_keys: string[]
    require_merged: string[]
    require_merged_keys?: string[]
    approval_ancestors: string[]
    loop?: Record<string, ConsoleWorkflowJson>
    current_source?: z.infer<typeof sessionOutcomeCurrentSource>
    loop_stage?: Record<string, ConsoleWorkflowJson>
    hub_projection?: Record<string, ConsoleWorkflowJson>
    owned_paths?: string[]
    skipped?: string
    machine?: string
    workspace?: ConsoleWorkflowNodeWorkspace
    base_sha?: string
    source?: Record<string, ConsoleWorkflowJson>
    source_task_id?: string
    source_files?: ConsoleConversationFleetSourceFile[]
    source_deletions?: string[]
    source_overlay?: boolean
    person_handoff?: ConsoleConversationPersonHandoff
    mechanical_execution?: ConsoleWorkflowMechanicalExecution
    handoff_report?: ConsoleConversationHandoffReport
    output_artifacts?: ConsoleConversationHandoffOutput[]
  }
  human_result?: Record<string, ConsoleWorkflowJson>
  person_handoff_delivery?: ConsolePersonHandoffDelivery
  person_handoff_status?: ConsolePersonHandoffStatus
}
