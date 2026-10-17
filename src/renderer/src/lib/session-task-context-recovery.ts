import { useAppStore } from '@/store'
import { linkSessionToTask, useSessionTasks } from '@/store/session-task-store'
import { selectConsoleAccountScope } from './console-account-scope'
import { buildPaneSessions } from './sidebar-sessions'
import { consoleWorkflowApi, workflowData } from './console-workflow-client'
import {
  hasRefreshableTaskContext,
  rememberAttachedTaskContext,
  sameSessionTaskContextSource,
  sessionTaskContextSourceFence,
  type TaskContextSession
} from './session-task-context'
import type { ConsoleSessionAttachResult } from '../../../shared/console-workflow-types'

const recoveries = new Map<string, Promise<boolean>>()

function watchSource(session: TaskContextSession, bindingIsCurrent: () => boolean) {
  const account = selectConsoleAccountScope(useAppStore.getState())
  const fence = sessionTaskContextSourceFence(session, account)
  if (!fence) {
    return null
  }
  let invalidated = false
  const isCurrent = () =>
    !invalidated &&
    bindingIsCurrent() &&
    selectConsoleAccountScope(useAppStore.getState()) === account &&
    buildPaneSessions(useAppStore.getState()).some((current) => {
      const value = sessionTaskContextSourceFence(current, account)
      return value !== null && sameSessionTaskContextSource(value, fence)
    })
  const invalidate = () => {
    if (!isCurrent()) {
      invalidated = true
    }
  }
  if (!isCurrent()) {
    return null
  }
  const stopAccount = useAppStore.subscribe(invalidate)
  const stopBinding = useSessionTasks.subscribe(invalidate)
  return {
    account,
    fence,
    isCurrent,
    dispose: () => {
      stopAccount()
      stopBinding()
    }
  }
}

/** A cache names the candidate task; only a fresh server binding can restore its context. */
export async function readSessionTaskContextForSource(
  session: TaskContextSession,
  taskId: string,
  sessionId?: string,
  bindingIsCurrent: () => boolean = () => true,
  confirmed?: (result: ConsoleSessionAttachResult) => void
): Promise<ConsoleSessionAttachResult | null> {
  const watch = watchSource(session, bindingIsCurrent)
  if (!watch) {
    return null
  }
  const { fence, isCurrent } = watch
  try {
    const read = consoleWorkflowApi().sessionTaskContext
    if (!read) {
      return null
    }
    const result = workflowData(
      await read({
        taskId,
        ...(sessionId ? { sessionId } : {}),
        ...(sessionId?.startsWith('ses_') ? {} : { sourceKey: fence.sourceKey })
      })
    )
    if (
      !isCurrent() ||
      result.taskId !== taskId ||
      !result.sessionId ||
      (sessionId && result.sessionId !== sessionId) ||
      !result.context?.available ||
      result.context.card_id !== taskId
    ) {
      return null
    }
    confirmed?.(result)
    return result
  } catch {
    return null
  } finally {
    watch.dispose()
  }
}

function recoverLedgerTaskContext(session: TaskContextSession): Promise<boolean> {
  const readLink = window.api?.sessionLedger?.taskLink
  if (!readLink) {
    return Promise.resolve(false)
  }
  const sourceKey = sessionTaskContextSourceFence(
    session,
    selectConsoleAccountScope(useAppStore.getState())
  )?.sourceKey
  if (!sourceKey) {
    return Promise.resolve(false)
  }
  const watch = watchSource(session, () => !useSessionTasks.getState().links[sourceKey])
  if (!watch) {
    return Promise.resolve(false)
  }
  const key = JSON.stringify(['ledger', watch.fence])
  const existing = recoveries.get(key)
  if (existing) {
    watch.dispose()
    return existing
  }
  const recovery = (async () => {
    let recovered = false
    try {
      const link = await readLink(watch.fence.sourceKey)
      if (!link || !watch.isCurrent()) {
        return false
      }
      await readSessionTaskContextForSource(
        session,
        link.cardId,
        link.ledgerId,
        watch.isCurrent,
        (result) => {
          linkSessionToTask(watch.fence.sourceKey, {
            taskId: link.cardId,
            sessionId: result.sessionId,
            ...(link.cardTitle ? { title: link.cardTitle } : {})
          })
          recovered = rememberAttachedTaskContext(session, result, watch.account)
        }
      )
      return recovered
    } catch {
      return false
    } finally {
      watch.dispose()
      recoveries.delete(key)
    }
  })()
  recoveries.set(key, recovery)
  return recovery
}

function recoverJiraContext(session: TaskContextSession): Promise<boolean> {
  useSessionTasks.getState().load()
  const read = consoleWorkflowApi().jiraSessionTask
  if (!read) {
    return Promise.resolve(false)
  }
  const account = selectConsoleAccountScope(useAppStore.getState())
  const fence = sessionTaskContextSourceFence(session, account)
  if (!fence) {
    return Promise.resolve(false)
  }
  const previous = useSessionTasks.getState().links[fence.sourceKey]
  const watch = watchSource(
    session,
    () => useSessionTasks.getState().links[fence.sourceKey] === previous
  )
  if (!watch) {
    return Promise.resolve(false)
  }
  const key = JSON.stringify(['jira', fence])
  const existing = recoveries.get(key)
  if (existing) {
    watch.dispose()
    return existing
  }
  const recovery = (async () => {
    try {
      const result = workflowData(await read({ sourceKey: fence.sourceKey }))
      if (!watch.isCurrent()) {
        return false
      }
      if (!result.taskId) {
        linkSessionToTask(fence.sourceKey, null)
        return false
      }
      if (!result.workRef || !result.sessionId) {
        return false
      }
      linkSessionToTask(fence.sourceKey, {
        taskId: result.taskId,
        sessionId: result.sessionId,
        workRef: result.workRef,
        accountScope: account,
        ...(result.title ? { title: result.title } : {})
      })
      return rememberAttachedTaskContext(session, result, account)
    } catch {
      return false
    } finally {
      watch.dispose()
      recoveries.delete(key)
    }
  })()
  recoveries.set(key, recovery)
  return recovery
}

export function recoverSessionTaskContext(session: TaskContextSession): Promise<boolean> {
  if (hasRefreshableTaskContext(session)) {
    return Promise.resolve(true)
  }
  if (consoleWorkflowApi().jiraSessionTask) {
    return recoverJiraContext(session)
  }
  const account = selectConsoleAccountScope(useAppStore.getState())
  const fence = sessionTaskContextSourceFence(session, account)
  if (!fence) {
    return Promise.resolve(false)
  }
  useSessionTasks.getState().load()
  const link = useSessionTasks.getState().links[fence.sourceKey]
  if (!link) {
    return recoverLedgerTaskContext(session)
  }
  const key = JSON.stringify([fence, link.taskId, link.sessionId])
  const pending = recoveries.get(key)
  if (pending) {
    return pending
  }
  let recovered = false
  const recovery = readSessionTaskContextForSource(
    session,
    link.taskId,
    link.sessionId,
    () => useSessionTasks.getState().links[fence.sourceKey] === link,
    (result) => {
      linkSessionToTask(fence.sourceKey, { ...link, sessionId: result.sessionId })
      recovered = rememberAttachedTaskContext(session, result, account)
    }
  )
    .then(() => recovered)
    .finally(() => {
      if (recoveries.get(key) === recovery) {
        recoveries.delete(key)
      }
    })
  recoveries.set(key, recovery)
  return recovery
}
