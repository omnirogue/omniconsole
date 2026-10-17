import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'

export type CalendarOptions = {
  location: string
  url: string
  visibility: 'company' | 'team' | 'personal'
  recurrence: string
  leads: string
}

export function CalendarEntryOptions({
  value,
  onChange
}: {
  value: CalendarOptions
  onChange: (patch: Partial<CalendarOptions>) => void
}) {
  return (
    <details className="rounded-md border border-border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        {translate('calendar.moreOptions', 'Location, reminders and repeat')}
      </summary>
      <div className="mt-3 space-y-3">
        <div className="space-y-1">
          <Label htmlFor="calendar-location">{translate('calendar.location', 'Location')}</Label>
          <Input
            id="calendar-location"
            value={value.location}
            maxLength={500}
            onChange={(event) => onChange({ location: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="calendar-url">{translate('calendar.meetingLink', 'Meeting link')}</Label>
          <Input
            id="calendar-url"
            type="url"
            placeholder="https://"
            value={value.url}
            maxLength={2000}
            onChange={(event) => onChange({ url: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="calendar-visibility">
            {translate('calendar.visibility', 'Visibility')}
          </Label>
          <Select
            value={value.visibility}
            onValueChange={(visibility: CalendarOptions['visibility']) => onChange({ visibility })}
          >
            <SelectTrigger id="calendar-visibility" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="company">
                {translate('calendar.visibilityCompany', 'Company')}
              </SelectItem>
              <SelectItem value="team">{translate('calendar.visibilityTeam', 'Team')}</SelectItem>
              <SelectItem value="personal">
                {translate('calendar.visibilityPersonal', 'Personal and participants')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="calendar-leads">
            {translate('calendar.reminderMinutes', 'Remind me before (minutes)')}
          </Label>
          <Input
            id="calendar-leads"
            placeholder="15, 60"
            value={value.leads}
            onChange={(event) => onChange({ leads: event.target.value })}
          />
          <p className="text-xs text-muted-foreground">
            {translate(
              'calendar.reminderHint',
              'Separate reminders with commas. Leave blank for no reminders before the appointment.'
            )}
          </p>
        </div>
        <div className="space-y-1">
          <Label htmlFor="calendar-repeat">{translate('calendar.repeat', 'Repeat')}</Label>
          <Select
            value={
              ['', 'FREQ=DAILY', 'FREQ=WEEKLY', 'FREQ=MONTHLY'].includes(value.recurrence)
                ? value.recurrence || 'none'
                : 'custom'
            }
            onValueChange={(recurrence) => {
              if (recurrence !== 'custom') {
                onChange({ recurrence: recurrence === 'none' ? '' : recurrence })
              }
            }}
          >
            <SelectTrigger id="calendar-repeat" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">
                {translate('calendar.noRepeat', 'Does not repeat')}
              </SelectItem>
              <SelectItem value="FREQ=DAILY">{translate('calendar.daily', 'Daily')}</SelectItem>
              <SelectItem value="FREQ=WEEKLY">{translate('calendar.weekly', 'Weekly')}</SelectItem>
              <SelectItem value="FREQ=MONTHLY">
                {translate('calendar.monthly', 'Monthly')}
              </SelectItem>
              {value.recurrence &&
                !['FREQ=DAILY', 'FREQ=WEEKLY', 'FREQ=MONTHLY'].includes(value.recurrence) && (
                  <SelectItem value="custom">
                    {translate('calendar.existingRepeat', 'Existing repeat schedule')}
                  </SelectItem>
                )}
            </SelectContent>
          </Select>
        </div>
      </div>
    </details>
  )
}
