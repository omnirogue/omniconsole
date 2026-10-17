/** IPC surface for the backoffice connection (Settings → Backoffice). */

import { ipcMain } from 'electron'

import { normalizeBackofficeUrl } from '../../shared/backoffice-connection'
import type { BackofficeConnectionTest } from '../../shared/backoffice-connection'
import { testBackofficeConnection } from '../backoffice/backoffice-config'
import {
  archiveBackofficeTask,
  completeBackofficeTask,
  fetchBackofficeFeed,
  fetchBackofficeTodo
} from '../backoffice/backoffice-work'
import { createBackofficeTask } from '../backoffice/backoffice-task-create'
import { readAccountSyncPrefs, writeAccountSyncPref } from '../backoffice/backoffice-account-sync'
import { taskDetailsFields } from '../../shared/task-details'
import { sendInboxMessage } from '../backoffice/backoffice-inbox-send'
import type {
  BackofficeArchiveResult,
  BackofficeTaskCreationResult,
  BackofficeFeedResult,
  BackofficeInboxSendArgs,
  BackofficeInboxSendResult,
  BackofficeTaskCompletionResult,
  BackofficeTodoResult
} from '../../shared/backoffice-work-types'
import type { AccountSyncWriteArgs } from '../../shared/account-sync-types'

export function registerBackofficeHandlers(): void {
  ipcMain.handle(
    'backoffice:testConnection',
    async (
      _event,
      args: { url?: string; requireHttps?: boolean }
    ): Promise<BackofficeConnectionTest> => {
      const normalized = normalizeBackofficeUrl(args?.url, {
        requireHttps: args?.requireHttps === true
      })
      if (!normalized.ok) {
        return { ok: false, url: null, message: normalized.message }
      }
      return testBackofficeConnection(normalized.value)
    }
  )

  ipcMain.handle(
    'backoffice:listTodo',
    async (_event, args?: { cursor?: unknown }): Promise<BackofficeTodoResult> => {
      return fetchBackofficeTodo(typeof args?.cursor === 'string' ? { cursor: args.cursor } : {})
    }
  )

  ipcMain.handle(
    'backoffice:feed',
    async (_event, args: { path?: string }): Promise<BackofficeFeedResult> => {
      // The allowlist lives in the client, which is reachable from the renderer
      // — so the rule is enforced there, not here.
      return fetchBackofficeFeed(typeof args?.path === 'string' ? args.path : '')
    }
  )

  // Session folders that follow the account; the key allowlist and size rule live in the client.
  ipcMain.handle('backoffice:accountSyncRead', async () => readAccountSyncPrefs())
  ipcMain.handle('backoffice:accountSyncWrite', async (_event, args: AccountSyncWriteArgs) =>
    writeAccountSyncPref(args)
  )

  ipcMain.handle(
    'backoffice:inboxSend',
    async (_event, args: BackofficeInboxSendArgs): Promise<BackofficeInboxSendResult> => {
      // Validated again in the client: this handler is reachable from the renderer.
      return sendInboxMessage(args)
    }
  )

  ipcMain.handle(
    'backoffice:completeTask',
    async (
      _event,
      args: { taskId?: unknown; expectedRevision?: unknown; resultRef?: unknown }
    ): Promise<BackofficeTaskCompletionResult> => {
      return completeBackofficeTask(
        typeof args?.taskId === 'string' ? args.taskId : '',
        typeof args?.expectedRevision === 'number' ? args.expectedRevision : Number.NaN,
        typeof args?.resultRef === 'string' ? args.resultRef : undefined
      )
    }
  )

  ipcMain.handle(
    'backoffice:createTask',
    async (
      _event,
      args: {
        title?: unknown
        description?: unknown
        acceptanceCriteria?: unknown
        taskPlan?: unknown
        dueDate?: unknown
        priority?: unknown
        sequentialSteps?: unknown
        actorIds?: unknown
        ownerEmployeeId?: unknown
        companyId?: unknown
        companySlug?: unknown
        additionalCompanySlugs?: unknown
        proposed?: unknown
        unitId?: unknown
        projectId?: unknown
        goalId?: unknown
      }
    ): Promise<BackofficeTaskCreationResult> => {
      const outcome = taskDetailsFields.acceptanceCriteria.safeParse(args?.acceptanceCriteria)
      const plan = taskDetailsFields.taskPlan.safeParse(args?.taskPlan)
      if (!outcome.success || !plan.success) {
        return { ok: false, message: 'Check the task steps, people and completion outcome.' }
      }
      return createBackofficeTask({
        title: typeof args?.title === 'string' ? args.title : '',
        ...(outcome.data !== undefined ? { acceptanceCriteria: outcome.data } : {}),
        ...(plan.data !== undefined ? { taskPlan: plan.data } : {}),
        ...(typeof args?.companyId === 'string' ? { companyId: args.companyId } : {}),
        ...(typeof args?.companySlug === 'string' ? { companySlug: args.companySlug } : {}),
        ...(Array.isArray(args?.additionalCompanySlugs) &&
        args.additionalCompanySlugs.every((slug) => typeof slug === 'string')
          ? { additionalCompanySlugs: args.additionalCompanySlugs }
          : {}),
        ...(args?.proposed === true ? { proposed: true } : {}),
        ...(typeof args?.unitId === 'string' ? { unitId: args.unitId } : {}),
        ...(typeof args?.projectId === 'string' ? { projectId: args.projectId } : {}),
        ...(typeof args?.goalId === 'string' ? { goalId: args.goalId } : {}),
        ...(typeof args?.description === 'string' ? { description: args.description } : {}),
        ...(args?.dueDate === null || typeof args?.dueDate === 'string'
          ? { dueDate: args.dueDate }
          : {}),
        ...(typeof args?.priority === 'string' ? { priority: args.priority } : {}),
        ...(Array.isArray(args?.sequentialSteps) &&
        args.sequentialSteps.every((step) => typeof step === 'string')
          ? { sequentialSteps: args.sequentialSteps }
          : {}),
        ...(Array.isArray(args?.actorIds) && args.actorIds.every((id) => typeof id === 'string')
          ? { actorIds: args.actorIds }
          : {}),
        ...(typeof args?.ownerEmployeeId === 'string'
          ? { ownerEmployeeId: args.ownerEmployeeId }
          : {})
      })
    }
  )

  ipcMain.handle(
    'backoffice:archiveTask',
    async (_event, args: { taskId?: string }): Promise<BackofficeArchiveResult> => {
      // The id is validated again in the client: this handler is reachable from
      // the renderer, so it may not be the place the rule is enforced.
      return archiveBackofficeTask(typeof args?.taskId === 'string' ? args.taskId : '')
    }
  )
}
