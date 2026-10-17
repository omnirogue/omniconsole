import { useState } from 'react'
import type { Automation } from '../../../../../shared/automations-types'
import { convertRruleToUtcCron } from '../../../../../shared/routine-schedule-to-cron'
import { routineMacDependence } from '../../../../../shared/routine-mac-dependence'
import { companiesData } from '@/components/companies/companies-client'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { useWorkFoldersScope } from '@/components/companies/use-work-folders'
import { teamRoutinesApi } from './team-routines-client'
import type { RoutineCommands } from './routine-row-commands'
import { routineErrorMessage } from './routine-row-commands'
import {
  convertRoutineToTeam,
  routineConversionBusy,
  routineTeamBody
} from './routine-team-conversion'
import {
  readRoutineTeamLink,
  routineTeamLinkStorageKey,
  saveRoutineTeamLink,
  useRoutineTeamLink,
  viewTeamRoutine
} from './routine-team-links'
import { RoutineTeamScopePicker } from './RoutineTeamScopePicker'
import { routineTeamCopy as copy } from './routine-team-copy'
import { routineTeamScheduleLabel } from './routine-team-schedule-label'

export function ConvertRoutineToTeamDialog({
  automation,
  commands,
  onClose
}: {
  automation: Automation
  commands: RoutineCommands
  onClose: () => void
}): React.JSX.Element {
  const account = useWorkFoldersScope()
  return (
    <ConversionForm key={account} automation={automation} commands={commands} onClose={onClose} />
  )
}

function ConversionForm({
  automation,
  commands,
  onClose
}: {
  automation: Automation
  commands: RoutineCommands
  onClose: () => void
}): React.JSX.Element {
  const link = useRoutineTeamLink(automation.id)
  const [scope, setScope] = useState(automation.scope ?? '')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const conversion = convertRruleToUtcCron(automation)
  const dependencies = routineMacDependence(automation)
  const allowed = conversion.ok && !!scope && (!dependencies.length || ack)
  const confirm = async (): Promise<void> => {
    if (busy || routineConversionBusy(automation.id) || (!link && !allowed)) {
      return
    }
    setBusy(true)
    setError('')
    const key = routineTeamLinkStorageKey()
    try {
      await convertRoutineToTeam({
        id: automation.id,
        link: readRoutineTeamLink(automation.id),
        create: async () => {
          if (!conversion.ok) {
            throw new Error(copy.blocked())
          }
          const api = teamRoutinesApi()
          if (!api.create) {
            throw new Error(
              translate(
                'teamRoutines.unavailable',
                'Team routines need an updated OmniConsole desktop app.'
              )
            )
          }
          return companiesData(
            await api.create(routineTeamBody(automation, conversion.cron, scope))
          )
        },
        enable: async (id) => companiesData(await teamRoutinesApi().enable({ id })),
        disable: async () => {
          if (!(await commands.setEnabled(automation, false))) {
            throw new Error(copy.disableFailed())
          }
        },
        save: (receipt) => saveRoutineTeamLink(automation.id, receipt, key)
      })
    } catch (reason) {
      setError(routineErrorMessage(reason, copy.failed()))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto scrollbar-sleek">
        <DialogHeader>
          <DialogTitle>{link?.state === 'linked' ? copy.moved() : copy.title()}</DialogTitle>
          <DialogDescription>{automation.name}</DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="space-y-3">
            <p className="text-sm">{link.state === 'pending' ? copy.pending() : copy.created()}</p>
            {link.nextDue && Number.isFinite(Date.parse(link.nextDue)) ? (
              <p className="text-sm">
                {translate('routineToTeam.nextRun', 'Next run: {{time}}', {
                  time: new Date(link.nextDue).toLocaleString()
                })}
              </p>
            ) : null}
            <Button
              variant="outline"
              onClick={() => {
                viewTeamRoutine(link.teamRoutineId)
                onClose()
              }}
            >
              {copy.view()}
            </Button>
            {link.state === 'linked' ? (
              <Button
                variant="ghost"
                disabled={busy || automation.enabled}
                onClick={() => void commands.setEnabled(automation, true)}
              >
                {copy.restore()}
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <Label htmlFor="routine-team-prompt">{copy.prompt()}</Label>
            <Textarea id="routine-team-prompt" value={automation.prompt} readOnly rows={4} />
            {conversion.ok ? (
              <div className="space-y-1 text-xs">
                <p>
                  {translate('routineToTeam.localTime', 'Your time ({{zone}}): {{schedule}}', {
                    zone: automation.timezone,
                    schedule: routineTeamScheduleLabel(conversion.localCron)
                  })}
                </p>
                <p>
                  {translate('routineToTeam.utcTime', 'Server time (UTC): {{schedule}}', {
                    schedule: routineTeamScheduleLabel(conversion.cron)
                  })}
                </p>
              </div>
            ) : (
              <div role="alert" className="text-sm text-destructive">
                <p>{copy[conversion.code]()}</p>
                <p>{copy.blocked()}</p>
              </div>
            )}
            {automation.scope ? (
              <p className="text-xs text-muted-foreground">{automation.scope}</p>
            ) : (
              <RoutineTeamScopePicker onChange={setScope} />
            )}
            <p className="text-sm">{copy.consequences()}</p>
            <p className="text-sm">{copy.off()}</p>
            {dependencies.length ? (
              <div className="space-y-2">
                <ul className="list-disc pl-4 text-sm">
                  {dependencies.map((reason) => (
                    <li key={reason}>{copy[reason]()}</li>
                  ))}
                </ul>
                <Label className="flex items-start gap-2">
                  <Checkbox checked={ack} onCheckedChange={(checked) => setAck(checked === true)} />
                  {copy.ack()}
                </Label>
              </div>
            ) : null}
          </div>
        )}
        {link?.state === 'enabled' ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {copy.disableFailed()}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {link?.state === 'pending' ? copy.keepLocal() : link ? copy.close() : copy.cancel()}
          </Button>
          {!link || link.state !== 'linked' ? (
            <Button disabled={busy || (!link && !allowed)} onClick={() => void confirm()}>
              {link
                ? link.state === 'pending'
                  ? copy.retryEnable()
                  : copy.retry()
                : busy
                  ? copy.working()
                  : dependencies.length
                    ? copy.confirmRisk()
                    : copy.action()}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
