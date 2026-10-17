import { fleetExecutionControlsAvailable } from '../../shared/fleet-execution-controls'
import type {
  ConsoleWorkflowApi,
  ConsoleWorkflowCapabilities
} from '../../shared/console-workflow-types'

export const missing = {
  inventory: 'a client-readable executor inventory',
  presets: 'chain presets',
  listEvents: 'workflow event cursors',
  redraft: 'graph redrafting',
  saveTemplate: 'saving a graph as a canonical template',
  exportWorkflow: 'workflow export',
  saveReviewSet: 'saving canonical review sets',
  saveChain: 'saving canonical chains'
} as const
const supported = [
  'jiraSessionConfig',
  'jiraSessionTasks',
  'jiraSessionTask',
  'attachJiraSession',
  'readCommunicationMode',
  'postDiscussion',
  'joinDiscussion',
  'replyPeerMessage',
  'readJobResults',
  'fleetInventory',
  'fleetTaskContext',
  'previewFleetTask',
  'admitFleetTask',
  'readFleetReceipts',
  'beginFleetAdmission',
  'readJobLog',
  'readJobEvidence',

  'attachWorkSession',
  'listWork',
  'listCalendar',
  'createCalendarEntry',
  'updateCalendarEntry',
  'calendarEntryAction',
  'updateProjectDueDate',
  'listTaskActivity',
  'addTaskNote',
  'getTaskLifecycle',
  'listWorkSessions',
  'templates',
  'classify',
  'preview',
  'admit',
  'getWorkflow',
  'cancelWorkflow',
  'cancelJob',
  'retryJob',
  'listHumanActions',
  'decideHumanAction',
  'dismissMachineDecisions',
  'decideHandoffQuestion',
  'ingestSession',
  'attachSession',
  'sessionTaskContext',
  'taskCard',
  'taskSessions',
  'getJob',
  'listJobs',
  'listJobEvents',
  'getTask',
  'updateTask',
  'requestCompletion',
  'transitionTask',
  'previewTask',
  'admitTask',
  'listTaskDependencies',
  'addTaskDependency',
  'removeTaskDependency'
] as const

export const readConsoleWorkflowCapabilities: ConsoleWorkflowApi['capabilities'] = async () => ({
  ok: true,
  data: Object.fromEntries([
    ...supported.map((name) => [
      name,
      {
        available: ['cancelWorkflow', 'cancelJob', 'retryJob'].includes(name)
          ? fleetExecutionControlsAvailable
          : true
      }
    ]),
    ...Object.entries(missing).map(([name, operation]) => [
      name,
      {
        available: false,
        reason: `The backoffice contract does not yet provide ${operation}.`
      }
    ])
  ]) as ConsoleWorkflowCapabilities
})
