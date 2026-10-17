import { translate } from '@/i18n/i18n'
import { conversationViewKey } from '@/lib/conversation-view'
import type { ConversationFleetSidebarRow } from '@/lib/conversation-fleet-sidebar'
import { ledgerOnlyRowRefusal } from '@/lib/mirrored-conversation-row-actions'
import type { SidebarSession } from '@/lib/sidebar-sessions'

export function selectedBulkSources(
  sessions: readonly SidebarSession[],
  fleetRows: readonly ConversationFleetSidebarRow[]
): SidebarSession[] {
  return [
    ...new Map(
      [...sessions, ...fleetRows.flatMap((row) => (row.source ? [row.source] : []))].map(
        (session) => [conversationViewKey(session), session]
      )
    ).values()
  ]
}

export function SessionBulkOwnerNotice({ sessions }: { sessions: readonly SidebarSession[] }) {
  const refusals = [...new Set(sessions.map(ledgerOnlyRowRefusal).filter(Boolean))]
  if (refusals.length === 0) {
    return null
  }
  return (
    <p className="text-xs text-muted-foreground" role="status">
      {translate(
        'conversations.bulkOwnerActions',
        'Some selected sessions must be archived or paused on their owning computer.'
      )}{' '}
      {refusals.join(' ')}
    </p>
  )
}
