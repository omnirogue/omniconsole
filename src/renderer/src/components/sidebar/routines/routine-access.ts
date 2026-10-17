import { translate } from '@/i18n/i18n'
import type { TeamRosterPerson } from '../../../../../shared/team-roster-search'
import type { TeamRoutine } from '../../../../../shared/console-team-routines-contract'

/** A member id not in the caller's roster (other company, inactive) stays a person, never a raw id. */
export function resolveRoutinePerson(
  id: string,
  roster: readonly TeamRosterPerson[],
  selfId: string | null
): TeamRosterPerson {
  if (selfId && id === selfId) {
    return { id, name: translate('sharePeople.you', 'You') }
  }
  const known = roster.find((person) => person.id === id)
  return known ?? { id, name: translate('sharePeople.teammate', 'Teammate') }
}

export type RoutineAccess = {
  owner?: TeamRosterPerson
  collaborators?: TeamRosterPerson[]
  canManage?: boolean
}

/**
 * access_canonical is false (or absent) for legacy routines with no access rows yet: membership
 * is genuinely unknown, so owner/collaborators stay undefined and no avatars render, but the hub
 * still lets the rightful owner self-claim, so the add control stays open (canManage left unset).
 */
export function resolveRoutineAccess(
  routine: TeamRoutine,
  roster: readonly TeamRosterPerson[],
  selfId: string | null
): RoutineAccess {
  if (!routine.access_canonical) {
    return {}
  }
  const ownerId = routine.owner_employee_id ?? undefined
  const members = routine.members ?? []
  const owner = ownerId ? resolveRoutinePerson(ownerId, roster, selfId) : undefined
  const collaborators = members
    .filter((id) => id !== ownerId)
    .map((id) => resolveRoutinePerson(id, roster, selfId))
  return { owner, collaborators, canManage: routine.viewer_role === 'owner' }
}

export function routineInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const initials = parts.length > 1 ? [parts[0], parts.at(-1)] : [parts[0] ?? '']
  return initials
    .map((part) => part?.[0] ?? '')
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export const ROUTINE_AVATAR_CAP = 3
