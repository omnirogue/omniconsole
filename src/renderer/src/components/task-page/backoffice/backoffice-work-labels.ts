import { translate } from '@/i18n/i18n'
import { workRowWaitKeys } from './backoffice-work-waiting'

export { describeNextActor, personName } from './backoffice-work-next-actor'
import type {
  WorkRow,
  WorkRowKind,
  WorkRowSource,
  WorkViewGap
} from '../../../../../shared/backoffice-work-views'

/** The one list, seen through what needs this person, what they wait on, or everything. */
export type WorkLens = 'needs-you' | 'waiting' | 'all'
export type WorkStatusFilter = 'all' | 'needs-you' | 'waiting' | 'replied' | 'other' | 'finished'
/** Where a row comes from: the person's cards, requests handed to them, or requests they sent. */
export type WorkSourceFilter = 'all' | 'task' | 'received' | 'sent'
export type WorkFilter = {
  person: string
  status: WorkStatusFilter
  project: string
  source: WorkSourceFilter
  /** Free text over title, people, card id and thread id; empty matches everything. */
  query: string
}
export const ALL_FILTER_VALUE = 'all'
export const WORK_QUERY_MAX = 200
export const EMPTY_WORK_FILTER: WorkFilter = {
  person: 'all',
  status: 'all',
  project: 'all',
  source: 'all',
  query: ''
}
const FINISHED_STATES: ReadonlySet<string> = new Set(['resolved', 'done', 'cancelled'])
const SOURCE_ROWS: Record<Exclude<WorkSourceFilter, 'all'>, readonly WorkRowSource[]> = {
  // Why: a workflow stage assigned to this person belongs to its card, so it files under Tasks.
  task: ['task', 'awaiting-verification', 'human-job'],
  received: ['received-handoff'],
  // Why: a saved follow-up is a request this person is sending once the run finishes.
  sent: ['sent-handoff', 'follow-up']
}

/** A message files by which way it went; every other row by the feed it came from. */
function matchesSource(row: WorkRow, source: WorkSourceFilter): boolean {
  if (source === 'all') {
    return true
  }
  if (row.source === 'message') {
    return source !== 'task' && row.direction === source
  }
  return SOURCE_ROWS[source].includes(row.source)
}

export function workKindLabel(kind: WorkRowKind): string {
  switch (kind) {
    case 'decision':
      return translate('backofficeWork.kindDecision', 'Decision')
    case 'approval':
      return translate('backofficeWork.kindApproval', 'Approval')
    case 'qa':
      return translate('backofficeWork.kindQa', 'QA verdict')
    case 'review':
      return translate('backofficeWork.kindReview', 'Review')
    case 'edit':
      return translate('backofficeWork.kindEdit', 'Edit')
    case 'reply':
      return translate('backofficeWork.kindReply', 'Reply waiting')
    case 'exception':
      return translate('backofficeWork.kindException', 'Needs attention')
    case 'fyi':
      return translate('backofficeWork.kindFyi', 'FYI')
    case 'work':
      return translate('backofficeWork.kindWork', 'Task')
  }
}

export function describeWorkGap(gap: WorkViewGap): string {
  switch (gap) {
    case 'todo-unavailable':
      return translate('backofficeWork.gapTodo', 'Your task feed could not be loaded.')
    case 'todo-truncated':
      return translate(
        'backofficeWork.gapTruncated',
        'Showing the first pages of your tasks; load more to see the rest.'
      )
    case 'verification-not-served':
      return translate(
        'backofficeWork.gapVerification',
        'Work you delivered that still awaits verification is not provided by this server yet.'
      )
    case 'received-unavailable':
      return translate('backofficeWork.gapReceived', 'Requests sent to you could not be loaded.')
    case 'history-unavailable':
      return translate('backofficeWork.gapHistory', 'Finished requests could not be loaded.')
    case 'sent-not-served':
      return translate(
        'backofficeWork.gapSent',
        'Requests you sent are not provided by this server yet, so Waiting For shows your tasks and saved follow-ups only.'
      )
    case 'sent-unavailable':
      return translate(
        'backofficeWork.gapSentUnavailable',
        'Requests you sent could not be loaded.'
      )
    case 'received-truncated':
      return translate(
        'backofficeWork.gapReceivedTruncated',
        'Showing the first pages of requests sent to you; older ones are not listed here.'
      )
    case 'history-truncated':
      return translate(
        'backofficeWork.gapHistoryTruncated',
        'Showing the most recent finished requests; older history is not listed here.'
      )
    case 'sent-truncated':
      return translate(
        'backofficeWork.gapSentTruncated',
        'Showing the first pages of requests you sent; older ones are not listed here.'
      )
    case 'human-jobs-unavailable':
      return translate(
        'backofficeWork.gapHumanJobs',
        'Decisions assigned to you in workflows could not be loaded.'
      )
    case 'human-jobs-not-served':
      return translate(
        'backofficeWork.gapHumanJobsNotServed',
        'Workflow decisions assigned to you are not provided by this server yet.'
      )
    case 'messages-unavailable':
      return translate(
        'backofficeWork.gapMessages',
        'Messages from people in your shared projects could not be loaded.'
      )
    case 'messages-not-served':
      return translate(
        'backofficeWork.gapMessagesNotServed',
        'Messages from people are not provided by this server yet.'
      )
    case 'viewer-unknown':
      return translate(
        'backofficeWork.gapViewerUnknown',
        'No feed named who you are, so messages could not be filed as yours.'
      )
  }
}

const HISTORY_GAPS: ReadonlySet<WorkViewGap> = new Set(['history-unavailable', 'history-truncated'])

