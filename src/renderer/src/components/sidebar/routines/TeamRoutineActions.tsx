import { useRef, useState } from 'react'
import { MoreVertical } from 'lucide-react'
import type { TeamRoutine } from '../../../../../shared/console-team-routines-contract'
import { companiesData } from '@/components/companies/companies-client'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { teamRoutinesApi } from './team-routines-client'
import { routineErrorMessage } from './routine-row-commands'

export function TeamRoutineActions({
  routine,
  name,
  onUpdated
}: {
  routine: TeamRoutine
  name: string
  onUpdated: (routine: TeamRoutine) => void
}): React.JSX.Element | null {
  const inflight = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (routine.viewer_role !== 'owner' || !routine.id) {
    return null
  }
  const toggle = async (): Promise<void> => {
    if (inflight.current || !routine.id) {
      return
    }
    inflight.current = true
    setBusy(true)
    setError('')
    try {
      const api = teamRoutinesApi()
      const updated = companiesData(
        await (routine.status === 'disabled' ? api.enable : api.disable)({
          id: routine.id
        })
      )
      onUpdated(updated)
    } catch (reason) {
      setError(
        routineErrorMessage(
          reason,
          translate('teamRoutines.toggleFailed', 'The team routine could not be updated.')
        )
      )
    } finally {
      inflight.current = false
      setBusy(false)
    }
  }
  return (
    <div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={busy}
            aria-label={translate('routines.moreOptions', 'More options for {{name}}', { name })}
          >
            <MoreVertical className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={busy} onSelect={() => void toggle()}>
            {routine.status === 'disabled'
              ? translate('teamRoutines.turnOn', 'Turn on')
              : translate('teamRoutines.turnOff', 'Turn off')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
