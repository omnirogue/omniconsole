import { describe, expect, it } from 'vitest'
import type { WorkRow, WorkViews } from '../../../../../shared/backoffice-work-views'
import { isWorkRowWaiting, withoutWaitingThreads, workRowWaitKeys } from './backoffice-work-waiting'

function row(overrides: Partial<WorkRow> & { key: string }): WorkRow {
  return {
    source: 'task',
    taskId: 'btk_1',
    title: overrides.key,
    kind: 'work',
    nextActor: { kind: 'me' },
    why: null,
    what: null,
    actionLabel: null,
    state: null,
    dueAt: null,
    updatedAt: null,
    repliesWaiting: 0,
    needsYou: true,
    waitingFor: false,
    ...overrides
  }
}

const thread = {
  id: 'hth_1',
  board_task_id: 'btk_1',
  author_employee_id: 'emp_gamma',
  recipient_employee_id: 'emp_sal',
  title: 'Review',
  state: 'open' as const,
  action: 'review' as const,
  due_at: null,
  parent_thread_id: null,
  delivery_id: null,
  updated: '2026-09-11T10:00:00Z',
  files: [],
  reviews: []
}

const message = {
  id: 'msg_1',
  project_id: 'prj',
  task_id: 'btk_1',
  sender_session_id: 's',
  recipient_session_id: 'r',
  sender_employee_id: 'emp_gamma',
  recipient_employee_id: 'emp_sal',
  purpose: 'question',
  summary: 'Which deck?',
  state: 'delivered' as const,
  created_at: 1,
  delivered_at: null,
  replied_at: null,
  resolved_at: null,
  expires_at: null,
  reply: null
}

function views(needsYou: WorkRow[]): WorkViews {
  return {
    needsYou,
    waitingFor: [],
    all: needsYou,
    counts: { needsYou: needsYou.length, decisions: 0, waitingFor: 0 },
    gaps: []
  }
}

describe('workRowWaitKeys', () => {
  it('answers to the message key before the card the message names', () => {
    expect(workRowWaitKeys(row({ key: 'message:msg_1', source: 'message', message }))).toEqual([
      'message:msg_1',
      'card:btk_1'
    ])
    expect(workRowWaitKeys(row({ key: 'card' }))).toEqual(['card:btk_1'])
  })

  it('lists every key the row’s controls can write: message, thread and card', () => {
    expect(workRowWaitKeys(row({ key: 'both', thread, message }))).toEqual([
      'message:msg_1',
      'thread:hth_1',
      'card:btk_1'
    ])
    expect(workRowWaitKeys(row({ key: 'none', taskId: null }))).toEqual([])
  })
})

describe('withoutWaitingThreads', () => {
  it('puts away a card row with an attached thread through either control’s key', () => {
    const merged = row({ key: 'todo:btk_1', thread })
    expect(withoutWaitingThreads(views([merged]), new Set(['card:btk_1'])).needsYou).toEqual([])
    expect(withoutWaitingThreads(views([merged]), new Set(['thread:hth_1'])).needsYou).toEqual([])
    expect(withoutWaitingThreads(views([merged]), new Set(['card:btk_9'])).needsYou).toEqual([
      merged
    ])
  })

  it('puts away a workflow stage when its card is put away', () => {
    const stage = row({ key: 'job:job_1', source: 'human-job', taskId: 'btk_1' })
    expect(isWorkRowWaiting(stage, new Set(['card:btk_1']))).toBe(true)
    const result = withoutWaitingThreads(views([stage]), new Set(['card:btk_1']))
    expect(result.needsYou).toEqual([])
    expect(result.counts.needsYou).toBe(0)
  })
})
