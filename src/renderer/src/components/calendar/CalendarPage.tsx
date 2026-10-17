import { useMemo, useState } from 'react'
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Flag,
  Loader2,
  Plus,
  RefreshCw
} from 'lucide-react'
import { useHandoffScope } from '@/components/handoffs/handoff-scope'
import { BackofficeWorkTaskSheet } from '@/components/task-page/backoffice/backoffice-work-task-sheet'
import { invalidateBackofficeWork } from '@/components/task-page/backoffice/backoffice-work-store'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { CalendarEntry } from '../../../../shared/console-calendar-contract'
import { CalendarGrid } from './CalendarGrid'
import { CalendarEntrySheet } from './CalendarEntrySheet'
import { CalendarHandoffSheet } from './CalendarHandoffSheet'
import { CalendarProjectDialog } from './CalendarProjectDialog'
import { useCalendarHandoffs, type CalendarHandoffDue } from './calendar-handoffs'
import {
  useCalendarDirectory,
  useCalendarFeed,
  type CalendarProjectChoice
} from './calendar-client'
import {
  calendarDays,
  dayDate,
  dayKey,
  shiftDay,
  shiftMonth,
  type CalendarView
} from './calendar-dates'

type ViewState = { view: CalendarView; company: string; employee: string }
function readView(scope: string): ViewState {
  try {
    const value = JSON.parse(localStorage.getItem(`calendar:${scope}`) ?? '{}')
    return {
      view: ['month', 'week', 'day'].includes(value.view) ? value.view : 'month',
      company: typeof value.company === 'string' ? value.company : '',
      employee: typeof value.employee === 'string' ? value.employee : ''
    }
  } catch {
    return { view: 'month', company: '', employee: '' }
  }
}

export default function CalendarPage() {
  const scope = useHandoffScope()
  // A person switch discards the prior feed, filters and open editor before the next read.
  return <CalendarWorkspace key={scope} scope={scope} />
}

