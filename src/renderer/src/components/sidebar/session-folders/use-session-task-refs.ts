import { useCallback, useEffect, useMemo } from 'react'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sessionTaskRef, type SessionTaskRef } from '@/lib/session-task-sidebar-groups'
import { useSessionTasks } from '@/store/session-task-store'
import { useLedgerCardIds } from './use-ledger-card-ids'
import { useWorkCardTitles } from './use-work-card-titles'

const NO_IDS: readonly string[] = []

/**
 * Which task each conversation serves while the task lens is on, with the best title known for
 * it — the device link's, else the one the hub card carries. The tree reads this for searching
 * by task title, and the lens for its group headings.
 */
export function useSessionTaskRefs(
  enabled: boolean,
  sessions: readonly SidebarSession[]
): (session: SidebarSession) => SessionTaskRef | null {
  const links = useSessionTasks((state) => state.links)
  const linksLoaded = useSessionTasks((state) => state.loaded)
  const ledger = useLedgerCardIds(enabled)
  const ledgerCardByPane = ledger.cards
  useEffect(() => {
    if (enabled && !linksLoaded) {
      useSessionTasks.getState().load()
    }
  }, [enabled, linksLoaded])
  const untitled = useMemo(() => {
    if (!enabled) {
      return NO_IDS
    }
    const ids = new Set<string>()
    for (const session of sessions) {
      const ref = sessionTaskRef(session, links, ledgerCardByPane)
      if (ref && !ref.title) {
        ids.add(ref.taskId)
      }
    }
    return [...ids].sort()
  }, [enabled, ledgerCardByPane, links, sessions])
  const { titles } = useWorkCardTitles(untitled)
  return useCallback(
    (session) => {
      if (!enabled) {
        return null
      }
      const ref = sessionTaskRef(session, links, ledgerCardByPane)
      if (!ref || ref.title) {
        return ref
      }
      const title = titles.get(ref.taskId)
      return title ? { ...ref, title } : ref
    },
    [enabled, ledgerCardByPane, links, titles]
  )
}
