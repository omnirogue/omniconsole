import { describe, expect, it } from 'vitest'
import { receivedRow, sentRow } from './backoffice-work-rows'
import type { WorkQueueThread } from './backoffice-work-views'

/**
 * Tab membership for the Orcha → hub bridge. An agent step is mirrored as an `fyi` thread the
 * owner sends to themselves; the hub's attention view never lists an fyi handed to its reader,
 * so the thread can only enter the tabs through the sent view.
 */
function thread(patch: Partial<WorkQueueThread>): WorkQueueThread {
  return {
    id: 'hth_step',
    board_task_id: null,
    author_employee_id: 'emp_sal',
    recipient_employee_id: 'emp_sal',
    title: '🤖 Claude: research',
    state: 'open',
    action: 'fyi',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-14T12:00:00Z',
    files: [],
    reviews: [],
    ...patch
  } as WorkQueueThread
}

describe('agent-step fyi threads in the work tabs', () => {
  it('an open fyi thread to self is Waiting for, never Needs you', () => {
    const row = sentRow(thread({}))
    expect(row.waitingFor).toBe(true)
    expect(row.needsYou).toBe(false)
    expect(row.kind).toBe('fyi')
  })

  it('a done entry resolves the thread and it leaves both tabs', () => {
    const row = sentRow(thread({ state: 'resolved' }))
    expect(row.waitingFor).toBe(false)
    expect(row.needsYou).toBe(false)
  })

  it('a failure reply flips the thread into Needs you as a reply', () => {
    const row = sentRow(thread({ state: 'replied' }))
    expect(row.needsYou).toBe(true)
    expect(row.waitingFor).toBe(false)
    expect(row.kind).toBe('reply')
  })

  it('a person handoff received and open is Needs you; resolved is neither', () => {
    const open = receivedRow(thread({ author_employee_id: 'emp_uma', action: 'review' }))
    expect(open.needsYou).toBe(true)
    expect(open.waitingFor).toBe(false)
    const resolved = receivedRow(
      thread({
        author_employee_id: 'emp_uma',
        action: 'review',
        state: 'resolved'
      })
    )
    expect(resolved.needsYou).toBe(false)
    expect(resolved.waitingFor).toBe(false)
  })

  it('a session request (decide) sent to the owner waits for them and lands with them', () => {
    const request = thread({
      recipient_employee_id: 'emp_uma',
      action: 'decide'
    })
    expect(sentRow(request).waitingFor).toBe(true)
    expect(
      receivedRow({
        ...request,
        author_employee_id: 'emp_sal',
        recipient_employee_id: 'emp_uma'
      }).needsYou
    ).toBe(true)
  })
})
