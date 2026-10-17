import type { ConsoleJiraWorkRef } from './console-jira-work-contract'
import type { ConsoleWorkflowJson } from './console-workflow-types'

export type ConsoleTaskContextSnapshot = {
  work_ref?: ConsoleJiraWorkRef
  card_id: string
  state_revision: number
  available: true
  status: 'ready' | 'degraded'
  context: string
  warnings: string[]
  scope: Record<string, ConsoleWorkflowJson> | null
  pack_version: string | number
  replies_waiting: ConsoleWorkflowJson[]
  dropped_blocks: ConsoleWorkflowJson[]
}

export type ConsoleSessionAttachResult = {
  ok: true
  workRef?: ConsoleJiraWorkRef
  title?: string
  sessionId?: string
  taskId?: string
  context?: ConsoleTaskContextSnapshot
  contextWarning?: string
}
