import { Bell, CalendarDays, CheckSquare, Flag, Inbox, Plus, Send, Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  CalendarEntry,
  CalendarProject,
  CalendarTask,
  ConsoleCalendarFeed
} from '../../../../shared/console-calendar-contract'
import { upNextDueHasTime } from '../../../../shared/up-next-person-due'
import { dayDate, dayKey, entryOnDay, timeLabel, type CalendarView } from './calendar-dates'
import type { CalendarHandoffDue } from './calendar-handoffs'

type Props = {
  feed: ConsoleCalendarFeed
  days: string[]
  anchor: string
  view: CalendarView
  showFinished: boolean
  names: ReadonlyMap<string, string>
  onDay: (day: string) => void
  onCreate: (day: string) => void
  onEntry: (entry: CalendarEntry) => void
  onTask: (task: CalendarTask) => void
  onProject: (project: CalendarProject) => void
  /** Handoffs and reviews with a due date, sent or received; absent draws none. */
  handoffs?: readonly CalendarHandoffDue[]
  onHandoff?: (due: CalendarHandoffDue) => void
}
type Item = {
  key: string
  order: string
  label: string
  detail: string
  icon: typeof Bell
  onClick?: () => void
  finished?: boolean
}

function itemsForDay(props: Props, day: string): Item[] {
  const owner = (id?: string | null) => (id ? (props.names.get(id) ?? id) : '')
  const entries = props.feed.entries
    .filter(
      (entry) => entryOnDay(entry, day) && (props.showFinished || entry.status === 'scheduled')
    )
    .map((entry): Item => ({
      key: `entry:${entry.id}`,
      order: entry.all_day ? '0' : `2:${new Date(entry.starts_at).toISOString()}`,
      label: entry.title ?? translate('calendar.untitled', 'Untitled appointment'),
      detail: [
        entry.all_day
          ? translate('calendar.allDay', 'All day')
          : `${timeLabel(entry.starts_at)}${entry.ends_at ? ` – ${timeLabel(entry.ends_at)}` : ''}`,
        entry.status === 'done'
          ? translate('calendar.done', 'Completed')
          : entry.status === 'cancelled'
            ? translate('calendar.cancelledShort', 'Cancelled')
            : '',
        entry.company_slug
      ]
        .filter(Boolean)
        .join(' · '),
      icon: entry.kind === 'reminder' ? Bell : CalendarDays,
      onClick: () => props.onEntry(entry),
      finished: entry.status !== 'scheduled'
    }))
  const tasks = props.feed.tasks
    .filter((task) => dayKey(task.due_date) === day)
    .map((task): Item => ({
      key: `task:${task.id}`,
      order: '1:task',
      label: task.title,
      detail: [
        translate('calendar.taskDue', 'Task due'),
        owner(task.owner_employee_id),
        task.company_slug
      ]
        .filter(Boolean)
        .join(' · '),
      icon: CheckSquare,
      onClick: () => props.onTask(task)
    }))
  const projects = props.feed.projects
    .filter((project) => project.due_date === day)
    .map((project): Item => ({
      key: `project:${project.id}`,
      order: '1:project',
      label: project.title,
      detail: [
        translate('calendar.projectDue', 'Project due'),
        owner(project.owner_employee_id),
        project.company_slug
      ]
        .filter(Boolean)
        .join(' · '),
      icon: Flag,
      onClick: () => props.onProject(project)
    }))
  const handoffs = (props.handoffs ?? [])
    .filter((due) => dayKey(due.dueAt) === day && (props.showFinished || !due.finished))
    .map((due): Item => ({
      key: due.key,
      order: '1:handoff',
      label: due.row.title,
      detail: [
        due.ask === 'review'
          ? translate('calendar.reviewDue', 'Review due')
          : translate('calendar.handoffDue', 'Handoff due'),
        due.direction === 'sent'
          ? translate('calendar.handoffTo', 'to {{name}}', { name: owner(due.otherId) })
          : translate('calendar.handoffFrom', 'from {{name}}', { name: owner(due.otherId) }),
        upNextDueHasTime(due.dueAt) ? timeLabel(due.dueAt) : ''
      ]
        .filter(Boolean)
        .join(' · '),
      icon: due.direction === 'sent' ? Send : Inbox,
      onClick: props.onHandoff ? () => props.onHandoff?.(due) : undefined,
      finished: due.finished
    }))
  const agent = props.feed.agent
    .filter((event) => dayKey(event.at) === day)
    .map((event, index): Item => ({
      key: `agent:${event.ref}:${index}`,
      order: `2:${new Date(event.at).toISOString()}`,
      label: event.label,
      detail: `${timeLabel(event.at)} · ${translate('calendar.scheduledAutomation', 'Scheduled automation')}`,
      icon: Timer
    }))
  return [...entries, ...tasks, ...projects, ...handoffs, ...agent].sort(
    (a, b) => a.order.localeCompare(b.order) || a.label.localeCompare(b.label)
  )
}

