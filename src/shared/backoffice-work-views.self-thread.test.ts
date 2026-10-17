import { describe, expect, it } from 'vitest'
import { buildWorkViews, type WorkQueueThread, type WorkViewsInput } from './backoffice-work-views'

/**
 * A chain's agent step is mirrored as a thread the owner sends to themselves. It belongs in
 * Waiting For while it runs, and in neither tab once it is done.
 *
 * The hub's attention list already leaves such a thread out, but this view is first-wins per
 * thread id and reads the received side first — so if the thread ever arrives on that side, the
 * received row claims the key and a running step reads as urgent. The rule is enforced here too,
 * on the one fact that cannot change: the person sent it to themselves.
 */
function selfThread(patch: Partial<WorkQueueThread> = {}): WorkQueueThread {
  return {
    id: 'hth_step1',
    board_task_id: null,
    author_employee_id: 'emp_sal',
    recipient_employee_id: 'emp_sal',
    title: 'claude: Seedance lander',
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

function input(patch: Partial<WorkViewsInput> = {}): WorkViewsInput {
  return {
    employeeId: 'emp_sal',
    todo: { items: [], awaitingVerification: [], truncated: false },
    received: { open: [], history: [] },
    sent: [],
    sentFailed: false,
    truncated: { received: false, history: false, sent: false },
    followUps: [],
    humanJobs: [],
    messages: [],
    ...patch
  } as WorkViewsInput
}

describe('a thread the person sent to themselves', () => {
  it('sits in Waiting For while the step runs', () => {
    const views = buildWorkViews(input({ sent: [selfThread()] }))

    expect(views.waitingFor.map((row) => row.key)).toEqual(['handoff:hth_step1'])
    expect(views.needsYou).toEqual([])
  })

  it('stays out of Needs You even when the received side returns it too', () => {
    // The pessimistic case: a hub whose attention list does not exclude it, or a client that reads
    // the plain received view. Before this rule, the received row won the key and read as urgent.
    const views = buildWorkViews(
      input({ received: { open: [selfThread()], history: [] }, sent: [selfThread()] })
    )

    expect(views.needsYou).toEqual([])
    expect(views.waitingFor.map((row) => row.key)).toEqual(['handoff:hth_step1'])
    expect(views.counts).toMatchObject({ needsYou: 0, waitingFor: 1 })
  })

  it('leaves both tabs once the step is done', () => {
    const resolved = selfThread({ state: 'resolved' })
    const views = buildWorkViews(
      input({ received: { open: [resolved], history: [resolved] }, sent: [resolved] })
    )

    expect(views.needsYou).toEqual([])
    expect(views.waitingFor).toEqual([])
  })

  it('reaches Needs You when the step failed, because the reply is the person’s move', () => {
    const views = buildWorkViews(input({ sent: [selfThread({ state: 'replied' })] }))

    expect(views.needsYou.map((row) => row.key)).toEqual(['handoff:hth_step1'])
    expect(views.waitingFor).toEqual([])
  })

  it('never hides a real handoff from somebody else', () => {
    const fromUma = selfThread({
      id: 'hth_real',
      author_employee_id: 'emp_uma',
      action: 'review'
    })
    const views = buildWorkViews(input({ received: { open: [fromUma], history: [] } }))

    expect(views.needsYou.map((row) => row.key)).toEqual(['handoff:hth_real'])
  })
})
