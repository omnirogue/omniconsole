import { TeamRoutineActions } from './TeamRoutineActions'
import { TEAM_ROUTINES_CHANGED } from './routine-team-links'
import { TeamRoutineDetailsDialog } from './TeamRoutineDetailsDialog'
import { useEffect, useState } from 'react'
import { RoutineConversationPanel } from '@/components/routine-conversation/RoutineConversationPanel'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { useHandoffPeople } from '@/components/next-step/use-handoff-people'
import {
  useCompaniesRead,
  needsOmniosSignIn,
  companiesErrorMessage
} from '@/components/companies/companies-client'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { TeamRoutine } from '../../../../../shared/console-team-routines-contract'
import { resolveRoutineAccess } from './routine-access'
import { RoutineMemberAvatars } from './RoutineMemberAvatars'
import { RoutineSharePopover } from './RoutineSharePopover'
import { teamRoutinesApi } from './team-routines-client'

function routineLabel(routine: TeamRoutine): string {
  return (
    routine.title ||
    routine.name ||
    routine.id ||
    translate('teamRoutines.unnamed', 'Unnamed team routine')
  )
}

function routineSchedule(routine: TeamRoutine): string | null {
  const parts = [routine.every, routine.status ?? routine.trigger_type].filter(Boolean)
  return parts.length ? parts.join(' · ') : null
}

function TeamRoutineRow({
  routine,
  onShared
}: {
  routine: TeamRoutine
  onShared: (updated: TeamRoutine) => void
}) {
  const [conversationOpen, setConversationOpen] = useState(false)
  const { people, employeeId } = useHandoffPeople()
  const roster = people.phase === 'ready' ? people.value : []
  const access = resolveRoutineAccess(routine, roster, employeeId)
  const name = routineLabel(routine)
  const schedule = routineSchedule(routine)
  return (
    <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-worktree-sidebar-accent">
      {/* Team conversations live on board cards, independently of local sessions. */}
      <button
        type="button"
        disabled={!routine.id}
        onClick={() => setConversationOpen(true)}
        className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <p className="truncate text-sm">{name}</p>
        {schedule ? <p className="truncate text-xs text-muted-foreground">{schedule}</p> : null}
      </button>
      {conversationOpen ? (
        <RoutineConversationPanel
          routine={routine}
          name={name}
          schedule={schedule}
          open={conversationOpen}
          onOpenChange={setConversationOpen}
        />
      ) : null}
      <TeamRoutineActions routine={routine} name={name} onUpdated={onShared} />
      {access.collaborators ? <RoutineMemberAvatars collaborators={access.collaborators} /> : null}
      {routine.id ? (
        <span className="opacity-0 focus-within:opacity-100 group-hover:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100">
          <RoutineSharePopover name={name} routine={routine} onShared={onShared} />
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">
          {translate('teamRoutines.missingId', 'Sharing unavailable: missing routine ID')}
        </span>
      )}
    </div>
  )
}

function TeamRoutinesList({
  scope,
  query,
  quiet
}: {
  scope: string
  query: string
  quiet: boolean
}) {
  const { data, loading, error, reload } = useCompaniesRead(() => teamRoutinesApi().list(), scope)
  useEffect(() => {
    window.addEventListener(TEAM_ROUTINES_CHANGED, reload)
    return () => window.removeEventListener(TEAM_ROUTINES_CHANGED, reload)
  }, [reload])
  // A row updated by a share stays in place until the next list read replaces it:
  // overrides are tied to the read they were made against, so a fresh read drops them.
  const [overrides, setOverrides] = useState<{ read: unknown; rows: Record<string, TeamRoutine> }>({
    read: null,
    rows: {}
  })
  const current = overrides.read === data ? overrides.rows : {}
  const effective = (data ?? []).map((routine) => (routine.id && current[routine.id]) || routine)
  // A row with no id cannot be opened or shared, and gives React no stable key.
  const visible = effective.filter(
    (routine): routine is typeof routine & { id: string } =>
      Boolean(routine.id) &&
      routineLabel(routine).toLowerCase().includes(query.trim().toLowerCase())
  )
  // Why: among the conversations, Team shows up only when there are team routines to list.
  if (quiet && (loading || error || visible.length === 0)) {
    return null
  }
  if (loading) {
    return (
      <p role="status" className="p-2 text-xs text-muted-foreground">
        {translate('teamRoutines.loading', 'Loading team routines…')}
      </p>
    )
  }
  if (error) {
    return (
      <div role="alert" className="p-2 text-xs text-muted-foreground">
        {needsOmniosSignIn(error)
          ? translate('teamRoutines.signIn', 'Sign in to see team routines.')
          : translate('teamRoutines.failed', 'Unable to load team routines: {{message}}', {
              message: companiesErrorMessage(error)
            })}
        <Button variant="ghost" size="xs" onClick={reload}>
          {translate('sharePeople.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  return (
    <>
      {quiet ? (
        <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">
          {translate('teamRoutines.heading', 'Team')}
        </h3>
      ) : null}
      {data?.length === 0 ? (
        <p className="p-2 text-xs text-muted-foreground">
          {translate('teamRoutines.empty', 'No team routines yet')}
        </p>
      ) : visible.length === 0 ? (
        <p className="p-2 text-xs text-muted-foreground">
          {translate('routines.noMatches', 'No matching routines.')}
        </p>
      ) : null}
      {visible.map((routine) => (
        <TeamRoutineRow
          key={routine.id}
          routine={routine}
          onShared={(updated) => {
            const id = routine.id
            if (id) {
              setOverrides((last) => ({
                read: data,
                rows: { ...(last.read === data ? last.rows : {}), [id]: updated }
              }))
            }
            reload()
          }}
        />
      ))}
    </>
  )
}

export function TeamRoutinesGroup({
  query,
  quiet = false
}: {
  query: string
  /** Render nothing unless there are team routines to show. */
  quiet?: boolean
}): React.JSX.Element {
  const scope = useHandoffScope()
  const [viewId, setViewId] = useState<string | null>(null)
  useEffect(() => {
    const open = (event: Event): void => setViewId((event as CustomEvent<string>).detail)
    window.addEventListener('omni:view-team-routine', open)
    return () => window.removeEventListener('omni:view-team-routine', open)
  }, [])
  return (
    <section
      aria-label={translate('teamRoutines.heading', 'Team')}
      className={quiet ? 'mb-1 empty:hidden' : 'mb-2'}
    >
      {quiet ? null : (
        <h3 className="px-2 py-1 text-xs font-medium text-muted-foreground">
          {translate('teamRoutines.heading', 'Team')}
        </h3>
      )}
      {viewId ? (
        <TeamRoutineDetailsDialog
          key={`${scope}:${viewId}`}
          id={viewId}
          onClose={() => setViewId(null)}
        />
      ) : null}
      <TeamRoutinesList key={scope} scope={scope} query={query} quiet={quiet} />
    </section>
  )
}
