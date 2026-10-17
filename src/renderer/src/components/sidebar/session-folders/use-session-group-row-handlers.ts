import { useLayoutEffect, useMemo, useRef } from 'react'
import { conversationViewKey } from '@/lib/conversation-view'
import { getSessionSidebarDrag } from '@/lib/session-sidebar-drag'
import { isSessionLensGroupKind } from '@/lib/session-sidebar-group-model'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { moveSessionSidebarBatch } from './session-sidebar-batch'
import type { SessionSidebarGroupProps } from './SessionSidebarGroup'
import type { SessionTreeRowHandlers } from './SessionSidebarTreeRowItem'

// Why: parents pass fresh closures every render; routing them through a ref keeps the
// handler object stable so memoized rows skip renders their own data did not cause.
export function useSessionGroupRowHandlers(
  props: SessionSidebarGroupProps
): SessionTreeRowHandlers {
  const latest = useRef(props)
  useLayoutEffect(() => {
    latest.current = props
  })
  const hasSelect = Boolean(props.onSelect)
  const hasStartChain = Boolean(props.onStartChain)
  const hasRename = Boolean(props.onRename)
  // Why: one task or Group-by group holds rows from several folders, so dropping a row on its
  // neighbour there would silently refile the session into a folder the group never showed.
  const canDropRow =
    !props.hideHeader && props.group.kind !== 'task' && !isSessionLensGroupKind(props.group.kind)
  return useMemo<SessionTreeRowHandlers>(
    () => ({
      select: hasSelect
        ? (session, event) => latest.current.onSelect?.(session, event) ?? false
        : undefined,
      startChain: hasStartChain ? (session) => latest.current.onStartChain?.(session) : undefined,
      rename: hasRename ? (session, title) => latest.current.onRename?.(session, title) : undefined,
      open: (session) => latest.current.onOpen(session),
      cancelQueue: (session) => latest.current.onCancelQueue(session),
      dropRow: canDropRow
        ? (source, row) => {
            const batch = getSessionSidebarDrag()?.batch
            if (batch) {
              moveSessionSidebarBatch(batch, { kind: 'row', folderId: row.folderId })
              return
            }
            const { group, onMoveSessionKey } = latest.current
            const keys = group.rows.map((entry) => conversationViewKey(entry.session))
            if (!keys.includes(source)) {
              keys.push(source)
            }
            onMoveSessionKey(source, row.folderId)
            useSessionSidebarView.getState().moveRow(source, conversationViewKey(row.session), keys)
          }
        : undefined
    }),
    [hasSelect, hasStartChain, hasRename, canDropRow]
  )
}
