import type { z } from 'zod'
import type {
  jiraSessionAttach,
  jiraSessionSource,
  jiraTaskSearch,
  jiraSessionTasks,
  jiraSessionConfig
} from './console-jira-session-contract'
import type {
  ConversationFleetReceipt,
  StoredConversationFleetReceipt
} from './conversation-fleet-receipt'
import type { ConsoleCalendarApi } from './console-calendar-contract'
import type { PeerActionApi } from './peer-action-contract'
import type { TaskDetailsPatch } from './task-details'
import type { TaskLifecycleAction } from './console-task-lifecycle'
import type {
  TaskDependencyAddRequest,
  TaskDependencyEdge,
  TaskDependencyGraph,
  TaskDependencyRemoveRequest
} from './task-dependencies-contract'
import type {
  WorkBoard,
  WorkEvent,
  WorkLifecycle,
  WorkSessions
} from './console-work-home-contract'
import type {
  ConsoleWorkflowResult,
  ConsoleWorkflowInventory,
  ConsoleWorkflowTemplate,
  ConsoleWorkflowJson,
  ConsoleWorkflowClassifyRequest,
  ConsoleWorkflowPreviewRequest,
  ConsoleWorkflowPreview,
  ConsoleWorkflowAdmitRequest,
  ConsoleWorkflowAdmission,
  ConsoleWorkflowProgress,
  ConsoleWorkflowJob,
  ConsoleWorkflowDecisionRequest,
  ConsoleWorkflowDecision,
  ConsoleDecisionsBulkDismissRequest,
  ConsoleDecisionsBulkDismiss,
  ConsoleSessionAttachRequest,
  ConsoleSessionTaskContextRequest,
  ConsoleSessionAttachResult,
  ConsoleSessionIngestRequest,
  ConsoleSessionRecord,
  ConsoleTaskCard,
  ConsoleTaskSession,
  TaskConversation
} from './console-workflow-types'
import type {
  ConsoleJobRecord,
  ConsoleJobEvent,
  ConsoleTaskRecord,
  ConsoleTaskPreviewRequest,
  ConsoleTaskAdmitRequest
} from './console-workflow-task-types'

import type {
  ConsoleConversationFleetAdmitRequest,
  ConsoleConversationFleetInventory,
  ConsoleConversationFleetPreview,
  ConsoleConversationFleetPreviewRequest,
  ConsoleConversationFleetTaskContext
} from './console-conversation-fleet-types'
import type {
  ConsoleJobLog,
  ConsoleJobEvidencePage,
  ConsoleJobLogRequest,
  ConsoleJobEvidenceRequest
} from './console-job-evidence'
import type { ConsoleJobResults, ConsoleJobResultsRequest } from './console-job-results'
import type {
  ConsoleHandoffQuestionDecideRequest,
  ConsoleHandoffQuestionDecision
} from './console-handoff-question'
import type {
  ConsoleWorkflowCancellation,
  ConsoleWorkflowJobControl
} from './console-workflow-control-types'

export type ConsoleWorkflowCapability = { available: boolean; reason?: string }
export type ConsoleWorkflowCapabilities = Record<
  keyof Omit<ConsoleWorkflowApi, 'capabilities'>,
  ConsoleWorkflowCapability
>