function CalendarItem({ item, compact }: { item: Item; compact: boolean }) {
  const Icon = item.icon
  const content = (
    <>
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0">
        <span
          className={cn(
            'block font-medium',
            compact ? 'truncate' : 'break-words',
            item.finished && 'text-muted-foreground'
          )}
        >
          {item.label}
        </span>
        <span className={cn('block text-[11px] text-muted-foreground', compact && 'truncate')}>
          {item.detail}
        </span>
      </span>
    </>
  )
  const className =
    'flex w-full gap-1.5 rounded-md border border-border bg-card p-2 text-left text-xs text-card-foreground'
  return item.onClick ? (
    <button
      type="button"
      className={cn(
        className,
        'hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      onClick={item.onClick}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}

export function CalendarGrid(props: Props) {
  const today = dayKey(new Date())
  const month = props.view === 'month'
  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek" data-calendar-view={props.view}>
      <div
        className={cn('grid', props.view === 'day' ? 'grid-cols-1' : 'min-w-[840px] grid-cols-7')}
      >
        {month &&
          props.days.slice(0, 7).map((day) => (
            <div
              key={`weekday:${day}`}
              className="sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-xs font-medium text-muted-foreground"
            >
              {dayDate(day).toLocaleDateString(undefined, { weekday: 'short' })}
            </div>
          ))}
        {props.days.map((day) => {
          const items = itemsForDay(props, day)
          const visible = month ? items.slice(0, 3) : items
          return (
            <section
              key={day}
              aria-label={dayDate(day).toLocaleDateString(undefined, { dateStyle: 'full' })}
              className={cn(
                'min-w-0 border-r border-b border-border p-2',
                month ? 'min-h-36' : 'min-h-96',
                month && day.slice(0, 7) !== props.anchor.slice(0, 7) && 'bg-muted/30'
              )}
            >
              <div className="mb-2 flex items-center justify-between gap-1">
                <Button
                  variant={day === today ? 'secondary' : 'ghost'}
                  size="xs"
                  className={cn('min-w-6', day === today && 'ring-1 ring-ring')}
                  aria-current={day === today ? 'date' : undefined}
                  onClick={() => props.onDay(day)}
                >
                  {month
                    ? Number(day.slice(8))
                    : dayDate(day).toLocaleDateString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric'
                      })}
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`${translate('calendar.addAppointmentOn', 'Add appointment on')} ${day}`}
                      onClick={() => props.onCreate(day)}
                    >
                      <Plus />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {translate('calendar.newAppointment', 'New appointment')}
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="space-y-1.5">
                {visible.map((item) => (
                  <CalendarItem key={item.key} item={item} compact={month} />
                ))}
                {month && items.length > visible.length && (
                  <Button
                    variant="ghost"
                    size="xs"
                    className="w-full justify-start text-muted-foreground"
                    onClick={() => props.onDay(day)}
                  >
                    +{items.length - visible.length} {translate('calendar.more', 'more')}
                  </Button>
                )}
                {!month && !items.length && (
                  <p className="px-1 py-4 text-xs text-muted-foreground">
                    {translate('calendar.dayEmpty', 'Nothing scheduled.')}
                  </p>
                )}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