function CalendarWorkspace({ scope }: { scope: string }) {
  const [view, setView] = useState(() => readView(scope))
  const [anchor, setAnchor] = useState(() => dayKey(new Date()))
  const [revision, setRevision] = useState(0)
  const [showFinished, setShowFinished] = useState(false)
  const [appointment, setAppointment] = useState<{
    entry: CalendarEntry | null
    day: string
  } | null>(null)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [handoff, setHandoff] = useState<CalendarHandoffDue | null>(null)
  const [project, setProject] = useState<{ choice: CalendarProjectChoice | null } | null>(null)
  const directory = useCalendarDirectory(scope, revision)
  const handoffs = useCalendarHandoffs(scope, showFinished, view.employee)
  const days = useMemo(() => calendarDays(anchor, view.view), [anchor, view.view])
  const calendar = useCalendarFeed(
    scope,
    days[0],
    days.at(-1) ?? anchor,
    view.company,
    view.employee,
    revision
  )
  // Why: the Work roster names a handoff's other party even when the directory read failed.
  const names = useMemo(
    () =>
      new Map([
        ...handoffs.names,
        ...directory.people.map((person): [string, string] => [person.id, person.name])
      ]),
    [directory.people, handoffs.names]
  )
  const notices = [...directory.errors, ...handoffs.issues]
  const reload = () => {
    setRevision((value) => value + 1)
    handoffs.refresh()
  }
  const changeView = (patch: Partial<ViewState>) => {
    const next = { ...view, ...patch }
    setView(next)
    try {
      localStorage.setItem(`calendar:${scope}`, JSON.stringify(next))
    } catch {
      /* Optional preference storage. */
    }
  }
  const refreshed = () => {
    setRevision((value) => value + 1)
    invalidateBackofficeWork()
  }
  const page = (direction: number) =>
    setAnchor((current) =>
      view.view === 'month'
        ? shiftMonth(current, direction)
        : shiftDay(current, direction * (view.view === 'week' ? 7 : 1))
    )
  const heading =
    view.view === 'month'
      ? dayDate(anchor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
      : view.view === 'day'
        ? dayDate(anchor).toLocaleDateString(undefined, {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
            year: 'numeric'
          })
        : `${dayDate(days[0]).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${dayDate(days[6]).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
  const projectChoices = directory.projects.filter(
    (item) => !view.company || item.company === view.company
  )
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground" data-calendar-page>
      <header className="space-y-3 border-b border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              <CalendarDays className="size-5" />
              {translate('calendar.heading', 'Calendar')}
            </h1>
            <p className="text-xs text-muted-foreground">
              {translate(
                'calendar.subtitle',
                'Appointments, task deadlines, and project and handoff due dates'
              )}{' '}
              · {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={calendar.feed?.projects_available !== true || directory.loading}
              onClick={() => setProject({ choice: null })}
            >
              <Flag />
              {translate('calendar.projectDeadline', 'Project deadline')}
            </Button>
            <Button
              size="sm"
              disabled={directory.loading || directory.companies.length === 0}
              onClick={() => setAppointment({ entry: null, day: anchor })}
            >
              <Plus />
              {translate('calendar.newAppointment', 'New appointment')}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setAnchor(dayKey(new Date()))}>
            {translate('calendar.today', 'Today')}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={translate('calendar.previous', 'Previous period')}
                onClick={() => page(-1)}
              >
                <ChevronLeft />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{translate('calendar.previous', 'Previous period')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={translate('calendar.next', 'Next period')}
                onClick={() => page(1)}
              >
                <ChevronRight />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{translate('calendar.next', 'Next period')}</TooltipContent>
          </Tooltip>
          <h2 className="mr-auto text-sm font-medium" aria-live="polite">
            {heading}
          </h2>
          <Select
            value={view.view}
            onValueChange={(value: CalendarView) => changeView({ view: value })}
          >
            <SelectTrigger size="sm" aria-label={translate('calendar.view', 'Calendar view')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="month">{translate('calendar.month', 'Month')}</SelectItem>
              <SelectItem value="week">{translate('calendar.week', 'Week')}</SelectItem>
              <SelectItem value="day">{translate('calendar.day', 'Day')}</SelectItem>
            </SelectContent>
          </Select>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={translate('calendar.refresh', 'Refresh calendar')}
                disabled={calendar.loading}
                onClick={reload}
              >
                <RefreshCw className={calendar.loading ? 'animate-spin' : ''} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{translate('calendar.refresh', 'Refresh calendar')}</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={view.company || 'all'}
            onValueChange={(value) => changeView({ company: value === 'all' ? '' : value })}
          >
            <SelectTrigger size="sm" aria-label={translate('calendar.company', 'Company')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {translate('calendar.allCompanies', 'All companies')}
              </SelectItem>
              {view.company && !directory.companies.some((item) => item.slug === view.company) && (
                <SelectItem value={view.company}>{view.company}</SelectItem>
              )}
              {directory.companies.map((company) => (
                <SelectItem key={company.slug} value={company.slug}>
                  {company.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={view.employee || 'all'}
            onValueChange={(value) => changeView({ employee: value === 'all' ? '' : value })}
          >
            <SelectTrigger size="sm" aria-label={translate('calendar.person', 'Person')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{translate('calendar.allPeople', 'All people')}</SelectItem>
              {view.employee && !names.has(view.employee) && (
                <SelectItem value={view.employee}>{view.employee}</SelectItem>
              )}
              {directory.people.map((person) => (
                <SelectItem key={person.id} value={person.id}>
                  {person.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="ml-auto flex items-center gap-2">
            <Checkbox
              id="calendar-finished"
              checked={showFinished}
              onCheckedChange={(value) => setShowFinished(value === true)}
            />
            <Label htmlFor="calendar-finished" className="text-xs">
              {translate('calendar.showFinished', 'Show finished appointments and handoffs')}
            </Label>
          </div>
        </div>
      </header>
      {notices.length > 0 && (
        <div role="status" className="border-b border-border px-4 py-2 text-xs text-destructive">
          {notices.join(' ')}
        </div>
      )}
      {calendar.feed?.overlay_errors.map((issue) => (
        <p
          role="alert"
          key={issue.overlay}
          className="border-b border-border px-4 py-2 text-sm text-destructive"
        >
          {issue.overlay}: {issue.error}
        </p>
      ))}
      {calendar.feed && !calendar.feed.projects_available && (
        <p role="status" className="border-b border-border px-4 py-2 text-sm text-muted-foreground">
          {translate(
            'calendar.projectsNotServed',
            'Project deadlines are not available from this server yet. Appointments and task deadlines are shown below.'
          )}
        </p>
      )}
      {calendar.loading && (
        <div
          role="status"
          className="flex items-center justify-center gap-2 p-12 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" />
          {translate('calendar.loading', 'Loading calendar…')}
        </div>
      )}
      {calendar.error && (
        <div role="alert" className="space-y-3 p-6">
          <p className="text-sm text-destructive">{calendar.error}</p>
          <Button variant="outline" size="sm" onClick={reload}>
            {translate('calendar.retry', 'Retry')}
          </Button>
        </div>
      )}
      {calendar.feed && (
        <CalendarGrid
          feed={calendar.feed}
          days={days}
          anchor={anchor}
          view={view.view}
          showFinished={showFinished}
          names={names}
          onDay={(day) => {
            setAnchor(day)
            changeView({ view: 'day' })
          }}
          onCreate={(day) => setAppointment({ entry: null, day })}
          onEntry={(entry) => setAppointment({ entry, day: dayKey(entry.starts_at) })}
          onTask={(task) => setTaskId(task.id)}
          handoffs={handoffs.dues}
          onHandoff={setHandoff}
          onProject={(item) =>
            setProject({
              choice: {
                id: item.id,
                title: item.title,
                dueDate: item.due_date,
                company: item.company_slug ?? '',
                domain: ''
              }
            })
          }
        />
      )}
      {appointment && (
        <CalendarEntrySheet
          key={appointment.entry?.id ?? `new:${appointment.day}`}
          entry={appointment.entry}
          createDay={appointment.day}
          companies={directory.companies}
          people={directory.people}
          initialCompany={view.company || directory.companies[0]?.slug || ''}
          onClose={() => setAppointment(null)}
          onSaved={refreshed}
        />
      )}
      {taskId && (
        <BackofficeWorkTaskSheet
          key={`${scope}:${taskId}`}
          taskId={taskId}
          scope={scope}
          names={names}
          onClose={() => setTaskId(null)}
          onChanged={refreshed}
        />
      )}
      {handoff && (
        <CalendarHandoffSheet
          key={`${scope}:${handoff.key}`}
          due={handoff}
          scope={scope}
          names={names}
          onClose={() => setHandoff(null)}
          onOpenTask={(id) => {
            setHandoff(null)
            setTaskId(id)
          }}
        />
      )}
      {project && (
        <CalendarProjectDialog
          key={project.choice?.id ?? 'new-deadline'}
          project={project.choice}
          choices={projectChoices}
          initialDay={anchor}
          onClose={() => setProject(null)}
          onSaved={refreshed}
        />
      )}
    </div>
  )
}
