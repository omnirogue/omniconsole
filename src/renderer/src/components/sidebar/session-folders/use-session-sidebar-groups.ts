import { useShownSessionChains } from '@/lib/session-chain-registry'
import { useEffect, useMemo, useRef } from 'react'
import type { SessionSidebarGroup } from '@/lib/session-sidebar-tree'
import { shareSessionSidebarGroups } from '@/lib/session-sidebar-structural-sharing'
import type { SessionSidebarView } from '@/lib/session-sidebar-view'
import { addSessionTaskGroups, type SessionTaskRef } from '@/lib/session-task-sidebar-groups'
import type { SidebarSession } from '@/lib/sidebar-sessions'

/**
 * The tree's groups as the person asked to see them (by status, or folded under tasks),
 * with row and group identity carried across rebuilds so unchanged rows skip rendering.
 */
export function useSessionSidebarGroups(args: {
  groups: readonly SessionSidebarGroup[]
  view: SessionSidebarView
  query: string
  groupByTask: boolean
  taskFor: (session: SidebarSession) => SessionTaskRef | null
}): readonly SessionSidebarGroup[] {
  const { groups, view, query, groupByTask, taskFor } = args
  const chains = useShownSessionChains()
  const lensGroups = useMemo(
    () => (groupByTask ? addSessionTaskGroups({ groups, taskFor, view, query, chains }) : groups),
    [groupByTask, groups, query, taskFor, view, chains]
  )
  const previous = useRef<readonly SessionSidebarGroup[]>([])
  const shared = useMemo(
    () => shareSessionSidebarGroups(previous.current, lensGroups),
    [lensGroups]
  )
  useEffect(() => {
    previous.current = shared
  }, [shared])
  return shared
}
