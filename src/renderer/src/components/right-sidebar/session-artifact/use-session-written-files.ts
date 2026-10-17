import { useEffect, useMemo, useRef, useState } from 'react'
import { sidebarSessionStatusKey } from '@/lib/sidebar-session-source-identity'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import { listSessionWrittenFiles } from './session-artifact-client'

const NO_PATHS: readonly string[] = []
/** Why a pace: a working agent pings often; one read per interval with new activity is enough. */
const REFRESH_AFTER_ACTIVITY_MS = 1_500

type Read = { key: string; paths: readonly string[] }

/** The provider a saved row's agent reports its hooks as; the Agent Teams lead is Claude Code. */
function savedRowProvider(agent: string | undefined): string | null {
  if (!agent || agent === 'Agent' || agent === 'unknown') {
    return null
  }
  return agent === 'claude-agent-teams' ? 'claude' : agent
}

/**
 * The files the on-screen session's own write tools finished writing, as the main process of the
 * host running it recorded them from every hook event (so no batching loses one and a restart
 * keeps them). Keyed by the provider session, never the pane: a session whose provider has not
 * named itself yet has no files here, rather than borrowing another session's. Read while active.
 */
export function useSessionWrittenFiles(
  session: SidebarSession | null,
  active: boolean
): readonly string[] {
  const statusKey = session ? sidebarSessionStatusKey(session) : null
  const hasLiveEntry = useAppStore((state) =>
    Boolean(statusKey && state.agentStatusByPaneKey[statusKey])
  )
  const liveProvider = useAppStore((state) =>
    statusKey ? (state.agentStatusByPaneKey[statusKey]?.agentType ?? null) : null
  )
  const liveSessionId = useAppStore((state) =>
    statusKey ? (state.agentStatusByPaneKey[statusKey]?.providerSession?.id ?? null) : null
  )
  // Why: without a live entry the row's resolved identity (its saved record or resume) names the
  // session; a live entry always wins, and one without identity never borrows an older session.
  const provider = hasLiveEntry ? liveProvider : savedRowProvider(session?.agent)
  const sessionId = hasLiveEntry ? liveSessionId : (session?.providerSession?.id ?? null)
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
  const activityRef = useRef(activity)
  useEffect(() => {
    activityRef.current = activity
  }, [activity])
  const [read, setRead] = useState<Read | null>(null)
  const readKey =
    provider && provider !== 'unknown' && sessionId
      ? `${environmentId ?? 'local'}\u0000${provider}\u0000${sessionId}`
      : null

  useEffect(() => {
    if (!active || !readKey || !provider || !sessionId) {
      return
    }
    let disposed = false
    let readAtActivity = Number.NaN
    const readNow = (): void => {
      readAtActivity = activityRef.current
      void listSessionWrittenFiles(target, { provider, sessionId }).then((paths) => {
        if (!disposed) {
          setRead({ key: readKey, paths })
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
  }, [active, readKey, provider, sessionId, target])

  return read && read.key === readKey ? read.paths : NO_PATHS
}
