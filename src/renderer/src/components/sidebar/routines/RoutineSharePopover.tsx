import { Users } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SharePeoplePopover } from '@/components/share/SharePeoplePopover'
import { companiesData } from '@/components/companies/companies-client'
import { useHandoffPeople } from '@/components/next-step/use-handoff-people'
import { translate } from '@/i18n/i18n'
import type { TeamRoutine } from '../../../../../shared/console-team-routines-contract'
import { resolveRoutineAccess } from './routine-access'
import { teamRoutinesApi } from './team-routines-client'

export function RoutineSharePopover({
  name,
  routine,
  onShared,
  onMakeTeam
}: {
  name: string
  onMakeTeam?: () => void
  routine?: TeamRoutine
  onShared?: (updated: TeamRoutine) => void
}): React.JSX.Element {
  const { people, employeeId } = useHandoffPeople()
  const label = translate('sharePeople.label', 'People on {{name}}', { name })
  const trigger = (
    <Button variant="ghost" size="icon-xs" aria-label={label}>
      <Users className="size-3.5" />
    </Button>
  )
  if (!routine) {
    return (
      <Popover>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent side="right" align="start" className="w-72 p-3" aria-label={label}>
          <p className="text-xs text-muted-foreground">
            {onMakeTeam
              ? translate(
                  'routineToTeam.localNotice',
                  'To share this routine, move it to Team routines.'
                )
              : translate(
                  'sharePeople.localOnly',
                  "This routine runs on its workspace host and can't be shared yet. Team routines can be shared."
                )}
          </p>
          {onMakeTeam ? (
            <Button variant="outline" size="sm" onClick={onMakeTeam}>
              {translate('routineToTeam.action', 'Make this a team routine')}
            </Button>
          ) : null}
        </PopoverContent>
      </Popover>
    )
  }
  const roster = people.phase === 'ready' ? people.value : []
  const access = resolveRoutineAccess(routine, roster, employeeId)
  const notice = routine.pending_handoff
    ? translate('sharePeople.transferPending', 'Ownership transfer pending')
    : undefined
  return (
    <SharePeoplePopover
      subjectKind="routine"
      subjectLabel={name}
      owner={access.owner}
      collaborators={access.collaborators}
      canManage={access.canManage}
      notice={notice}
      onAdd={async (addedEmployeeId) => {
        if (!routine.id) {
          throw new Error('Missing routine ID')
        }
        const updated = companiesData(
          await teamRoutinesApi().share({ id: routine.id, employeeId: addedEmployeeId })
        )
        toast.success(translate('sharePeople.added', 'Person added to this routine.'))
        onShared?.(updated)
      }}
    >
      {trigger}
    </SharePeoplePopover>
  )
}
