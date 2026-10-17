import { translate } from '@/i18n/i18n'
import { matchesRoutineConversation, routineSessionHost } from '@/lib/routine-backed-session'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { useRoutineSessionCatalog } from './routine-session-catalog'

/** Provenance is persisted on the routine, so the acknowledgement survives a chat remount. */
export function RoutineCreationNotice({ session }: { session: SidebarSession | undefined }) {
  const owners = useRoutineSessionCatalog((state) => state.owners)
  if (!session) {
    return null
  }
  return owners
    .filter((owner) => {
      const provenance = owner.automation.createdFromSession
      return (
        session.hostId === routineSessionHost(owner) &&
        matchesRoutineConversation(
          session,
          // Older native provenance carries a synthetic pane; its chat identity is tab-wide.
          provenance && session.kind === 'structured'
            ? { ...provenance, paneKey: null }
            : provenance
        )
      )
    })
    .map(({ automation }) => (
      <p
        key={automation.id}
        role="status"
        data-routine-created={automation.id}
        className="px-3 py-2 text-xs text-muted-foreground"
      >
        {translate(
          'routines.createdInChat',
          "Routine '{{name}}' created. Open it from Conversations.",
          { name: automation.name }
        )}
      </p>
    ))
}
