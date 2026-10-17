import { useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import type { Automation, AutomationUpdateInput } from '../../../../../shared/automations-types'
import { isValidAutomationCronSchedule } from '../../../../../shared/automation-schedule-parsing'
import {
  buildRoutineWindowCron,
  parseRoutineWindowCron,
  routineWindowProblem,
  type RoutineScheduleWindow
} from '../../../../../shared/routine-schedule-window'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { RoutineScheduleFields } from './RoutineScheduleFields'
import { routineScheduleLabel } from './routine-schedule-label'
import { describeRoutineWindowSchedule } from './routine-window-label'

type ScheduleDraft = {
  enabled: boolean
  /** Null when the routine's cron says more than the controls can show. */
  window: RoutineScheduleWindow | null
}

function draftFor(automation: Automation): ScheduleDraft {
  return { enabled: automation.enabled, window: parseRoutineWindowCron(automation.rrule) }
}

/** The cron a draft would save, and why it cannot be saved yet. */
export function resolveRoutineScheduleDraft(
  automation: Pick<Automation, 'rrule'>,
  window: RoutineScheduleWindow | null
): { cron: string; error: string | null } {
  if (!window) {
    return { cron: automation.rrule, error: null }
  }
  const problem = routineWindowProblem(window)
  if (problem === 'no-days') {
    return { cron: automation.rrule, error: translate('routines.noDays', 'Choose at least one day.') }
  }
  if (problem === 'hours-order') {
    return {
      cron: automation.rrule,
      error: translate('routines.hoursOrder', 'The From hour must not be after the To hour.')
    }
  }
  const cron = buildRoutineWindowCron(window)
  return {
    cron,
    error: isValidAutomationCronSchedule(cron)
      ? null
      : translate('routines.neverRuns', 'This schedule would never run.')
  }
}

/** "When it runs": paused/active, cadence, allowed days and hours — saved as plain cron. */
export function RoutineSchedulePopover({
  automation,
  onSave,
  children
}: {
  automation: Automation
  onSave: (updates: Pick<AutomationUpdateInput, 'rrule' | 'enabled'>) => Promise<boolean>
  children: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<ScheduleDraft>(() => draftFor(automation))
  const [saving, setSaving] = useState(false)
  const { cron, error } = resolveRoutineScheduleDraft(automation, draft.window)
  const changed = cron !== automation.rrule || draft.enabled !== automation.enabled
  const activeLabel = translate('routines.active', 'Active')
  const save = async (): Promise<void> => {
    setSaving(true)
    const saved = await onSave({
      ...(cron !== automation.rrule ? { rrule: cron } : {}),
      ...(draft.enabled !== automation.enabled ? { enabled: draft.enabled } : {})
    })
    setSaving(false)
    if (saved) {
      setOpen(false)
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setDraft(draftFor(automation))
        }
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent side="right" align="start" className="w-72 p-3">
        <form
          className="space-y-3"
          data-routine-schedule=""
          onSubmit={(event) => {
            event.preventDefault()
            if (changed && !error && !saving) {
              void save()
            }
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">{translate('routines.whenItRuns', 'When it runs')}</p>
            <Label className="gap-1.5 text-xs font-normal text-muted-foreground">
              {draft.enabled ? activeLabel : translate('routines.paused', 'Paused')}
              <Switch
                aria-label={activeLabel}
                checked={draft.enabled}
                onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              />
            </Label>
          </div>
          {draft.window ? (
            <RoutineScheduleFields
              window={draft.window}
              onChange={(window) => setDraft((current) => ({ ...current, window }))}
            />
          ) : (
            <div className="space-y-2 text-xs text-muted-foreground">
              <p>
                {translate(
                  'routines.customCron',
                  'Custom cron — edit in Routine settings'
                )}
              </p>
              <code className="block truncate font-mono text-foreground">{automation.rrule}</code>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => {
                  const state = useAppStore.getState()
                  state.setSelectedAutomationId(automation.id)
                  state.openAutomationsPage()
                  setOpen(false)
                }}
              >
                {translate('routines.settings', 'Routine settings')}
              </Button>
            </div>
          )}
          <p className="text-xs text-muted-foreground" data-routine-schedule-preview="">
            {describeRoutineWindowSchedule(cron) ?? routineScheduleLabel(cron)}
          </p>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              {translate('auto.components.SessionSidebar.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={!changed || Boolean(error) || saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {translate('auto.components.SessionSidebar.save', 'Save')}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
