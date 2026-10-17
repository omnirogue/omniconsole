import { useEffect, useMemo } from 'react'
import { conversationViewKey } from './conversation-view'
import { waitLaterKeyForPane } from './wait-later'
import type { SidebarSession } from './sidebar-sessions'
import { useSessionSidebarView } from '@/store/session-sidebar-view'

export function sessionWaitKey(session: SidebarSession): string {
  return session.paneKey
    ? waitLaterKeyForPane(session.paneKey)
    : `conversation:${conversationViewKey(session)}`
}

/** Retire attention deadlines without changing the sessions or their execution state. */
export function useSessionSnoozeMigration(_sessions: readonly SidebarSession[]): void {
  const legacy = useSessionSidebarView((state) => state.view.snoozedUntil)
  const loaded = useSessionSidebarView((state) => state.loaded)
  useEffect(() => {
    if (loaded && legacy && Object.keys(legacy).length) {
      useSessionSidebarView.getState().snooze(Object.keys(legacy), null)
    }
  }, [loaded, legacy])
}

export function useWaitingPaneTimes(
  until: Readonly<Record<string, string>>
): ReadonlyMap<string, string> {
  return useMemo(
    () =>
      new Map(
        Object.entries(until)
          .filter(([key]) => key.startsWith('pane:'))
          .map(([key, at]) => [key.slice(5), at])
      ),
    [until]
  )
}
