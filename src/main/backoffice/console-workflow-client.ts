import {
  attachJiraSession,
  listJiraSessionTasks,
  readJiraSessionTask,
  readJiraSessionConfig
} from './console-jira-session'
import { missing, readConsoleWorkflowCapabilities } from './console-workflow-capabilities'
import {
  beginFleetAdmission,
  readFleetReceipts,
  durableFleetAdmission,
  observeDurableFleetWorkflow
} from './console-fleet-durability'
import { consoleCalendarClient } from './console-calendar-client'
import { consolePeerActions } from './console-peer-actions'
import { readConsoleTaskDetails, updateConsoleTaskDetails } from './console-task-details'
import { consoleWorkHomeClient } from './console-work-home-client'
import { consoleTaskDependenciesClient } from './console-task-dependencies-client'
import {
  unavailable,
  validated,
  requestConsoleWorkflow as request
} from './console-workflow-transport'
import {
  admitRequest,
  classifyRequest,
  decisionRequest,
  bulkDismissRequest,
  previewRequest,
  workflowRequest,
  jobRequest,
  jobsRequest,
  jobEventsRequest,
  taskRequest,
  taskUpdateRequest,
  taskCompletionRequest
} from '../../shared/console-workflow-schemas'
import type { ConsoleWorkflowApi } from '../../shared/console-workflow-types'
import { handoffQuestionDecideRequest } from '../../shared/console-handoff-question'
export { publishConsoleExecutionObservation } from './console-workflow-publication'
export {
  getConsolePublicationPrincipal,
  sanitizeConsoleWorkflowText
} from './console-workflow-person'
import {
  humanActions,
  workflowAdmission,
  workflowClassification,
  workflowDecision,
  decisionsBulkDismiss,
  handoffQuestionDecision,
  workflowPreview,
  workflowProgress,
  workflowTemplates
} from './console-workflow-responses'
import { jobRecord, jobList, jobEvents, taskMutation } from './console-workflow-records'
import {
  attachConsoleSession,
  ingestConsoleSession,
  readConsoleTaskCard,
  readConsoleSessionTaskContext,
  readConsoleTaskSessions
} from './console-session-task'
import { readTaskConversations } from './console-task-conversations'
import { admitConsoleTask, previewConsoleTask } from './console-workflow-task-admission'
import { transitionConsoleTask } from './console-task-transition'
import { readConsoleWorkflowEventPage } from './console-workflow-event-page'
import { readConsoleJobResults } from './console-job-results-client'
import { consoleWorkflowControlClient } from './console-workflow-control-client'

import {
  readConsoleConversationFleetInventory,
  readConsoleConversationFleetTaskContext,
  previewConsoleConversationFleetTask,
  admitRetainedFleetTask,
  hasReviewedFleetAdmission
} from './console-conversation-fleet-client'
import {
  readConsoleJobLog,
  readConsoleJobEvidence,
  readConsoleFleetJobEventPage
} from './console-job-evidence-client'

