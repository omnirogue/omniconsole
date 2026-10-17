import { ipcMain } from 'electron'
import { consoleWorkflowClient } from '../backoffice/console-workflow-client'

export function registerConsoleWorkflowHandlers(): void {
  ipcMain.handle('consoleWorkflows:readFleetReceipts', (_event, legacy, scope) =>
    consoleWorkflowClient.readFleetReceipts!(legacy, scope)
  )
  ipcMain.handle('consoleWorkflows:beginFleetAdmission', (_event, receipt, scope) =>
    consoleWorkflowClient.beginFleetAdmission!(receipt, scope)
  )
  for (const name of [
    'readCommunicationMode',
    'postDiscussion',
    'joinDiscussion',
    'replyPeerMessage',
    'listTaskDependencies',
    'addTaskDependency',
    'removeTaskDependency'
  ] as const) {
    ipcMain.handle(`consoleWorkflows:${name}`, (_event, args) => consoleWorkflowClient[name](args))
  }
  ipcMain.handle('consoleWorkflows:readJobResults', (_event, args) =>
    consoleWorkflowClient.readJobResults(args)
  )
  ipcMain.handle('consoleWorkflows:fleetInventory', () => consoleWorkflowClient.fleetInventory())
  ipcMain.handle('consoleWorkflows:fleetTaskContext', (_event, args) =>
    consoleWorkflowClient.fleetTaskContext(args)
  )
  ipcMain.handle('consoleWorkflows:previewFleetTask', (_event, args) =>
    consoleWorkflowClient.previewFleetTask(args)
  )
  ipcMain.handle('consoleWorkflows:admitFleetTask', (_event, args) =>
    consoleWorkflowClient.admitFleetTask(args)
  )
  ipcMain.handle('consoleWorkflows:readJobLog', (_event, args) =>
    consoleWorkflowClient.readJobLog(args)
  )
  ipcMain.handle('consoleWorkflows:readJobEvidence', (_event, args) =>
    consoleWorkflowClient.readJobEvidence(args)
  )
  ipcMain.handle('consoleWorkflows:attachWorkSession', (_event, args) =>
    consoleWorkflowClient.attachWorkSession(args)
  )
  for (const name of [
    'listCalendar',
    'createCalendarEntry',
    'updateCalendarEntry',
    'calendarEntryAction',
    'updateProjectDueDate'
  ] as const) {
    ipcMain.handle(`consoleWorkflows:${name}`, (_event, args) => consoleWorkflowClient[name](args))
  }
  ipcMain.handle('consoleWorkflows:listWork', () => consoleWorkflowClient.listWork())
  ipcMain.handle('consoleWorkflows:listTaskActivity', (_event, args) =>
    consoleWorkflowClient.listTaskActivity(args)
  )
  ipcMain.handle('consoleWorkflows:addTaskNote', (_event, args) =>
    consoleWorkflowClient.addTaskNote(args)
  )
  ipcMain.handle('consoleWorkflows:getTaskLifecycle', (_event, args) =>
    consoleWorkflowClient.getTaskLifecycle(args)
  )
  ipcMain.handle('consoleWorkflows:listWorkSessions', () =>
    consoleWorkflowClient.listWorkSessions()
  )
  ipcMain.handle('consoleWorkflows:capabilities', () => consoleWorkflowClient.capabilities())
  ipcMain.handle('consoleWorkflows:inventory', () => consoleWorkflowClient.inventory())
  ipcMain.handle('consoleWorkflows:templates', () => consoleWorkflowClient.templates())
  ipcMain.handle('consoleWorkflows:presets', () => consoleWorkflowClient.presets())
  ipcMain.handle('consoleWorkflows:classify', (_event, args) =>
    consoleWorkflowClient.classify(args)
  )
  ipcMain.handle('consoleWorkflows:preview', (_event, args) => consoleWorkflowClient.preview(args))
  ipcMain.handle('consoleWorkflows:admit', (_event, args) => consoleWorkflowClient.admit(args))
  ipcMain.handle('consoleWorkflows:getWorkflow', (_event, args) =>
    consoleWorkflowClient.getWorkflow(args)
  )
  ipcMain.handle('consoleWorkflows:listHumanActions', () =>
    consoleWorkflowClient.listHumanActions()
  )
  ipcMain.handle('consoleWorkflows:decideHumanAction', (_event, args) =>
    consoleWorkflowClient.decideHumanAction(args)
  )
  ipcMain.handle('consoleWorkflows:ingestSession', (_event, args) =>
    consoleWorkflowClient.ingestSession(args)
  )
  ipcMain.handle('consoleWorkflows:jiraSessionConfig', () =>
    consoleWorkflowClient.jiraSessionConfig!()
  )
  ipcMain.handle('consoleWorkflows:jiraSessionTasks', (_event, args) =>
    consoleWorkflowClient.jiraSessionTasks!(args)
  )
  ipcMain.handle('consoleWorkflows:jiraSessionTask', (_event, args) =>
    consoleWorkflowClient.jiraSessionTask!(args)
  )
  ipcMain.handle('consoleWorkflows:attachJiraSession', (_event, args) =>
    consoleWorkflowClient.attachJiraSession!(args)
  )
  ipcMain.handle('consoleWorkflows:attachSession', (_event, args) =>
    consoleWorkflowClient.attachSession(args)
  )
  ipcMain.handle('consoleWorkflows:sessionTaskContext', (_event, args) =>
    consoleWorkflowClient.sessionTaskContext(args)
  )
  ipcMain.handle('consoleWorkflows:taskCard', (_event, args) =>
    consoleWorkflowClient.taskCard(args)
  )
  ipcMain.handle('consoleWorkflows:taskSessions', (_event, args) =>
    consoleWorkflowClient.taskSessions(args)
  )
  ipcMain.handle('consoleWorkflows:taskConversations', (_event, args) =>
    consoleWorkflowClient.taskConversations(args)
  )
  ipcMain.handle('consoleWorkflows:dismissMachineDecisions', (_event, args) =>
    consoleWorkflowClient.dismissMachineDecisions(args)
  )
  ipcMain.handle('consoleWorkflows:decideHandoffQuestion', (_event, args) =>
    consoleWorkflowClient.decideHandoffQuestion(args)
  )
  ipcMain.handle('consoleWorkflows:previewTask', (_event, args) =>
    consoleWorkflowClient.previewTask(args)
  )
  ipcMain.handle('consoleWorkflows:admitTask', (_event, args) =>
    consoleWorkflowClient.admitTask(args)
  )
  ipcMain.handle('consoleWorkflows:listJobs', (_event, args) =>
    consoleWorkflowClient.listJobs(args)
  )
  ipcMain.handle('consoleWorkflows:listJobEvents', (_event, args) =>
    consoleWorkflowClient.listJobEvents(args)
  )
  ipcMain.handle('consoleWorkflows:getTask', (_event, args) => consoleWorkflowClient.getTask(args))
  ipcMain.handle('consoleWorkflows:requestCompletion', (_event, args) =>
    consoleWorkflowClient.requestCompletion(args)
  )
  ipcMain.handle('consoleWorkflows:transitionTask', (_event, args) =>
    consoleWorkflowClient.transitionTask(args)
  )
  ipcMain.handle('consoleWorkflows:saveReviewSet', (_event, args) =>
    consoleWorkflowClient.saveReviewSet(args)
  )
  ipcMain.handle('consoleWorkflows:saveChain', (_event, args) =>
    consoleWorkflowClient.saveChain(args)
  )
  ipcMain.handle('consoleWorkflows:getJob', (_event, args) => consoleWorkflowClient.getJob(args))
  ipcMain.handle('consoleWorkflows:cancelWorkflow', (_event, args) =>
    consoleWorkflowClient.cancelWorkflow(args)
  )
  ipcMain.handle('consoleWorkflows:cancelJob', (_event, args) =>
    consoleWorkflowClient.cancelJob(args)
  )
  ipcMain.handle('consoleWorkflows:retryJob', (_event, args) =>
    consoleWorkflowClient.retryJob(args)
  )
  ipcMain.handle('consoleWorkflows:listEvents', (_event, args) =>
    consoleWorkflowClient.listEvents(args)
  )
  ipcMain.handle('consoleWorkflows:redraft', (_event, args) => consoleWorkflowClient.redraft(args))
  ipcMain.handle('consoleWorkflows:saveTemplate', (_event, args) =>
    consoleWorkflowClient.saveTemplate(args)
  )
  ipcMain.handle('consoleWorkflows:exportWorkflow', (_event, args) =>
    consoleWorkflowClient.exportWorkflow(args)
  )
  ipcMain.handle('consoleWorkflows:updateTask', (_event, args) =>
    consoleWorkflowClient.updateTask(args)
  )
}
