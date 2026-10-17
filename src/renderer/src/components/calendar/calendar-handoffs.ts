import { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { useBackofficeWorkViews } from '@/components/task-page/backoffice/backoffice-work-store'
import { previousOf } from '@/components/task-page/backoffice/backoffice-work-read-loader'
import type { WorkLoad, WorkReads } from '@/components/task-page/backoffice/backoffice-work-reads'
import { receivedRow, sentRow } from '../../../../shared/backoffice-work-rows'
import type { WorkRow } from '../../../../shared/backoffice-work-views'
import type { HandoffQueue } from '../../../../shared/console-handoff-contract'

/** One handoff or review on the day it is due, as this person sent or received it. */
export type CalendarHandoffDue = {
  key: string
  /** The row the Work list opens for this thread, so a click here opens it the same way. */
  row: WorkRow
  dueAt: string
  ask: 'handoff' | 'review'
  direction: 'sent' | 'received'
  /** The other party: who it went to, or who sent it. */
  otherId: string
  /** The viewer on this thread: its author when sent, its recipient when received. */
  viewerId: string
  finished: boolean
}

type HandoffReads = Pick<WorkReads, 'receivedOpen' | 'receivedHistory' | 'sent'>

/**
 * Every thread with a due date from the Work list's own reads (Needs you, its finished history,
 * and Waiting for). A thread in two reads is shown once; `employee` keeps the ones they are on.
 */
export function calendarHandoffDues(reads: HandoffReads, employee = ''): CalendarHandoffDue[] {
  const seen = new Set<string>()
  const dues: CalendarHandoffDue[] = []
  const add = (queue: HandoffQueue | null, direction: 'sent' | 'received') => {
    for (const thread of queue?.threads ?? []) {
      const on =
        !employee ||
        thread.author_employee_id === employee ||
        thread.recipient_employee_id === employee
      if (!thread.due_at || !Number.isFinite(Date.parse(thread.due_at)) || seen.has(thread.id)) {
        continue
      }
      seen.add(thread.id)
      if (!on) {
        continue
      }
      const sent = direction === 'sent'
      dues.push({
        key: `handoff:${thread.id}`,
        row: sent ? sentRow(thread) : receivedRow(thread),
        dueAt: thread.due_at,
        ask: thread.action === 'review' ? 'review' : 'handoff',
        direction,
        otherId: sent ? thread.recipient_employee_id : thread.author_employee_id,
        viewerId: sent ? thread.author_employee_id : thread.recipient_employee_id,
        finished: thread.state === 'resolved'
      })
    }
  }
  // Why: a refresh that failed keeps the threads already read; the notice says it failed.
  add(previousOf(reads.receivedOpen), 'received')
  add(previousOf(reads.receivedHistory), 'received')
  add(previousOf(reads.sent), 'sent')
  return dues
}

/** What could not be read, in words; the calendar keeps showing everything else. */
export function calendarHandoffIssues(reads: HandoffReads, history: boolean): string[] {
  const loads: WorkLoad<HandoffQueue>[] = [
    reads.receivedOpen,
    reads.sent,
    ...(history ? [reads.receivedHistory] : [])
  ]
  const issues = new Set<string>()
  for (const load of loads) {
    if (load.phase === 'error') {
      issues.add(
        translate(
          'calendar.handoffsUnavailable',
          'Handoff due dates could not be read: {{error}}',
          {
            error: load.message
          }
        )
      )
    }
  }
  if (reads.sent.phase === 'not-served') {
    issues.add(
      translate(
        'calendar.handoffsSentNotServed',
        'Due dates of handoffs you sent are not available from this server.'
      )
    )
  }
  return [...issues]
}

/** The handoff due dates for the calendar, read through the same store the Work list uses. */
export function useCalendarHandoffs(scope: string, showFinished: boolean, employee: string) {
  const { reads, names, refresh } = useBackofficeWorkViews(scope, true, undefined, {
    history: showFinished
  })
  const { receivedOpen, receivedHistory, sent } = reads
  const dues = useMemo(
    () => calendarHandoffDues({ receivedOpen, receivedHistory, sent }, employee),
    [receivedOpen, receivedHistory, sent, employee]
  )
  const issues = useMemo(
    () => calendarHandoffIssues({ receivedOpen, receivedHistory, sent }, showFinished),
    [receivedOpen, receivedHistory, sent, showFinished]
  )
  return { dues, issues, names, refresh }
}