export const consoleWorkflowClient: ConsoleWorkflowApi = {
  jiraSessionConfig: readJiraSessionConfig,
  jiraSessionTasks: listJiraSessionTasks,
  jiraSessionTask: readJiraSessionTask,
  attachJiraSession,
  readJobResults: readConsoleJobResults,
  fleetInventory: readConsoleConversationFleetInventory,
  fleetTaskContext: readConsoleConversationFleetTaskContext,
  previewFleetTask: previewConsoleConversationFleetTask,
  readFleetReceipts: (legacy, scope) =>
    readFleetReceipts(
      legacy,
      (workflowId) => consoleWorkflowClient.getWorkflow({ workflowId }),
      scope ?? '',
      (request) => consoleWorkflowClient.admitFleetTask(request)
    ),
  beginFleetAdmission: (receipt, scope) =>
    hasReviewedFleetAdmission(receipt.intent?.request)
      ? beginFleetAdmission(receipt, scope ?? '')
      : unavailable('a current reviewed fleet admission'),
  admitFleetTask: (args) =>
    durableFleetAdmission(
      args,
      (isCurrent) => admitRetainedFleetTask(args, isCurrent),
      (isCurrent) => admitRetainedFleetTask(args, isCurrent, true)
    ),
  readJobLog: readConsoleJobLog,
  readJobEvidence: readConsoleJobEvidence,
  ...consoleWorkHomeClient,
  ...consoleCalendarClient,
  ...consoleTaskDependenciesClient,
  ...consolePeerActions,
  ...consoleWorkflowControlClient,
  capabilities: readConsoleWorkflowCapabilities,
  inventory: () => unavailable(missing.inventory),
  presets: () => unavailable(missing.presets),
  templates: () => request('/api/gtd/hub/api/workflow-templates', 'GET', workflowTemplates),
  classify: (args) =>
    validated(args, classifyRequest, (body) =>
      request('/api/gtd/classify', 'POST', workflowClassification, body, 100_000)
    ),
  preview: (args) =>
    validated(args, previewRequest, (body) =>
      request('/api/gtd/workflow-graphs/preview', 'POST', workflowPreview, body, 15_000, true)
    ),
  admit: (args) =>
    validated(args, admitRequest, (body) =>
      request('/api/gtd/workflow-graphs/admit', 'POST', workflowAdmission, body)
    ),
  getWorkflow: (args) =>
    validated(args, workflowRequest, ({ workflowId }) =>
      observeDurableFleetWorkflow(() =>
        request(`/api/gtd/workflow-graphs/${workflowId}`, 'GET', workflowProgress)
      )
    ),
  listHumanActions: () => request('/api/gtd/workflow-actions', 'GET', humanActions),
  decideHumanAction: (args) =>
    validated(args, decisionRequest, ({ jobId, decision, note }) =>
      request(`/api/gtd/workflow-jobs/${jobId}/decision`, 'POST', workflowDecision, {
        decision,
        note
      })
    ),
  ingestSession: (args) => ingestConsoleSession(args),
  attachSession: (args) => attachConsoleSession(args),
  sessionTaskContext: (args) => readConsoleSessionTaskContext(args),
  taskCard: (args) => readConsoleTaskCard(args),
  taskSessions: (args) => readConsoleTaskSessions(args),
  taskConversations: (args) => readTaskConversations(args),
  dismissMachineDecisions: (args) =>
    validated(args, bulkDismissRequest, ({ dryRun, note }) =>
      request('/api/gtd/hub/api/decisions/bulk-dismiss', 'POST', decisionsBulkDismiss, {
        scope: 'machine',
        dry_run: dryRun,
        ...(note ? { note } : {})
      })
    ),
  decideHandoffQuestion: (args) =>
    validated(args, handoffQuestionDecideRequest, ({ decisionId, action, value, note }) =>
      request(`/api/gtd/hub/api/decisions/${decisionId}/decide`, 'POST', handoffQuestionDecision, {
        action,
        ...(value !== undefined ? { params: { value } } : {}),
        ...(note ? { note } : {})
      })
    ),
  getJob: (args) =>
    validated(args, jobRequest, ({ jobId }) =>
      request(
        `/api/gtd/jobs/${jobId}`,
        'GET',
        jobRecord.refine((job) => job.id === jobId)
      )
    ),
  listJobs: (args) =>
    validated(args, jobsRequest, ({ taskId, conversationSource }) => {
      const query = new URLSearchParams()
      if (taskId) {
        query.set('task', taskId)
      }
      if (conversationSource) {
        query.set('conversation_source', 'true')
      }
      return request(`/api/gtd/jobs${query.size ? `?${query}` : ''}`, 'GET', jobList)
    }),
  listJobEvents: (args) =>
    validated(args, jobEventsRequest, ({ jobId, limit, eventId, after, placement }) => {
      if (after !== undefined) {
        if (placement === 'fleet') {
          return readConsoleFleetJobEventPage(jobId, after, limit)
        }
        return readConsoleWorkflowEventPage(jobId, after, limit)
      }
      const query = new URLSearchParams()
      if (limit !== undefined) {
        query.set('limit', String(limit))
      }
      if (eventId !== undefined) {
        query.set('event_id', String(eventId))
      }
      return request(
        `/api/gtd/jobs/${jobId}/events${query.size ? `?${query}` : ''}`,
        'GET',
        jobEvents.refine((value) => value.job_id === jobId)
      )
    }),
  getTask: (args) => validated(args, taskRequest, ({ taskId }) => readConsoleTaskDetails(taskId)),
  updateTask: (args) =>
    validated(args, taskUpdateRequest, (input) => {
      const { taskId, expectedRevision, nextAction, blockedReason, tags } = input
      if (
        [
          'title',
          'description',
          'acceptanceCriteria',
          'taskPlan',
          'dueDate',
          'priority',
          'sequentialSteps'
        ].some((field) => field in input)
      ) {
        if (nextAction !== undefined || blockedReason !== undefined || tags !== undefined) {
          return Promise.resolve({
            ok: false as const,
            error: {
              code: 'invalid_request',
              message: 'Save task details separately from execution actions.'
            }
          })
        }
        return updateConsoleTaskDetails(input)
      }
      return request(`/api/collab/board/${taskId}`, 'PATCH', taskMutation, {
        expected_revision: expectedRevision,
        ...(nextAction ? { next_action: nextAction } : {}),
        ...(blockedReason ? { status: 'blocked', blocked_reason: blockedReason } : {}),
        ...(tags ? { tags } : {})
      })
    }),
  requestCompletion: (args) =>
    validated(args, taskCompletionRequest, ({ taskId, expectedRevision }) =>
      request(`/api/collab/board/${taskId}`, 'PATCH', taskMutation, {
        expected_revision: expectedRevision,
        status: 'done'
      })
    ),
  transitionTask: transitionConsoleTask,
  previewTask: previewConsoleTask,
  admitTask: admitConsoleTask,
  saveReviewSet: () => unavailable(missing.saveReviewSet),
  saveChain: () => unavailable(missing.saveChain),
  listEvents: () => unavailable(missing.listEvents),
  redraft: () => unavailable(missing.redraft),
  saveTemplate: () => unavailable(missing.saveTemplate),
  exportWorkflow: () => unavailable(missing.exportWorkflow)
}
