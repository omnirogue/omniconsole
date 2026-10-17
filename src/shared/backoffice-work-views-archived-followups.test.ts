import { describe, expect, it } from 'vitest'
import {
  buildWorkViews,
  type WorkFollowUpRow,
  type WorkQueueThread,
  type WorkViewsInput
} from './backoffice-work-views'

const delivered: WorkFollowUpRow = {
  id: 'chain_one',
  taskId: null,
  title: 'Deliver proposal',
  recipientIds: ['emp_other'],
  hasAgentRecipients: false,
  action: null,
  state: 'delivered',
  threadIds: ['hth_one'],
  detail: null,
  dueAt: null,
  updatedAt: '2026-09-14T20:00:00Z'
}
const sentThread: WorkQueueThread = {
  id: 'hth_one',
  board_task_id: null,
  title: 'Deliver proposal',
  author_employee_id: 'emp_me',
  recipient_employee_id: 'emp_other',
  state: 'open',
  action: null,
  due_at: null,
  parent_thread_id: null,
  delivery_id: null,
  updated: delivered.updatedAt!,
  files: [],
  reviews: []
}
const input = (extra: Partial<WorkViewsInput> = {}): WorkViewsInput => ({
  employeeId: 'emp_me',
  todo: { items: [], awaitingVerification: [], truncated: false },
  received: { open: [], history: [] },
  sent: [],
  followUps: [delivered],
  humanJobs: [],
  messages: [],
  ...extra
})

describe('archived delivered follow-up projection', () => {
  it('does not recreate a local waiting row after its acknowledged thread leaves the sent queue', () => {
    const before = buildWorkViews(input({ sent: [sentThread] }))
    expect(before.waitingFor.map((row) => row.key)).toEqual(['handoff:hth_one'])
    const archived = buildWorkViews(input())
    expect(archived.all).toEqual([])
    expect(archived.counts.waitingFor).toBe(0)
  })

  it('keeps an unarchived sibling thread when another recipient archives from the visible queue', () => {
    const views = buildWorkViews(
      input({
        sent: [sentThread],
        followUps: [
          {
            ...delivered,
            recipientIds: ['emp_other', 'emp_second'],
            threadIds: ['hth_one', 'hth_two']
          }
        ]
      })
    )
    expect(views.all.map((row) => row.key)).toEqual(['handoff:hth_one'])
  })

  it('preserves returned replies and completed canonical threads without resurrecting their rule', () => {
    expect(
      buildWorkViews(
        input({ sent: [{ ...sentThread, state: 'replied', unread_entries: 1 }] })
      ).needsYou.map((row) => row.key)
    ).toEqual(['handoff:hth_one'])
    const finished = buildWorkViews(input({ sent: [{ ...sentThread, state: 'resolved' }] }))
    expect(finished.all.map((row) => row.key)).toEqual(['handoff:hth_one'])
    expect(finished.waitingFor).toEqual([])
  })

  it('keeps the existing unavailable-sent fallback and its explicit gap', () => {
    const views = buildWorkViews(input({ sent: null, sentFailed: true }))
    expect(views.waitingFor.map((row) => row.key)).toEqual(['follow-up:chain_one'])
    expect(views.gaps).toContain('sent-unavailable')
  })

  it.each([
    { hasAgentRecipients: true },
    { hasAgentRecipients: undefined },
    { recipientIds: [], threadIds: [], hasAgentRecipients: true },
    { recipientIds: ['emp_other', 'emp_second'], threadIds: ['hth_one'] },
    { recipientIds: ['emp_other', 'emp_second'], threadIds: ['hth_one', 'hth_one'] },
    { threadIds: [] },
    { state: 'delivering' as const },
    { state: 'waiting-for-run' as const }
  ])('retains mixed, unknown or incomplete delivery fallback %j', (patch) => {
    const views = buildWorkViews(input({ followUps: [{ ...delivered, ...patch }] }))
    expect(views.waitingFor.map((row) => row.key)).toEqual(['follow-up:chain_one'])
  })

  it('does not use a local delivered row to bypass the sent queue page boundary', () => {
    const views = buildWorkViews(input({ truncated: { sent: true } }))
    expect(views.all).toEqual([])
    expect(views.gaps).toContain('sent-truncated')
  })
})
