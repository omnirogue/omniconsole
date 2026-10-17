import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  AutomationTimeField,
  formatAutomationTimeInput,
  parseAutomationTime
} from '@/components/automations/AutomationTimeField'
import { translate } from '@/i18n/i18n'
import { getUiWeekdayNames } from '@/i18n/weekday-names'
import {
  normalizeRoutineDays,
  routineWindowPreset,
  ROUTINE_ALL_DAYS,
  ROUTINE_ALL_HOURS,
  ROUTINE_INTERVAL_MINUTES,
  ROUTINE_MONDAY_TO_FRIDAY,
  type RoutineIntervalMinutes,
  type RoutineScheduleWindow
} from '../../../../../shared/routine-schedule-window'
import { getUiShortWeekdayNames } from './routine-window-label'

const HOURS = Array.from({ length: 24 }, (_, hour) => hour)
const FIELD_CLASS = 'h-8 w-full min-w-0 text-xs'

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

function timeCadence(window: RoutineScheduleWindow): RoutineScheduleWindow['cadence'] {
  return window.cadence.kind === 'time' ? window.cadence : { kind: 'time', hour: 9, minute: 0 }
}

/** The value the "Runs" select shows for a window. */
export function routineRunsValue(window: RoutineScheduleWindow): string {
  return window.cadence.kind === 'interval'
    ? `interval:${window.cadence.minutes}`
    : routineWindowPreset(window)
}

/** The window after choosing a "Runs" option; day chips follow the preset's meaning. */
export function applyRoutineRunsValue(
  window: RoutineScheduleWindow,
  value: string
): RoutineScheduleWindow {
  if (value.startsWith('interval:')) {
    const minutes = Number(value.slice('interval:'.length)) as RoutineIntervalMinutes
    return { ...window, cadence: { kind: 'interval', minutes } }
  }
  const cadence = timeCadence(window)
  if (value === 'weekdays') {
    return { cadence, days: ROUTINE_MONDAY_TO_FRIDAY, hours: ROUTINE_ALL_HOURS }
  }
  if (value === 'weekly') {
    return { cadence, days: [window.days[0] ?? 1], hours: ROUTINE_ALL_HOURS }
  }
  return { cadence, days: ROUTINE_ALL_DAYS, hours: ROUTINE_ALL_HOURS }
}

function HourSelect({
  label,
  value,
  suffix,
  onChange
}: {
  label: string
  value: number
  suffix: string
  onChange: (hour: number) => void
}): React.JSX.Element {
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={String(value)} onValueChange={(next) => onChange(Number(next))}>
        <SelectTrigger size="sm" aria-label={label} className={FIELD_CLASS}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          {HOURS.map((hour) => (
            <SelectItem key={hour} value={String(hour)}>
              {`${pad(hour)}:${suffix}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/** Cadence, clock time or day, allowed weekdays, and (for intervals) allowed hours. */
export function RoutineScheduleFields({
  window,
  onChange
}: {
  window: RoutineScheduleWindow
  onChange: (next: RoutineScheduleWindow) => void
}): React.JSX.Element {
  const weekdayNames = getUiWeekdayNames()
  const shortNames = getUiShortWeekdayNames()
  const runsLabel = translate('routines.runs', 'Runs')
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">{runsLabel}</Label>
        <Select
          value={routineRunsValue(window)}
          onValueChange={(value) => onChange(applyRoutineRunsValue(window, value))}
        >
          <SelectTrigger size="sm" aria-label={runsLabel} className={FIELD_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            {ROUTINE_INTERVAL_MINUTES.map((minutes) => (
              <SelectItem key={minutes} value={`interval:${minutes}`}>
                {translate('routines.everyMinutes', 'Every {{minutes}} min', { minutes })}
              </SelectItem>
            ))}
            <SelectItem value="daily">{translate('routines.runsDaily', 'Daily at…')}</SelectItem>
            <SelectItem value="weekdays">
              {translate('routines.runsWeekdays', 'Weekdays at…')}
            </SelectItem>
            <SelectItem value="weekly">{translate('routines.runsWeekly', 'Weekly on…')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {window.cadence.kind === 'time' ? (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            {translate('routines.timeOfDay', 'Time')}
          </Label>
          <AutomationTimeField
            time={formatAutomationTimeInput(window.cadence.hour, window.cadence.minute)}
            mode="time"
            className="h-8"
            onTimeChange={(time) => {
              const { hour, minute } = parseAutomationTime(time)
              onChange({ ...window, cadence: { kind: 'time', hour, minute } })
            }}
          />
        </div>
      ) : null}
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">
          {translate('routines.allowedDays', 'Allowed days')}
        </Label>
        <ToggleGroup
          type="multiple"
          variant="outline"
          size="sm"
          aria-label={translate('routines.allowedDays', 'Allowed days')}
          className="w-full"
          value={window.days.map(String)}
          onValueChange={(values) =>
            onChange({ ...window, days: normalizeRoutineDays(values.map(Number)) })
          }
        >
          {ROUTINE_ALL_DAYS.map((day) => (
            <ToggleGroupItem
              key={day}
              value={String(day)}
              aria-label={weekdayNames[day]}
              className="flex-1 px-0 text-[11px]"
            >
              {shortNames[day]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {window.cadence.kind === 'interval' ? (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">
            {translate('routines.allowedHours', 'Allowed hours')}
          </Label>
          <div className="flex gap-2">
            <HourSelect
              label={translate('routines.hoursFrom', 'From')}
              value={window.hours.from}
              suffix="00"
              onChange={(from) => onChange({ ...window, hours: { ...window.hours, from } })}
            />
            <HourSelect
              label={translate('routines.hoursTo', 'To')}
              value={window.hours.to}
              suffix="59"
              onChange={(to) => onChange({ ...window, hours: { ...window.hours, to } })}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}
