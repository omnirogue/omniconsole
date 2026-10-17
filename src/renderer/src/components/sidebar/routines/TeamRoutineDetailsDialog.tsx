import { useCompaniesRead, companiesErrorMessage } from '@/components/companies/companies-client'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { teamRoutinesApi } from './team-routines-client'
import { routineTeamCopy as copy } from './routine-team-copy'

export function TeamRoutineDetailsDialog({
  id,
  onClose
}: {
  id: string
  onClose: () => void
}): React.JSX.Element {
  const { data, error, loading, reload } = useCompaniesRead(() => teamRoutinesApi().get({ id }), id)
  const template = data?.task_template as { prompt?: unknown } | undefined
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{data?.name ?? copy.view()}</DialogTitle>
          <DialogDescription>
            {translate('routineToTeam.teamDetails', 'Team routine {{id}}', {
              id
            })}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p role="status">{translate('teamRoutines.loading', 'Loading team routines…')}</p>
        ) : null}
        {error ? (
          <div role="alert" className="text-sm text-destructive">
            {companiesErrorMessage(error)}
            <Button variant="ghost" onClick={reload}>
              {translate('sharePeople.retry', 'Retry')}
            </Button>
          </div>
        ) : null}
        {data ? (
          <div className="space-y-2 text-sm">
            <p>
              {translate('routineToTeam.status', 'Status: {{status}}', {
                status: data.status ?? copy.unknownStatus()
              })}
            </p>
            <p>
              {translate('routineToTeam.schedule', 'Schedule: {{cron}}', {
                cron: String(data.trigger_config?.cron ?? '')
              })}
            </p>
            {typeof template?.prompt === 'string' ? (
              <p className="whitespace-pre-wrap">{template.prompt}</p>
            ) : null}
          </div>
        ) : null}
        <Button variant="ghost" onClick={onClose}>
          {copy.close()}
        </Button>
      </DialogContent>
    </Dialog>
  )
}