/**
 * One strip over every feed that failed or stopped short: a card, a received request and a
 * sent one can each land in any lens, so every gap applies to every lens. Finished history
 * is the exception: its gaps mean nothing before a lens asked for it.
 */
export function gapsForLens(
  lens: WorkLens,
  gaps: readonly WorkViewGap[],
  historyRequested = false
): WorkViewGap[] {
  return gaps.filter((gap) => !HISTORY_GAPS.has(gap) || (historyRequested && lens === 'all'))
}

const FAILED_GAPS: ReadonlySet<WorkViewGap> = new Set([
  'todo-unavailable',
  'received-unavailable',
  'history-unavailable',
  'sent-unavailable',
  'human-jobs-unavailable',
  'messages-unavailable'
])

/**
 * The empty-list text; a lens with a failed feed never says there is nothing in it, and a
 * search or source that narrowed a non-empty list to nothing says so instead of "nothing".
 */
export function workEmptyText(
  lens: WorkLens,
  gaps: readonly WorkViewGap[],
  narrowed = false
): string {
  // Why: a history gap is only ever reported once history was asked for, so it counts here.
  if (gapsForLens(lens, gaps, true).some((gap) => FAILED_GAPS.has(gap))) {
    return translate('backofficeWork.emptyUnavailable', 'This list could not be fully loaded.')
  }
  if (narrowed) {
    return translate('backofficeWork.emptyNarrowed', 'No work matches this search.')
  }
  switch (lens) {
    case 'needs-you':
      return translate('backofficeWork.emptyNeedsYou', 'Nothing needs you right now.')
    case 'waiting':
      return translate(
        'backofficeWork.emptyWaiting',
        'You are not waiting on anyone in these feeds.'
      )
    case 'all':
      return translate('backofficeWork.emptyAll', 'No work matches this view.')
  }
}

function rowStatus(row: WorkRow): Exclude<WorkStatusFilter, 'all'> {
  if (row.needsYou) {
    return 'needs-you'
  }
  if (row.waitingFor) {
    return 'waiting'
  }
  // Why: only resolved, done or cancelled work is finished; an answered request still open is not.
  return FINISHED_STATES.has(row.state?.toLowerCase() ?? '') ? 'finished' : 'other'
}

function rowPeople(row: WorkRow): string[] {
  const people = new Set<string>()
  if (row.nextActor.kind === 'person') {
    people.add(row.nextActor.id)
  } else if (row.nextActor.kind === 'run') {
    row.nextActor.thenIds.forEach((id) => people.add(id))
  }
  if (row.thread) {
    people.add(row.thread.author_employee_id)
    people.add(row.thread.recipient_employee_id)
  }
  if (row.message) {
    people.add(row.message.sender_employee_id)
    people.add(row.message.recipient_employee_id)
  }
  return [...people]
}

function matchesStatus(row: WorkRow, status: WorkStatusFilter): boolean {
  if (status === 'all') {
    return true
  }
  // Why: "replied" is the thread's or message's own state, whichever side of it this person is on.
  return status === 'replied'
    ? row.thread?.state === 'replied' || row.message?.state === 'replied'
    : rowStatus(row) === status
}

function matchesQuery(
  row: WorkRow,
  needle: string,
  names: ReadonlyMap<string, string> | undefined
): boolean {
  if (!needle) {
    return true
  }
  const people = rowPeople(row).flatMap((id) => [id, names?.get(id)])
  return [row.title, row.taskId, row.thread?.id, row.message?.id, ...people].some(
    (value) => typeof value === 'string' && value.toLocaleLowerCase().includes(needle)
  )
}

/**
 * Narrow rows to a filter. `waiting` is the set of wait-later keys the person put away:
 * a row that still needs them but is waiting is not shown as needing them, whatever the
 * lens — the projection strips it from Needs You, and the status filter must agree.
 */
export function filterWorkRows(
  rows: readonly WorkRow[],
  filter: WorkFilter,
  names?: ReadonlyMap<string, string>,
  context: { waiting?: ReadonlySet<string> } = {}
): WorkRow[] {
  const needle = filter.query.trim().toLocaleLowerCase()
  const waiting = context.waiting
  const putAway = (row: WorkRow): boolean => {
    if (!waiting || waiting.size === 0 || rowStatus(row) !== 'needs-you') {
      return false
    }
    return workRowWaitKeys(row).some((key) => waiting.has(key))
  }
  return rows.filter(
    (row) =>
      !(filter.status === 'needs-you' && putAway(row)) &&
      matchesStatus(row, filter.status) &&
      (filter.person === ALL_FILTER_VALUE || rowPeople(row).includes(filter.person)) &&
      (filter.project === ALL_FILTER_VALUE || row.todo?.company_slug === filter.project) &&
      matchesSource(row, filter.source) &&
      matchesQuery(row, needle, names)
  )
}

/** Only the search and source of a filter: what narrows a presorted Needs You or Waiting For list. */
export function narrowingWorkFilter(filter: WorkFilter): WorkFilter {
  return { ...EMPTY_WORK_FILTER, source: filter.source, query: filter.query }
}

export function isWorkFilterNarrowing(filter: WorkFilter): boolean {
  return filter.query.trim().length > 0 || filter.source !== 'all'
}

/** Person and project choices present in the rows, so a filter never offers an empty result. */
export function workFilterChoices(rows: readonly WorkRow[]): {
  people: string[]
  projects: string[]
} {
  const people = new Set<string>()
  const projects = new Set<string>()
  for (const row of rows) {
    rowPeople(row).forEach((id) => people.add(id))
    if (row.todo?.company_slug) {
      projects.add(row.todo.company_slug)
    }
  }
  return { people: [...people].sort(), projects: [...projects].sort() }
}
