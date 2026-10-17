import { useState } from 'react'
import { ChevronRight, History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { conversationViewKey } from '@/lib/conversation-view'
import {
  describeOrganizationTime,
  describeOrganizationWhat,
  describeOrganizationWho
} from '@/lib/session-organization-describe'
import { undoOrganizationChangeWithNotice } from '@/lib/session-organization-undo-notice'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useOrganizationHistory } from '@/lib/use-organization-history'
import { cn } from '@/lib/utils'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionHistoryOpen } from '@/store/session-history-open'
import type { OrganizationRecord } from '../../../../../shared/session-organization-change'

const COLLAPSED_LIMIT = 10

/** The keys a session was recorded under before its sidebar key resolved. */
export function sessionHistoryAliases(session: SidebarSession): string[] {
  return [
    ...(session.paneKey ? [`pane:${session.paneKey}`] : []),
    ...(session.tabId ? [`tab:${session.tabId}`] : [])
  ]
}

function HistoryEntry({
  record,
  undoable,
  onUndo
}: {
  record: OrganizationRecord
  undoable: boolean
  onUndo: () => void
}): React.JSX.Element {
  const folders = useSessionFolders((state) => state.metadata.folders)
  const failed = record.phase === 'failed'
  return (
    <li
      className="flex items-start gap-1"
      data-history-entry={record.opId}
      data-history-phase={record.phase}
    >
      <div className="min-w-0 flex-1 whitespace-normal">
        <span className="tabular-nums">{describeOrganizationTime(record.ts)}</span>
        {' · '}
        <span className={cn('text-foreground', failed && 'line-through')}>
          {describeOrganizationWhat(record, folders)}
        </span>
        {' · '}
        {describeOrganizationWho(record.executor)}
        {record.reason ? ` · ${record.reason}` : null}
        {failed ? (
          <span className="text-destructive">
            {' · '}
            {translate('conversations.history.failed', 'did not happen')}
          </span>
        ) : null}
        {record.phase === 'prepared' ? (
          <span>
            {' · '}
            {translate('conversations.history.interrupted', 'interrupted, checking')}
          </span>
        ) : null}
      </div>
      {undoable ? (
        <Button variant="ghost" size="xs" className="shrink-0" onClick={onUndo}>
          {translate('conversations.history.undo', 'Undo')}
        </Button>
      ) : null}
    </li>
  )
}

/**
 * What was done to this session, newest first: moves, renames, archives, tags. The last ten,
 * then Show all; Undo puts a change back unless the session changed since (and says so).
 */
export function SessionRowHistory({ session }: { session: SidebarSession }): React.JSX.Element {
  const key = conversationViewKey(session)
  // Why both: the row menu's History opens it from outside; the header toggles it here.
  const requested = useSessionHistoryOpen((state) => state.open.has(key))
  const [openHere, setOpenHere] = useState(false)
  const open = openHere || requested
  const [showAll, setShowAll] = useState(false)
  const { data, error, loading, reload } = useOrganizationHistory(
    key,
    sessionHistoryAliases(session),
    open
  )
  const records = data ? [...data.pending, ...data.entries] : []
  const undoable = new Set(data?.undoable ?? [])
  const shown = showAll ? records : records.slice(0, COLLAPSED_LIMIT)
  const toggle = (): void => {
    setOpenHere(!open)
    if (open) {
      useSessionHistoryOpen.getState().setOpen(key, false)
    }
  }
  return (
    <div data-session-history={open ? 'open' : 'closed'}>
      <Button
        variant="ghost"
        size="xs"
        className="-ml-1.5 gap-1 px-1.5 text-muted-foreground"
        aria-expanded={open}
        onClick={toggle}
      >
        <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        <History className="size-3" />
        {translate('conversations.history.title', 'History')}
      </Button>
      {open ? (
        <div className="space-y-1 pl-1">
          {error ? <p className="text-destructive">{error}</p> : null}
          {!error && !loading && data && records.length === 0 ? (
            <p>{translate('conversations.history.empty', 'No recorded changes yet.')}</p>
          ) : null}
          {shown.length > 0 ? (
            <ul className="space-y-0.5">
              {shown.map((record) => (
                <HistoryEntry
                  key={`${record.opId}:${record.phase}`}
                  record={record}
                  undoable={record.phase === 'applied' && undoable.has(record.opId)}
                  onUndo={() => {
                    void undoOrganizationChangeWithNotice(record.opId, 'sidebar').then(reload)
                  }}
                />
              ))}
            </ul>
          ) : null}
          {!showAll && records.length > COLLAPSED_LIMIT ? (
            <Button variant="ghost" size="xs" onClick={() => setShowAll(true)}>
              {translate('conversations.history.showAll', 'Show all {{count}}', {
                count: records.length
              })}
            </Button>
          ) : null}
          {data?.revocations.placement ? (
            <p>
              {translate(
                'conversations.history.placementYours',
                'Where it sits is yours: agents never move it back.'
              )}
            </p>
          ) : null}
          {data?.revocations.title ? (
            <p>
              {translate(
                'conversations.history.titleYours',
                'Its name is yours: agents never rename it.'
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
