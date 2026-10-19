import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DeliverableVerificationRecord } from '../../../../../shared/deliverable-verification-types'
import { sidebarSessionStatusKey } from '@/lib/sidebar-session-source-identity'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { listDeliverableChecks, markDeliverableFalseAlarm } from './deliverable-check-client'

/** Why slower than written files: a check lands a few seconds after the turn ends, never mid-turn. */
const REFRESH_AFTER_ACTIVITY_MS = 3_000

type Read = { key: string; records: readonly DeliverableVerificationRecord[] }

/** The on-screen pane's deliverable check records, read from the host running it while active. */
export function useSessionDeliverables(
  session: SidebarSession | null,
  active: boolean
): {
  records: readonly DeliverableVerificationRecord[]
  markFalseAlarm: (id: string) => void
} {
  const paneKey = session?.paneKey ?? null
  const statusKey = session ? sidebarSessionStatusKey(session) : null
  const activity = useAppStore((state) =>
    statusKey ? (state.agentStatusByPaneKey[statusKey]?.updatedAt ?? 0) : 0
  )
  const environmentId = useAppStore((state) =>
    session ? getRuntimeEnvironmentIdForWorktree(state, session.worktreeId) : null
  )
  const target = useMemo<RuntimeClientTarget>(
    () => (environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }),
    [environmentId]
  )
  const readKey = paneKey ? `${environmentId ?? 'local'}\u0000${paneKey}` : null
  const activityRef = useRef(activity)
  useEffect(() => {
    activityRef.current = activity
  }, [activity])
  const [read, setRead] = useState<Read | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!active || !readKey || !paneKey) {
      return
    }
    let disposed = false
    let readAtActivity = Number.NaN
    const readNow = (): void => {
      readAtActivity = activityRef.current
      void listDeliverableChecks(target, paneKey).then((records) => {
        if (!disposed) {
          setRead({ key: readKey, records })
        }
      })
    }
    readNow()
    const interval = setInterval(() => {
      if (activityRef.current !== readAtActivity) {
        readNow()
      }
    }, REFRESH_AFTER_ACTIVITY_MS)
    return () => {
      disposed = true
      clearInterval(interval)
    }
  }, [active, readKey, paneKey, target, revision])

  const markFalseAlarm = useCallback(
    (id: string) => {
      void markDeliverableFalseAlarm(target, id).then(() => setRevision((value) => value + 1))
    },
    [target]
  )
  return { records: read && read.key === readKey ? read.records : [], markFalseAlarm }
}
