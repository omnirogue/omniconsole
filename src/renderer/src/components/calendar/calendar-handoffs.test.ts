// @vitest-environment happy-dom
/**
 * Handoff and review due dates for the Calendar, read from the Work list's own thread reads:
 * the ones this person sent (Waiting for) and the ones sent to them (Needs you, and the finished
 * history), each once, with the other party named, and a failed read said rather than hidden.
 */
import { describe, expect, it } from 'vitest'
import { upNextDueAt } from '../../../../shared/up-next-person-due'
import { calendarHandoffDues, calendarHandoffIssues } from './calendar-handoffs'
import { handoffReads, handoffThread } from './calendar-handoffs.test-fixture'

describe('calendarHandoffDues', () => {
  it('lists every sent and received thread that has a due date, and only those', () => {
    const dues = calendarHandoffDues(handoffReads())
    expect(
      dues.map((due) => [due.key, due.ask, due.direction, due.otherId, due.viewerId, due.finished])
    ).toEqual([
      ['handoff:hth_review', 'review', 'received', 'emp_sal', 'emp_me', false],
      ['handoff:hth_done', 'handoff', 'received', 'emp_sal', 'emp_me', true],
      ['handoff:hth_sent', 'handoff', 'sent', 'emp_iris', 'emp_me', false]
    ])
    expect(dues.find((due) => due.key === 'handoff:hth_sent')?.dueAt).toBe(
      upNextDueAt('2026-09-21')
    )
  })

  it('opens each one as the same row the Work list shows', () => {
    const [review, , sent] = calendarHandoffDues(handoffReads())
    expect(review?.row).toMatchObject({ key: 'handoff:hth_review', source: 'received-handoff' })
    expect(sent?.row).toMatchObject({ key: 'handoff:hth_sent', source: 'sent-handoff' })
    expect(sent?.row.thread?.id).toBe('hth_sent')
  })

  it('shows a thread that is in two reads once', () => {
    const reads = handoffReads()
    const mine = handoffThread({
      id: 'hth_self',
      recipient_employee_id: 'emp_me',
      due_at: upNextDueAt('2026-09-24')
    })
    reads.receivedOpen = { phase: 'ready', value: { assignee: 'emp_me', threads: [mine] } }
    reads.sent = { phase: 'ready', value: { assignee: 'emp_me', view: 'sent', threads: [mine] } }
    expect(calendarHandoffDues(reads).filter((due) => due.key === 'handoff:hth_self')).toHaveLength(
      1
    )
  })

  it('keeps only the threads the chosen person is on', () => {
    expect(calendarHandoffDues(handoffReads(), 'emp_iris').map((due) => due.key)).toEqual([
      'handoff:hth_sent'
    ])
  })

  it('keeps the threads already read while a refresh fails', () => {
    const reads = handoffReads()
    const previous = reads.sent.phase === 'ready' ? reads.sent.value : null
    reads.sent = { phase: 'error', message: 'Hub unreachable', previous }
    expect(calendarHandoffDues(reads).map((due) => due.key)).toContain('handoff:hth_sent')
  })
})

describe('calendarHandoffIssues', () => {
  it('says a failed handoff read, once, and nothing when every read answered', () => {
    expect(calendarHandoffIssues(handoffReads(), true)).toEqual([])
    const reads = handoffReads()
    reads.receivedOpen = { phase: 'error', message: 'Hub unreachable', previous: null }
    reads.sent = { phase: 'error', message: 'Hub unreachable', previous: null }
    expect(calendarHandoffIssues(reads, false)).toEqual([
      'Handoff due dates could not be read: Hub unreachable'
    ])
  })

  it('reads the finished history only when finished work is shown', () => {
    const reads = handoffReads()
    reads.receivedHistory = { phase: 'error', message: 'History unavailable', previous: null }
    expect(calendarHandoffIssues(reads, false)).toEqual([])
    expect(calendarHandoffIssues(reads, true)).toEqual([
      'Handoff due dates could not be read: History unavailable'
    ])
  })

  it('says when this server does not list the handoffs sent', () => {
    const reads = handoffReads()
    reads.sent = { phase: 'not-served' }
    expect(calendarHandoffIssues(reads, false)).toEqual([
      'Due dates of handoffs you sent are not available from this server.'
    ])
  })
})
