import type {
  ConsoleWorkflowClassification,
  ConsoleWorkflowGraph,
  ConsoleWorkflowInventory,
  ConsoleWorkflowPreview
} from './console-workflow-types'
import type { FleetAccountUsageReceipt } from './fleet-account-usage'

export type ConsoleConversationFleetMachine = {
  host: string
  allowed: boolean
  ready: boolean
  last_beat: string | null
  slots: number
  running: number
  /**
   * Runner heartbeat health. Every field is optional: a console that does not report it yet
   * sends nothing, and the desktop must show the machine without inventing a number.
   */
  cores?: number | null
  load1?: number | null
  /** The runner's own load-to-cores ratio when it reports one; otherwise derive it. */
  ratio?: number | null
  free_slots?: number | null
  mem_total_bytes?: number | null
  mem_used_bytes?: number | null
  execution_capabilities: {
    provider: string
    available: boolean
    models: string[]
    efforts: string[]
    resume: boolean
    readonly: boolean
    native_execution?: boolean
    native_verifier?: boolean
    pinned_task_inputs?: boolean
    source_snapshot?: boolean
    folder_workspace?: boolean
    retained_outputs?: boolean
    account_usage?: FleetAccountUsageReceipt | null
    reason?: string
  }[]
}

export type ConsoleConversationFleetInventory = ConsoleWorkflowInventory & {
  machines: ConsoleConversationFleetMachine[]
}

export type ConsoleConversationFleetFiling = {
  company_slug: string
  org_unit_id: string
  goal_id: string
}

export type ConsoleConversationFleetTaskContext = {
  ok: true
  task_id: string
  expected_revision: number
} & (
  | { supported: true; filing: ConsoleConversationFleetFiling; reason?: string }
  | {
      supported: false
      filing: { company_slug: string | null; org_unit_id: string | null; goal_id: string | null }
      reason: string
    }
)

export type ConsoleConversationFleetSource = {
  sessionRef: string
  sessionId?: string
  transcriptDigest?: string
  templateId?: string
  capturedAt?: string
}

export type ConsoleConversationFleetSourceFile = {
  kind: 'task_file'
  task_id: string
  file: { rel: string; name: string; sha256: string; size_bytes: number }
  target_path?: string
  executable?: boolean
}

export type ConsoleConversationFleetPreviewRequest = {
  taskId: string
  expectedRevision: number
  classification: ConsoleWorkflowClassification
  prompt: string
  fanoutAck: boolean
  source: ConsoleConversationFleetSource
  sourceFiles?: ConsoleConversationFleetSourceFile[]
  sourceDeletions?: string[]
  sourceSummaryFile?: ConsoleConversationFleetSourceFile
}

export type ConsoleConversationFleetPreview = ConsoleWorkflowPreview & {
  admission: {
    task_id: string
    expected_revision: number
    context_digest: string
    adopt_stage: string | null
  }
  filing: ConsoleConversationFleetFiling
  reviewer: { provider: string; model: string | null; effort: string | null }
}

export type ConsoleConversationFleetAdmitRequest = {
  taskId: string
  expectedRevision: number
  graph: ConsoleWorkflowGraph
  digest: string
  contextDigest: string
  adoptStage: string | null
}
