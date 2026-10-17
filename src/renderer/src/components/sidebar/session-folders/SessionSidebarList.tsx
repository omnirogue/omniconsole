import { useLayoutEffect, useMemo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  conversationFleetRowKey,
  type ConversationFleetSidebarGroup
} from '@/lib/conversation-fleet-sidebar'
import type { ConversationRoutineRow } from '@/lib/conversation-routine-rows'
import { conversationViewKey } from '@/lib/conversation-view'
import { openSidebarSession as openSession } from '@/lib/open-sidebar-session'
import type { SessionSearchHit } from '../../../../../shared/session-search-types'
import {
  FleetDispatchRow,
  FleetDispatchRows,
  type FleetDispatchRowSelection
} from './FleetDispatchRows'
import { SessionSidebarGroup, type SessionSidebarGroupProps } from './SessionSidebarGroup'
import {
  estimateSessionSidebarRowSize,
  flattenSessionSidebarGroups,
  sessionGroupExtraRowCount,
  SESSION_SIDEBAR_VIRTUALIZE_AFTER,
  windowSessionSidebarGroups,
  type SessionSidebarGroupWindow
} from './session-sidebar-virtual-rows'

export type SessionSidebarListGroupProps = Omit<
  SessionSidebarGroupProps,
  'group' | 'extraRows' | 'renderExtraRow' | 'extraRowCount' | 'window' | 'measure'
>

/**
 * The Conversations groups. Past a few screens of rows it windows them with the flat
 * header+row list, keeping each visible group's DOM (role="group", body drop target) intact
 * between two spacers, so hundreds of sessions cost only what is on screen.
 */
type ListGroup = ConversationFleetSidebarGroup & {
  routineRows?: ConversationRoutineRow[]
  /** Search results the sidebar does not list as rows, drawn after the group's rows. */
  searchHits?: readonly SessionSearchHit[]
}

export function SessionSidebarList({
  groups,
  flat = false,
  listRef,
  revealRef,
  groupProps,
  onSelectFleetRow,
  renderRoutineRow,
  renderSearchHit
}: {
  groups: readonly ListGroup[]
  flat?: boolean
  listRef: React.RefObject<HTMLDivElement | null>
  /** Receives a function that scrolls a session's row (by view key) into the window. */
  revealRef: React.MutableRefObject<((key: string) => void) | null>
  groupProps: SessionSidebarListGroupProps
  /** A selection gesture on a receipt from another computer; absent where nothing selects. */
  onSelectFleetRow?: FleetDispatchRowSelection['onSelect']
  /** Draws a routine listed in a group; without it, routines are not drawn. */
  renderRoutineRow?: (row: ConversationRoutineRow, group: ListGroup) => React.ReactNode
  /** Draws a search result that has no sidebar row; without it, such results are not drawn. */
  renderSearchHit?: (hit: SessionSearchHit) => React.ReactNode
}): React.JSX.Element {
  const rows = useMemo(() => flattenSessionSidebarGroups(groups, flat), [groups, flat])
  // Why: receipts select by the same keys as conversations, so they share the list's selection.
  const fleetSelection = useMemo<FleetDispatchRowSelection | undefined>(
    () =>
      onSelectFleetRow
        ? {
            selectedKeys: groupProps.selectedKeys,
            focusKey: groupProps.focusKey,
            onSelect: onSelectFleetRow
          }
        : undefined,
    [onSelectFleetRow, groupProps.selectedKeys, groupProps.focusKey]
  )
  const virtual = rows.length > SESSION_SIDEBAR_VIRTUALIZE_AFTER
  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    enabled: virtual,
    getScrollElement: () => listRef.current,
    estimateSize: (index) => estimateSessionSidebarRowSize(rows[index]),
    getItemKey: (index) => rows[index]?.key ?? index,
    overscan: 12,
    // Why: sync-flushing row renders inside the scroll listener stalls wheel input.
    useFlushSync: false
  })
  useLayoutEffect(() => {
    revealRef.current = virtual
      ? (key) => {
          const byGroupKey = new Map(groups.map((group) => [group.key, group] as const))
          const index = rows.findIndex((row) => {
            if (row.kind === 'row') {
              return conversationViewKey(row.row.session) === key
            }
            if (row.kind !== 'extra') {
              return false
            }
            const fleet = byGroupKey.get(row.groupKey)?.fleetRows[row.extraIndex]
            return fleet !== undefined && conversationFleetRowKey(fleet.run, fleet.source) === key
          })
          if (index !== -1) {
            virtualizer.scrollToIndex(index, { align: 'auto' })
          }
        }
      : null
  })
  const renderGroup = (group: ListGroup, window?: SessionSidebarGroupWindow): React.JSX.Element => {
    const routineRows = renderRoutineRow ? (group.routineRows ?? []) : []
    const searchHits = renderSearchHit ? (group.searchHits ?? []) : []
    return (
      <SessionSidebarGroup
        key={group.key}
        hideHeader={flat}
        {...groupProps}
        group={group}
        extraRows={
          window ? undefined : (
            <>
              <FleetDispatchRows
                rows={group.fleetRows}
                technical={groupProps.technical}
                selection={fleetSelection}
                onOpenSource={openSession}
              />
              {routineRows.map((row) => (
                <div key={row.key}>{renderRoutineRow?.(row, group)}</div>
              ))}
              {searchHits.map((hit) => (
                <div key={`${hit.executionHostId}:${hit.sessionKey}`}>{renderSearchHit?.(hit)}</div>
              ))}
            </>
          )
        }
        renderExtraRow={(index) => {
          const fleet = group.fleetRows[index]
          if (fleet) {
            return (
              <FleetDispatchRow
                run={fleet.run}
                source={fleet.source}
                technical={groupProps.technical}
                selection={fleetSelection}
                onOpenSource={openSession}
              />
            )
          }
          const routine = routineRows[index - group.fleetRows.length]
          if (routine) {
            return renderRoutineRow?.(routine, group)
          }
          const hit = searchHits[index - group.fleetRows.length - routineRows.length]
          return hit ? renderSearchHit?.(hit) : null
        }}
        extraRowCount={
          sessionGroupExtraRowCount({ fleetRows: group.fleetRows, routineRows }) + searchHits.length
        }
        window={window}
        measure={window ? virtualizer.measureElement : undefined}
      />
    )
  }
  if (!virtual) {
    return <>{groups.map((group) => renderGroup(group))}</>
  }
  const items = virtualizer.getVirtualItems()
  const byKey = new Map(groups.map((group) => [group.key, group] as const))
  const first = items[0]
  const last = items.at(-1)
  return (
    <>
      <div aria-hidden style={{ height: first?.start ?? 0 }} />
      {windowSessionSidebarGroups(
        rows,
        items.map((item) => item.index)
      ).map(({ groupKey, window }) => {
        const group = byKey.get(groupKey)
        return group ? renderGroup(group, window) : null
      })}
      <div
        aria-hidden
        style={{ height: Math.max(0, virtualizer.getTotalSize() - (last?.end ?? 0)) }}
      />
    </>
  )
}
