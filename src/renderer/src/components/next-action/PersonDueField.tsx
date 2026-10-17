import { useId, useState } from 'react'
import { translate as t } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { upNextDueChoice, upNextDueParts } from '../../../../shared/up-next-person-due'

/**
 * When a handoff or review is due: optional, a date with an optional time; a date alone is due
 * at the end of that local day. Self-contained (value in, due out) so any Person composer can
 * mount it. Key it by `value` so a host answer resets what is typed.
 */
export function PersonDueField({
  value,
  onChange,
  disabled = false
}: {
  /** The stored due: ISO with offset, no fractional seconds; absent = none. */
  value: string | undefined
  /** A new due to store, or undefined to clear it. Never called with a moment already past. */
  onChange: (dueAt: string | undefined) => void
  disabled?: boolean
}) {
  const id = useId()
  const [date, setDate] = useState(() => upNextDueParts(value).date)
  const [time, setTime] = useState(() => upNextDueParts(value).time)
  const [refused, setRefused] = useState(false)
  const settle = (nextDate: string, nextTime: string) => {
    const choice = upNextDueChoice(nextDate, nextTime, value, Date.now())
    setRefused(choice.kind === 'past')
    if (choice.kind === 'set') {
      onChange(choice.dueAt)
    } else if (choice.kind === 'clear') {
      onChange(undefined)
    }
  }
  return (
    <div className="space-y-1" data-person-due>
      <Label htmlFor={`${id}-date`} className="text-xs">
        {t('upNext.due', 'Due (optional)')}
      </Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={`${id}-date`}
          type="date"
          className="w-auto"
          value={date}
          disabled={disabled}
          aria-invalid={refused || undefined}
          onChange={(event) => {
            const next = event.target.value
            setDate(next)
            if (!next) {
              setTime('')
            }
            settle(next, next ? time : '')
          }}
        />
        <Input
          type="time"
          className="w-auto"
          value={time}
          disabled={disabled || !date}
          aria-label={t('upNext.dueTime', 'Due time (optional)')}
          aria-invalid={refused || undefined}
          onChange={(event) => setTime(event.target.value)}
          // Why: a half-typed time is briefly a real (and often past) one; judge it when done.
          onBlur={() => settle(date, time)}
        />
        {(value || date) && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => {
              setDate('')
              setTime('')
              settle('', '')
            }}
          >
            {t('upNext.clearDue', 'Clear due date')}
          </Button>
        )}
      </div>
      {refused ? (
        <p role="alert" className="text-xs text-destructive">
          {t('upNext.refusal.dueInPast', 'That due date has passed. Choose a later date or time.')}
        </p>
      ) : (
        date &&
        !time && (
          <p className="text-[11px] text-muted-foreground">
            {t('upNext.dueEndOfDay', 'Due at the end of that day.')}
          </p>
        )
      )}
    </div>
  )
}
