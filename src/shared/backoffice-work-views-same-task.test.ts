import { describe, expect, it } from 'vitest'
import type { BackofficeTodoItem } from './backoffice-work-types'
import { buildWorkViews, type WorkQueueThread, type WorkViewsInput } from './backoffice-work-views'

const ME = 'emp_sal'

function todo(overrides: Partial<BackofficeTodoItem> & { task_id: string }): BackofficeTodoItem {
  return { title: overrides.task_id, updated_at: '2026-09-11T10:00:00Z', ...overrides }
}

function thread(overrides: Partial<WorkQueueThread> & { id: string }): WorkQueueThread {
  return {
    board_task_id: 'btk_3',
    author_employee_id: ME,
    recipient_employee_id: 'emp_iris',
    title: overrides.id,
    state: 'open',
    action: 'review',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-11T09:00:00Z',
    files: [],
    reviews: [],
    ...overrides
  }
}

function input(
  items: BackofficeTodoItem[],
  overrides: Partial<WorkViewsInput> = {}
): WorkViewsInput {
  return {
    employeeId: ME,
    todo: { items, awaitingVerification: [], truncated: false },
    received: { open: [], history: [] },
    sent: [],
    followUps: [],
    humanJobs: [],
    messages: [],
    ...overrides
  }
}

describe('buildWorkViews on one task', () => {
  it('counts a returned reply once when the sent thread already carries it', () => {
    const views = buildWorkViews(
      input([todo({ task_id: 'btk_3', who: 'emp_iris', replies_waiting_count: 1 })], {
        sent: [thread({ id: 'hth_r', state: 'replied', unread_entries: 1 })]
      })
    )
    expect(views.needsYou.map((row) => row.key)).toEqual(['handoff:hth_r'])
    expect(views.counts.needsYou).toBe(1)
    expect(views.all.find((row) => row.source === 'task')).toMatchObject({
      kind: 'work',
      needsYou: false,
      repliesWaiting: 0
    })
  })

  it('keeps a reply on the Todo when the loaded threads do not hold all of it', () => {
    const views = buildWorkViews(
      input([todo({ task_id: 'btk_3', who: 'emp_iris', replies_waiting_count: 2 })], {
        sent: [thread({ id: 'hth_r', state: 'replied', unread_entries: 1 })]
      })
    )
    expect(views.counts.needsYou).toBe(2)
  })

  it('counts waiting on Iris once when an open request to him is on the same task', () => {
    const views = buildWorkViews(
      input([todo({ task_id: 'btk_3', who: 'emp_iris' })], { sent: [thread({ id: 'hth_w' })] })
    )
    expect(views.waitingFor.map((row) => row.key)).toEqual(['handoff:hth_w'])
    expect(views.counts.waitingFor).toBe(1)
  })

  it('keeps waiting on someone the open request does not name', () => {
    const views = buildWorkViews(
      input([todo({ task_id: 'btk_3', who: 'emp_gamma' })], { sent: [thread({ id: 'hth_w' })] })
    )
    expect(views.counts.waitingFor).toBe(2)
  })

  it('keeps two reviewers on one task as two obligations', () => {
    const views = buildWorkViews(
      input([todo({ task_id: 'btk_3', who: 'emp_iris' })], {
        sent: [
          thread({ id: 'hth_iris' }),
          thread({ id: 'hth_gamma', recipient_employee_id: 'emp_gamma' })
        ]
      })
    )
    expect(views.waitingFor.map((row) => row.key).sort()).toEqual([
      'handoff:hth_gamma',
      'handoff:hth_iris'
    ])
  })

  it('still puts a Todo that is my move in Needs You beside a request on the same task', () => {
    const views = buildWorkViews(
      input([todo({ task_id: 'btk_3', who: ME, replies_waiting_count: 1 })], {
        sent: [thread({ id: 'hth_r', state: 'replied', unread_entries: 1 })]
      })
    )
    expect(views.needsYou.map((row) => row.source).sort()).toEqual(['sent-handoff', 'task'])
  })

  it('never counts an FYI on the same task as a decision', () => {
    const fyi = thread({
      id: 'hth_f',
      action: 'fyi',
      author_employee_id: 'emp_iris',
      recipient_employee_id: ME,
      unread_entries: 1
    })
    const views = buildWorkViews(
      input([todo({ task_id: 'btk_3', who: 'emp_iris', replies_waiting_count: 1 })], {
        received: { open: [fyi], history: [] }
      })
    )
    expect(views.counts).toMatchObject({ needsYou: 1, decisions: 0 })
    expect(views.needsYou[0]?.kind).toBe('fyi')
  })
})

describe('buildWorkViews during a run', () => {
  it("shows the owner's live run as a run, never as a person to wait for", () => {
    const views = buildWorkViews(input([todo({ task_id: 'btk_9', who: 'ses_live01' })]))
    expect(views.waitingFor[0]).toMatchObject({ nextActor: { kind: 'run', thenIds: [] } })
    expect(views.needsYou).toEqual([])
  })
})
