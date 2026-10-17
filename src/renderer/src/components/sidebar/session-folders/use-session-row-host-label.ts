import { createContext, useContext } from 'react'
import { create } from 'zustand'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { UNKNOWN_COMPUTER_BUCKET_ID } from '@/lib/session-sidebar-lens'
import { sessionRowHostId, sessionRowHostName } from '@/lib/session-row-host'
import { mirroredConversationRestLabel } from '@/lib/mirrored-conversation-labels'
import type { SidebarSession } from '@/lib/sidebar-sessions'

/**
 * Whether rows name their computer (showsSessionRowHosts), written by the host switch. Why a
 * store: the switch's hook decides it, and every row reads one boolean without a prop.
 */
export const useSessionRowHosts = create<{ shown: boolean }>(() => ({ shown: false }))

/** The computer a Computer lens bucket lists; its heading already names it, so its rows do not. */
export const SessionRowHostBucketContext = createContext<string | null>(null)

/** The computer this row names, or null when it names none here. */
export function useSessionRowHostLabel(
  session: Pick<SidebarSession, 'hostId' | 'displayHostId'> | null
): string | null {
  const bucket = useContext(SessionRowHostBucketContext)
  const shown = useSessionRowHosts((state) => state.shown)
  const hostId = session ? sessionRowHostId(session) : null
  const named = session !== null && shown && bucket !== (hostId ?? UNKNOWN_COMPUTER_BUCKET_ID)
  // Why: a primitive, so a store change re-renders only rows whose name it changes.
  return useAppStore((state) =>
    named ? sessionRowHostName(hostId, state.sshTargetLabels, state.runtimeEnvironments) : null
  )
}

/**
 * A paired owner's paused or stopped conversation, named with its computer ("paused on Mac
 * Studio"; step 6). Shown whatever the host switch shows: it is the row's state, not a location.
 */
export function useSessionRowRestLabel(
  session: Pick<SidebarSession, 'hostId' | 'mirroredConversation'> | null
): string | null {
  const rest = session?.mirroredConversation?.rest ?? null
  const hostId = session?.hostId ?? null
  // Why: a primitive, so a store change re-renders only rows whose words it changes.
  return useAppStore((state) =>
    rest
      ? mirroredConversationRestLabel(
          rest,
          sessionRowHostName(hostId, state.sshTargetLabels, state.runtimeEnvironments)
        )
      : null
  )
}

/** The open button's name: the session, and its computer when the row names one. */
export function sessionRowOpenLabel(title: string, hostLabel: string | null): string {
  return hostLabel
    ? translate('sessionHosts.openSessionOn', 'Open session {{session}} on {{host}}', {
        session: title,
        host: hostLabel
      })
    : translate('auto.components.SessionSidebar.openSession', 'Open session {{session}}', {
        session: title
      })
}