export type ConsoleWorkflowApi = PeerActionApi &
  ConsoleCalendarApi & {
    jiraSessionConfig?(): Promise<ConsoleWorkflowResult<z.infer<typeof jiraSessionConfig>>>
    jiraSessionTasks?(
      request: z.infer<typeof jiraTaskSearch>
    ): Promise<ConsoleWorkflowResult<z.infer<typeof jiraSessionTasks>>>
    jiraSessionTask?(
      request: z.infer<typeof jiraSessionSource>
    ): Promise<ConsoleWorkflowResult<ConsoleSessionAttachResult>>
    attachJiraSession?(
      request: z.infer<typeof jiraSessionAttach>
    ): Promise<ConsoleWorkflowResult<ConsoleSessionAttachResult>>
    readFleetReceipts?(
      legacy: ConversationFleetReceipt[],
      scope: string
    ): Promise<ConsoleWorkflowResult<StoredConversationFleetReceipt[]>>
    beginFleetAdmission?(
      receipt: ConversationFleetReceipt,
      scope: string
    ): Promise<ConsoleWorkflowResult<boolean>>
    readJobResults(
      request: ConsoleJobResultsRequest
    ): Promise<ConsoleWorkflowResult<ConsoleJobResults>>
    fleetInventory(): Promise<ConsoleWorkflowResult<ConsoleConversationFleetInventory>>
    fleetTaskContext(request: {
      taskId: string
    }): Promise<ConsoleWorkflowResult<ConsoleConversationFleetTaskContext>>
    previewFleetTask(
      request: ConsoleConversationFleetPreviewRequest
    ): Promise<ConsoleWorkflowResult<ConsoleConversationFleetPreview>>
    admitFleetTask(
      request: ConsoleConversationFleetAdmitRequest
    ): Promise<ConsoleWorkflowResult<ConsoleWorkflowAdmission>>
    readJobLog(request: ConsoleJobLogRequest): Promise<ConsoleWorkflowResult<ConsoleJobLog>>
    readJobEvidence(
      request: ConsoleJobEvidenceRequest
    ): Promise<ConsoleWorkflowResult<ConsoleJobEvidencePage>>
    attachWorkSession(request: {
      sessionId: string
      taskId: string
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson>>
    listWork(): Promise<ConsoleWorkflowResult<WorkBoard>>
    listTaskActivity(request: { taskId: string }): Promise<ConsoleWorkflowResult<WorkEvent[]>>
    addTaskNote(request: {
      taskId: string
      note: string
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson>>
    getTaskLifecycle(request: { taskId: string }): Promise<ConsoleWorkflowResult<WorkLifecycle>>
    listWorkSessions(): Promise<ConsoleWorkflowResult<WorkSessions>>
    capabilities(): Promise<ConsoleWorkflowResult<ConsoleWorkflowCapabilities>>
    inventory(): Promise<ConsoleWorkflowResult<ConsoleWorkflowInventory>>
    templates(): Promise<ConsoleWorkflowResult<ConsoleWorkflowTemplate[]>>
    presets(): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson[]>>
    classify(
      request: ConsoleWorkflowClassifyRequest
    ): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson>>
    preview(
      request: ConsoleWorkflowPreviewRequest
    ): Promise<ConsoleWorkflowResult<ConsoleWorkflowPreview>>
    admit(
      request: ConsoleWorkflowAdmitRequest
    ): Promise<ConsoleWorkflowResult<ConsoleWorkflowAdmission>>
    getWorkflow(request: {
      workflowId: string
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowProgress>>
    /** Stop every unfinished stage of a workflow the signed person admitted; finished stages stay. */
    cancelWorkflow(request: {
      workflowId: string
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowCancellation>>
    cancelJob(request: { jobId: string }): Promise<ConsoleWorkflowResult<ConsoleWorkflowJobControl>>
    /** Queue one failed or cancelled stage again; the hub still admits its next attempt. */
    retryJob(request: { jobId: string }): Promise<ConsoleWorkflowResult<ConsoleWorkflowJobControl>>
    listHumanActions(): Promise<ConsoleWorkflowResult<{ jobs: ConsoleWorkflowJob[] }>>
    decideHumanAction(
      request: ConsoleWorkflowDecisionRequest
    ): Promise<ConsoleWorkflowResult<ConsoleWorkflowDecision>>
    /** A conversation reports itself to the hub so a task can hold it. */
    ingestSession(
      request: ConsoleSessionIngestRequest
    ): Promise<ConsoleWorkflowResult<ConsoleSessionRecord>>
    /** The durable link: this session serves that task. */
    attachSession(
      request: ConsoleSessionAttachRequest
    ): Promise<ConsoleWorkflowResult<ConsoleSessionAttachResult>>
    sessionTaskContext(
      request: ConsoleSessionTaskContextRequest
    ): Promise<ConsoleWorkflowResult<ConsoleSessionAttachResult>>
    /** One task, read whole. */
    taskCard(request: { taskId: string }): Promise<ConsoleWorkflowResult<ConsoleTaskCard>>
    /** Every session that has worked one task. */
    taskSessions(request: {
      taskId: string
    }): Promise<ConsoleWorkflowResult<{ sessions: ConsoleTaskSession[] }>>
    /** Every IDE conversation "Add to a task" stamped onto this card, from the session ledger. */
    taskConversations(request: {
      taskId: string
    }): Promise<ConsoleWorkflowResult<{ rows: TaskConversation[]; overflow: number }>>
    /** Dismiss every machine-generated decision in the signed-in person's queue; dryRun only counts. */
    dismissMachineDecisions(
      request: ConsoleDecisionsBulkDismissRequest
    ): Promise<ConsoleWorkflowResult<ConsoleDecisionsBulkDismiss>>
    /** Answer an agent's handoff question, or say it is not needed: the one write that clears it. */
    decideHandoffQuestion(
      request: ConsoleHandoffQuestionDecideRequest
    ): Promise<ConsoleWorkflowResult<ConsoleHandoffQuestionDecision>>
    previewTask(
      request: ConsoleTaskPreviewRequest
    ): Promise<ConsoleWorkflowResult<ConsoleWorkflowPreview>>
    admitTask(
      request: ConsoleTaskAdmitRequest
    ): Promise<ConsoleWorkflowResult<ConsoleWorkflowAdmission>>
    listJobs(request: { taskId?: string; conversationSource?: boolean }): Promise<
      ConsoleWorkflowResult<{
        jobs: ConsoleJobRecord[]
        conversation_source_scope?: 'directing_person'
      }>
    >
    listJobEvents(request: {
      jobId: string
      limit?: number
      eventId?: number
      after?: number
      placement?: 'local' | 'fleet'
    }): Promise<
      ConsoleWorkflowResult<{
        job_id: string
        events: ConsoleJobEvent[]
        next_after?: number
        has_more?: boolean
      }>
    >
    getTask(request: { taskId: string }): Promise<ConsoleWorkflowResult<ConsoleTaskRecord>>
    requestCompletion(request: {
      taskId: string
      expectedRevision: number
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson>>
    saveReviewSet(request: {
      workflowId: string
      name: string
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson>>
    saveChain(request: {
      workflowId: string
      name: string
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson>>
    getJob(request: { jobId: string }): Promise<ConsoleWorkflowResult<ConsoleJobRecord>>
    listEvents(request: {
      workflowId: string
      cursor?: string
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson[]>>
    redraft(request: {
      workflowId: string
      instruction: string
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowPreview>>
    saveTemplate(request: {
      workflowId: string
      name: string
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowTemplate>>
    exportWorkflow(request: {
      workflowId: string
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson>>
    updateTask(
      request: TaskDetailsPatch & {
        taskId: string
        expectedRevision: number
        nextAction?: string
        blockedReason?: string
        /** The card's whole tag list; the hub replaces it (`proposed`, `company:<slug>`, …). */
        tags?: string[]
      }
    ): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson>>
    /** Lane G: what this task waits on and what waits on it, each edge with its hub-derived state. */
    listTaskDependencies(request: {
      taskId: string
    }): Promise<ConsoleWorkflowResult<TaskDependencyGraph>>
    addTaskDependency(
      request: TaskDependencyAddRequest
    ): Promise<ConsoleWorkflowResult<TaskDependencyEdge>>
    removeTaskDependency(
      request: TaskDependencyRemoveRequest
    ): Promise<ConsoleWorkflowResult<{ removed: boolean }>>
    /** Move a card along the hub's canonical rail; completion keeps its own gated path. */
    transitionTask(request: {
      taskId: string
      action: TaskLifecycleAction
      expectedRevision: number
      nextAction?: string
      reason?: string
      resultRef?: string
      waitingOn?: string
      followUpAt?: string
      deferUntil?: string
    }): Promise<ConsoleWorkflowResult<ConsoleWorkflowJson>>
  }
