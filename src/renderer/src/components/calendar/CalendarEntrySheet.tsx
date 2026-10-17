import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import {
  consoleWorkflowApi,
  workflowData,
  workflowErrorMessage
} from '@/lib/console-workflow-client'
import { translate } from '@/i18n/i18n'
import type {
  CalendarEntry,
  CalendarCreateRequest
} from '../../../../shared/console-calendar-contract'
import { CalendarPeoplePicker, type CalendarPerson } from './CalendarPeoplePicker'
import { CalendarEntryOptions, type CalendarOptions } from './CalendarEntryOptions'
import { localDateTime } from './calendar-dates'
import { calendarEntryPatch, entryEndInput } from './calendar-entry-draft'
import type { CalendarCompany } from './calendar-client'

export function CalendarEntrySheet({
  entry,
  createDay,
  companies,
  people,
  initialCompany,
  onClose,
  onSaved
}: {
  entry: CalendarEntry | null
  createDay: string
  companies: readonly CalendarCompany[]
  people: readonly CalendarPerson[]
  initialCompany: string
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(entry?.title ?? '')
  const [company, setCompany] = useState(entry?.company_slug ?? initialCompany ?? '')
  const [kind, setKind] = useState<'meeting' | 'reminder'>(entry?.kind ?? 'meeting')
  const [allDay, setAllDay] = useState(entry?.all_day ?? false)
  const [starts, setStarts] = useState(
    entry ? localDateTime(entry.starts_at) : `${createDay}T09:00`
  )
  const [ends, setEnds] = useState(() => entryEndInput(entry, createDay))
  const [details, setDetails] = useState(entry?.details ?? '')
  const [participants, setParticipants] = useState(
    entry?.participants.map((person) => person.employee_id) ?? []
  )
  const [options, setOptions] = useState<CalendarOptions>({
    location: entry?.location ?? '',
    url: entry?.meeting_url ?? '',
    visibility: entry?.visibility ?? 'company',
    recurrence: entry?.recurrence_rule ?? '',
    leads: entry ? entry.reminder_leads.join(', ') : '15'
  })
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'complete' | null>(null)
  const save = async () => {
    if (pending) {
      return
    }
    setPending(true)
    setError(null)
    try {
      const patch = calendarEntryPatch({
        title,
        starts,
        ends,
        allDay,
        participants,
        details,
        options
      })
      if (entry) {
        workflowData(await consoleWorkflowApi().updateCalendarEntry({ entryId: entry.id, patch }))
      } else {
        workflowData(
          await consoleWorkflowApi().createCalendarEntry({
            ...patch,
            company,
            kind
          } satisfies CalendarCreateRequest)
        )
      }
      toast.success(translate('calendar.saved', 'Appointment saved'))
      onSaved()
      onClose()
    } catch (reason) {
      setError(workflowErrorMessage(reason))
    } finally {
      setPending(false)
    }
  }
  const act = async (action: 'cancel' | 'complete') => {
    if (!entry || pending) {
      return
    }
    setPending(true)
    setError(null)
    try {
      workflowData(await consoleWorkflowApi().calendarEntryAction({ entryId: entry.id, action }))
      toast.success(
        action === 'cancel'
          ? translate('calendar.cancelled', 'Appointment cancelled')
          : translate('calendar.completed', 'Appointment completed')
      )
      onSaved()
      onClose()
    } catch (reason) {
      setError(workflowErrorMessage(reason))
    } finally {
      setPending(false)
    }
  }
  const companyChoices =
    entry?.company_slug && !companies.some((item) => item.slug === entry.company_slug)
      ? [{ slug: entry.company_slug, name: entry.company_slug }, ...companies]
      : companies
  const peopleChoices = [
    ...people,
    ...(entry?.participants
      .filter((person) => !people.some((item) => item.id === person.employee_id))
      .map((person) => ({ id: person.employee_id, name: person.name ?? person.employee_id })) ?? [])
  ]

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose()
        }
      }}
    >
      <SheetContent className="overflow-y-auto scrollbar-sleek" showCloseButton={!pending}>
        <SheetHeader>
          <SheetTitle>
            {entry
              ? translate('calendar.appointment', 'Appointment')
              : translate('calendar.newAppointment', 'New appointment')}
          </SheetTitle>
          <SheetDescription>
            {translate('calendar.localTime', 'Times use your local timezone:')}{' '}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </SheetDescription>
        </SheetHeader>
        <form
          className="space-y-4 px-4 pb-6"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <fieldset disabled={pending} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="calendar-title">{translate('calendar.title', 'Title')}</Label>
              <Input
                id="calendar-title"
                autoFocus
                required
                value={title}
                maxLength={300}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="calendar-company">{translate('calendar.company', 'Company')}</Label>
                <Select value={company || undefined} onValueChange={setCompany} disabled={!!entry}>
                  <SelectTrigger id="calendar-company" className="w-full">
                    <SelectValue
                      placeholder={translate('calendar.chooseCompany', 'Choose company')}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {companyChoices.map((item) => (
                      <SelectItem key={item.slug} value={item.slug}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="calendar-kind">{translate('calendar.kind', 'Type')}</Label>
                <Select
                  value={kind}
                  onValueChange={(value: 'meeting' | 'reminder') => setKind(value)}
                  disabled={!!entry}
                >
                  <SelectTrigger id="calendar-kind" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="meeting">
                      {translate('calendar.meeting', 'Meeting')}
                    </SelectItem>
                    <SelectItem value="reminder">
                      {translate('calendar.reminder', 'Reminder')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="calendar-all-day"
                checked={allDay}
                onCheckedChange={(value) => setAllDay(value === true)}
              />
              <Label htmlFor="calendar-all-day">{translate('calendar.allDay', 'All day')}</Label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="calendar-start">{translate('calendar.starts', 'Starts')}</Label>
                <Input
                  id="calendar-start"
                  required
                  type={allDay ? 'date' : 'datetime-local'}
                  value={allDay ? starts.slice(0, 10) : starts}
                  onChange={(event) =>
                    setStarts(allDay ? `${event.target.value}T00:00` : event.target.value)
                  }
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="calendar-end">{translate('calendar.ends', 'Ends')}</Label>
                <Input
                  id="calendar-end"
                  type={allDay ? 'date' : 'datetime-local'}
                  value={allDay ? ends.slice(0, 10) : ends}
                  onChange={(event) =>
                    setEnds(
                      event.target.value
                        ? allDay
                          ? `${event.target.value}T00:00`
                          : event.target.value
                        : ''
                    )
                  }
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{translate('calendar.participants', 'Participants')}</Label>
              <CalendarPeoplePicker
                people={peopleChoices}
                selected={participants}
                onChange={setParticipants}
                disabled={pending}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="calendar-details">{translate('calendar.details', 'Details')}</Label>
              <Textarea
                id="calendar-details"
                rows={4}
                maxLength={4000}
                value={details}
                onChange={(event) => setDetails(event.target.value)}
              />
            </div>
            <CalendarEntryOptions
              value={options}
              onChange={(patch) => setOptions((current) => ({ ...current, ...patch }))}
            />
            {entry?.notes.length ? (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">{translate('calendar.notes', 'Notes')}</h3>
                {entry.notes.map((note) => (
                  <p
                    key={JSON.stringify([note.at, note.author_employee_id, note.text])}
                    className="whitespace-pre-wrap text-sm"
                  >
                    {note.text}
                  </p>
                ))}
              </div>
            ) : null}
            {entry?.gcal?.error && (
              <p className="text-xs text-destructive">
                {translate('calendar.googleSyncError', 'Google Calendar sync:')} {entry.gcal.error}
              </p>
            )}
            {entry?.reminders.length ? (
              <p className="text-xs text-muted-foreground">
                {translate('calendar.absoluteReminders', 'Additional scheduled reminders:')}{' '}
                {entry.reminders.map((value) => new Date(value).toLocaleString()).join(', ')}
              </p>
            ) : null}
          </fieldset>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
              {translate('calendar.close', 'Close')}
            </Button>
            <Button type="submit" disabled={pending || !title.trim() || (!entry && !company)}>
              {pending && <Loader2 className="animate-spin" />}
              {translate('calendar.save', 'Save appointment')}
            </Button>
          </div>
          {entry?.status === 'scheduled' && (
            <div className="border-t border-border pt-4">
              {confirmAction ? (
                <div className="space-y-2">
                  <p className="text-sm">
                    {confirmAction === 'cancel'
                      ? translate('calendar.confirmCancel', 'Cancel this appointment?')
                      : translate('calendar.confirmComplete', 'Mark this appointment completed?')}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant={confirmAction === 'cancel' ? 'destructive' : 'default'}
                      disabled={pending}
                      onClick={() => void act(confirmAction)}
                    >
                      {translate('calendar.confirm', 'Confirm')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending}
                      onClick={() => setConfirmAction(null)}
                    >
                      {translate('calendar.keepEditing', 'Keep editing')}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setConfirmAction('complete')}
                  >
                    {translate('chatActions.complete', 'Complete')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setConfirmAction('cancel')}
                  >
                    {translate('calendar.cancelAppointment', 'Cancel appointment')}
                  </Button>
                </div>
              )}
            </div>
          )}
          {entry?.status !== 'scheduled' && entry && (
            <p className="text-sm text-muted-foreground">
              {entry.status === 'done'
                ? translate('calendar.completed', 'Appointment completed')
                : translate('calendar.cancelled', 'Appointment cancelled')}
            </p>
          )}
        </form>
      </SheetContent>
    </Sheet>
  )
}
