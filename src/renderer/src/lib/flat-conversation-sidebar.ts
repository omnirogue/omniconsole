import type { ConversationFleetSidebarGroup } from './conversation-fleet-sidebar'
import type { ConversationRoutineRow } from './conversation-routine-rows'
import { conversationViewKey } from './conversation-view'
import { sortSessionSidebarRows } from './session-sidebar-tree-order'
import { sessionSidebarSort } from './session-sidebar-sort'
import type { SessionSidebarView } from './session-sidebar-view'
import type { SessionSearchHit } from '../../../shared/session-search-types'
import { translate } from '@/i18n/i18n'

type ListGroup = ConversationFleetSidebarGroup & {
  routineRows?: ConversationRoutineRow[]
  searchHits?: readonly SessionSearchHit[]
}

/** Reuses the admitted rows without changing filing, retention or session ownership. */
export function flatConversationSidebar(
  groups: readonly ListGroup[],
  view: SessionSidebarView
): ListGroup[] {
  const rows = [
    ...new Map(
      groups.flatMap((g) => g.rows.map((r) => [conversationViewKey(r.session), r] as const))
    ).values()
  ]
  const fleetRows = [
    ...new Map(
      groups.flatMap((g) => g.fleetRows.map((r) => [r.run.workflowId, r] as const))
    ).values()
  ]
  const routineRows = [
    ...new Map(
      groups.flatMap((g) => (g.routineRows ?? []).map((r) => [r.key, r] as const))
    ).values()
  ]
  const searchHits = [
    ...new Map(
      groups.flatMap((g) =>
        (g.searchHits ?? []).map((r) => [`${r.executionHostId}:${r.sessionKey}`, r] as const)
      )
    ).values()
  ]
  sortSessionSidebarRows(rows, { sort: sessionSidebarSort(view), rowOrder: view.rowOrder })
  if (!rows.length && !fleetRows.length && !routineRows.length && !searchHits.length) {
    return []
  }
  return [
    {
      key: 'flat-sessions',
      kind: 'workspace',
      label: translate('auto.components.SessionSidebar.technicalSessions', 'Sessions'),
      rows,
      fleetRows,
      routineRows,
      searchHits,
      collapsed: false,
      hidden: false,
      attentionCount: 0,
      canReorder: false,
      canHide: false
    }
  ]
}
