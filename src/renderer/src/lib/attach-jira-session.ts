import { useAppStore } from '@/store'
import { linkSessionToTask } from '@/store/session-task-store'
import { selectConsoleAccountScope } from './console-account-scope'
import { consoleWorkflowApi, workflowData } from './console-workflow-client'
import { buildPaneSessions, type SidebarSession } from './sidebar-sessions'
import { sidebarSessionSourceIdentity } from './sidebar-session-source-identity'
import { rememberAttachedTaskContext } from './session-task-context'
import {
  jiraSessionTaskId,
  type JiraSessionTask
} from '../../../shared/console-jira-session-contract'

export async function attachSessionToJira(session: SidebarSession, task: JiraSessionTask) {
  const accountScope = selectConsoleAccountScope(useAppStore.getState())
  const source = sidebarSessionSourceIdentity(session)
  const attach = consoleWorkflowApi().attachJiraSession
  if (!source || !attach) {
    throw new Error('Update OmniConsole to attach this session to Jira.')
  }
  const current = () =>
    selectConsoleAccountScope(useAppStore.getState()) === accountScope &&
    buildPaneSessions(useAppStore.getState()).some(
      (row) =>
        row.hostId === session.hostId &&
        row.sessionKey === session.sessionKey &&
        sidebarSessionSourceIdentity(row)?.sourceKey === source.sourceKey
    )
  if (!current()) {
    throw new Error('The conversation changed. Reopen its task picker.')
  }
  const result = workflowData(await attach({ sourceKey: source.sourceKey, workRef: task.work_ref }))
  if (
    !current() ||
    result.taskId !== jiraSessionTaskId(task.work_ref) ||
    !result.sessionId ||
    JSON.stringify(result.workRef) !== JSON.stringify(task.work_ref)
  ) {
    throw new Error('The conversation or task link changed. Refresh before retrying.')
  }
  linkSessionToTask(source.sourceKey, {
    taskId: result.taskId,
    sessionId: result.sessionId,
    workRef: task.work_ref,
    accountScope,
    title: result.title ?? task.summary,
    at: new Date().toISOString()
  })
  const contextReady = rememberAttachedTaskContext(session, result, accountScope)
  return {
    ...result,
    contextWarning:
      result.contextWarning ??
      (contextReady
        ? undefined
        : 'The Jira link is saved. Task context will be refreshed when this conversation is ready.')
  }
}
