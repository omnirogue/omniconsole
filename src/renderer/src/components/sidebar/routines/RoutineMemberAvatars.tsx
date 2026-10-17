import type { TeamRosterPerson } from '../../../../../shared/team-roster-search'
import { translate } from '@/i18n/i18n'
import { ROUTINE_AVATAR_CAP, routineInitials } from './routine-access'

export function RoutineMemberAvatars({
  collaborators
}: {
  collaborators: readonly TeamRosterPerson[]
}): React.JSX.Element | null {
  if (collaborators.length === 0) {
    return null
  }
  const shown = collaborators.slice(0, ROUTINE_AVATAR_CAP)
  const overflow = collaborators.length - shown.length
  return (
    <span
      className="flex shrink-0 -space-x-1.5"
      aria-label={translate('teamRoutines.collaboratorCount', '{{count}} people', {
        count: collaborators.length
      })}
    >
      {shown.map((person) => (
        <span
          key={person.id}
          title={person.name}
          className="flex size-5 items-center justify-center rounded-full border border-background bg-muted text-[9px] font-medium text-muted-foreground"
        >
          {routineInitials(person.name)}
        </span>
      ))}
      {overflow > 0 ? (
        <span className="flex size-5 items-center justify-center rounded-full border border-background bg-muted text-[9px] font-medium text-muted-foreground">
          +{overflow}
        </span>
      ) : null}
    </span>
  )
}
