import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { useSessionSelection } from '@/store/session-selection'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { conversationViewKey } from '@/lib/conversation-view'
import {
  ledgerOnlyRowRefusal,
  withoutLedgerOnlyRows
} from '@/lib/mirrored-conversation-row-actions'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { translate } from '@/i18n/i18n'

export function SessionSelectionPicker({
  sessions,
  pending,
  showArchived: showArchivedByTree = false
}: {
  sessions: readonly SidebarSession[]
  pending: boolean
  /** The tree's own Show archived toggle; the picker follows it and offers its own. */
  showArchived?: boolean
}) {
  const [query, setQuery] = useState('')
  const [showArchivedHere, setShowArchivedHere] = useState(false)
  const selection = useSessionSelection()
  const archivedKeys = useSessionSidebarView((state) => state.archived)
  const matching = sessions.filter((session) =>
    `${session.label} ${session.agent} ${session.workspaceLabel}`
      .toLowerCase()
      .includes(query.toLowerCase())
  )
  // Why: the same rule as the tree — an archived row is out of the way unless the person asked
  // for archived rows or is searching for it by name.
  const showArchived = showArchivedByTree || showArchivedHere || query.trim() !== ''
  const isArchived = (session: SidebarSession) =>
    session.ownerArchive?.archived ?? archivedKeys.includes(conversationViewKey(session))
  const archived = matching.filter(isArchived)
  const visible = showArchived ? matching : matching.filter((session) => !isArchived(session))
  return (
    <>
      <Input
        aria-label={translate('sessions.searchSelection', 'Find sessions to select')}
        placeholder={translate('sessions.searchSelection', 'Find sessions to select')}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="flex gap-2">
        <Button
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            selection.set([
              ...selection.keys,
              ...withoutLedgerOnlyRows(visible).map(conversationViewKey)
            ])
          }
        >
          {translate('sessions.selectVisible', 'Select matching')}
        </Button>
      </div>
      <div className="scrollbar-sleek max-h-48 space-y-2 overflow-y-auto">
        {visible.map((session) => {
          const key = conversationViewKey(session)
          // Why (E1/F13): a row the owner's ledger created runs there; no batch acts on it here.
          const refusal = ledgerOnlyRowRefusal(session)
          return (
            <label
              key={key}
              className="flex items-start gap-2 text-xs"
              title={refusal ?? undefined}
            >
              <Checkbox
                disabled={pending || refusal !== null}
                checked={selection.keys.includes(key)}
                onCheckedChange={() => selection.toggle(key)}
              />
              <span className="min-w-0">
                <span className="block truncate">{session.label}</span>
                <span className="block truncate text-muted-foreground">
                  {session.agent} · {session.workspaceLabel}
                </span>
              </span>
            </label>
          )
        })}
      </div>
      {archived.length > 0 && !showArchivedByTree && query.trim() === '' ? (
        <Button
          size="xs"
          variant="ghost"
          className="w-full justify-start text-muted-foreground"
          aria-pressed={showArchivedHere}
          onClick={() => setShowArchivedHere(!showArchivedHere)}
        >
          {showArchivedHere
            ? translate('sessions.archivedShown', '{{count}} archived shown · Hide', {
                count: archived.length
              })
            : translate('sessions.archivedHidden', '{{count}} archived hidden · Show', {
                count: archived.length
              })}
        </Button>
      ) : null}
    </>
  )
}
