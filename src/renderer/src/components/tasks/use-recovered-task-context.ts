import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { recoverSessionTaskContext } from '@/lib/session-task-context-recovery'
import { hasRefreshableTaskContext, type TaskContextSession } from '@/lib/session-task-context'
import type { SessionTaskLink } from '@/lib/session-task-link'

export function useRecoveredTaskContext(
  session: TaskContextSession,
  link: SessionTaskLink | null
): boolean {
  const scope = useAppStore(selectConsoleAccountScope)
  const [, setRevision] = useState(0)
  const { paneKey, kind, tabId, hostId, sessionKey, worktreeId } = session
  const taskId = link?.taskId
  const sessionId = link?.sessionId
  useEffect(() => {
    let cancelled = false
    const recover = (): void => {
      void recoverSessionTaskContext({ paneKey, kind, tabId, hostId, sessionKey, worktreeId }).then(
        (recovered) => {
          if (recovered && !cancelled) {
            setRevision((value) => value + 1)
          }
        }
      )
    }
    recover()
    const unsubscribe = window.api?.sessionLedger?.onLocalSessionsChanged?.(recover)
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [scope, taskId, sessionId, paneKey, kind, tabId, hostId, sessionKey, worktreeId])
  return hasRefreshableTaskContext(session)
}
