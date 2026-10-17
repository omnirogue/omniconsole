import { describe, expect, it } from 'vitest'
import type { WorkRow } from '../../../../../shared/backoffice-work-views'
import {
  describeNextActor,
  describeWorkGap,
  EMPTY_WORK_FILTER,
  filterWorkRows,
  gapsForLens,
  isWorkFilterNarrowing,
  narrowingWorkFilter,
  workEmptyText,
  workFilterChoices
} from './backoffice-work-labels'

const names = new Map([
  ['emp_iris', 'Iris'],
  ['emp_gamma', 'Gamma']
])

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
    needsYou: false,
    waitingFor: false,
    ...overrides
  }
}

describe('describeNextActor', () => {
  it('names the person and the requested action', () => {
    expect(
      describeNextActor(
        row({ key: 'a', nextActor: { kind: 'person', id: 'emp_iris' }, actionLabel: 'review' }),
        names
      )
    ).toBe('Waiting for Iris · review')
  })

  it('says a saved follow-up is waiting on the run before anyone has files', () => {
    expect(
      describeNextActor(
        row({ key: 'b', nextActor: { kind: 'run', thenIds: ['emp_iris', 'emp_gamma'] } }),
        names
      )
    ).toBe('Run finishing, then Iris, Gamma')
  })

  it('says a run is in progress when the hub names a session instead of a person', () => {
    expect(
      describeNextActor(
        row({ key: 'g', nextActor: { kind: 'run', thenIds: [] }, actionLabel: 'Watch run' }),
        names
      )
    ).toBe('Run in progress · Watch run')
  })

  it('falls back to the employee id when the roster does not know the person', () => {
    expect(
      describeNextActor(row({ key: 'c', nextActor: { kind: 'person', id: 'emp_new' } }), names)
    ).toBe('Waiting for emp_new')
  })

  it('never says "Waiting for" on work that is already finished or cancelled', () => {
    const finished = {
      nextActor: { kind: 'person', id: 'emp_gamma' } as const,
      actionLabel: 'review'
    }
    expect(describeNextActor(row({ key: 'd', state: 'resolved', ...finished }), names)).toBe(
      'Finished · review'
    )
    expect(describeNextActor(row({ key: 'e', state: 'done', ...finished }), names)).toBe(
      'Finished · review'
    )
    expect(describeNextActor(row({ key: 'f', state: 'cancelled', ...finished }), names)).toBe(
      'Cancelled · review'
    )
  })
})

describe('gapsForLens', () => {
  it('names every failed or short feed on every lens', () => {
    const gaps = ['sent-not-served', 'todo-truncated', 'received-unavailable'] as const
    for (const lens of ['needs-you', 'waiting', 'all'] as const) {
      expect(gapsForLens(lens, gaps)).toEqual([...gaps])
    }
  })

  it('reports finished history only on All, and only once it was asked for', () => {
    const gaps = ['history-unavailable', 'history-truncated', 'sent-unavailable'] as const
    expect(gapsForLens('all', gaps)).toEqual(['sent-unavailable'])
    expect(gapsForLens('needs-you', gaps, true)).toEqual(['sent-unavailable'])
    expect(gapsForLens('all', gaps, true)).toEqual([...gaps])
  })
})

describe('workEmptyText', () => {
  it('says the list could not be loaded when any feed failed', () => {
    const failed = 'This list could not be fully loaded.'
    expect(workEmptyText('needs-you', ['received-unavailable'])).toBe(failed)
    expect(workEmptyText('waiting', ['sent-unavailable'])).toBe(failed)
    expect(workEmptyText('needs-you', ['sent-unavailable'])).toBe(failed)
    expect(workEmptyText('all', ['history-unavailable'])).toBe(failed)
  })

  it('keeps the plain empty text when no feed failed', () => {
    expect(workEmptyText('needs-you', ['todo-truncated'])).toBe('Nothing needs you right now.')
    expect(workEmptyText('waiting', ['sent-not-served'])).toBe(
      'You are not waiting on anyone in these feeds.'
    )
    expect(workEmptyText('all', [])).toBe('No work matches this view.')
  })

  it('says a search narrowed the list to nothing, unless a feed failed', () => {
    expect(workEmptyText('needs-you', [], true)).toBe('No work matches this search.')
    expect(workEmptyText('needs-you', ['received-unavailable'], true)).toBe(
      'This list could not be fully loaded.'
    )
  })
})

describe('filterWorkRows', () => {
  const rows = [
    row({
      key: 'mine',
      needsYou: true,
      todo: { task_id: 'btk_1', title: 'x', company_slug: 'omnirogue' }
    }),
    row({
      key: 'iris',
      waitingFor: true,
      nextActor: { kind: 'person', id: 'emp_iris' },
      todo: { task_id: 'btk_2', title: 'y', company_slug: 'betacorp' }
    }),
    row({ key: 'done', state: 'done' }),
    row({ key: 'answered', state: 'replied' }),
    row({ key: 'cancelled', state: 'cancelled' })
  ]

  it('filters by status, person and project together', () => {
    expect(
      filterWorkRows(rows, { ...EMPTY_WORK_FILTER, status: 'finished' }).map((r) => r.key)
    ).toEqual(['done', 'cancelled'])
    expect(
      filterWorkRows(rows, { ...EMPTY_WORK_FILTER, person: 'emp_iris' }).map((r) => r.key)
    ).toEqual(['iris'])
    expect(
      filterWorkRows(rows, { ...EMPTY_WORK_FILTER, project: 'omnirogue' }).map((r) => r.key)
    ).toEqual(['mine'])
  })

  it('keeps an answered request that is still open out of Done and history', () => {
    expect(
      filterWorkRows(rows, { ...EMPTY_WORK_FILTER, status: 'other' }).map((r) => r.key)
    ).toEqual(['answered'])
  })

  const thread = {
    id: 'hth_7',
    board_task_id: 'btk_9',
    author_employee_id: 'emp_gamma',
    recipient_employee_id: 'emp_iris',
    title: 'Deck',
    state: 'replied' as const,
    action: null,
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-11T10:00:00Z',
    files: [],
    reviews: []
  }
  const threadRows = [
    row({ key: 'received', source: 'received-handoff', taskId: 'btk_9', title: 'Deck', thread }),
    row({
      key: 'sent',
      source: 'sent-handoff',
      title: 'Deck v2',
      needsYou: true,
      thread: { ...thread, id: 'hth_8', state: 'open' }
    }),
    row({
      key: 'rule',
      source: 'follow-up',
      taskId: null,
      nextActor: { kind: 'run', thenIds: ['emp_iris'] }
    }),
    row({ key: 'verify', source: 'awaiting-verification', taskId: 'btk_3' })
  ]

  it('matches "replied" by the thread state on either side, whatever the row status', () => {
    expect(
      filterWorkRows([...rows, ...threadRows], { ...EMPTY_WORK_FILTER, status: 'replied' }).map(
        (r) => r.key
      )
    ).toEqual(['received'])
    expect(
      filterWorkRows(rows, { ...EMPTY_WORK_FILTER, status: 'other' }).map((r) => r.key)
    ).toEqual(['answered'])
  })

  it('files a workflow stage assigned to me under Tasks, with its card', () => {
    const stage = row({ key: 'stage', source: 'human-job', taskId: 'btk_1', kind: 'approval' })
    const keys = (source: 'task' | 'received' | 'sent') =>
      filterWorkRows([stage], { ...EMPTY_WORK_FILTER, source }).map((r) => r.key)
    expect(keys('task')).toEqual(['stage'])
    expect(keys('received')).toEqual([])
    expect(keys('sent')).toEqual([])
  })

  it('files a message by which way it went: asked of me under received, asked by me under sent', () => {
    const message = {
      id: 'msg_1',
      project_id: 'prj',
      task_id: null,
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
    const asked = row({
      key: 'asked',
      source: 'message',
      taskId: null,
      message,
      direction: 'received'
    })
    const mine = row({
      key: 'mine',
      source: 'message',
      taskId: null,
      message: { ...message, id: 'msg_2', sender_employee_id: 'emp_sal' },
      direction: 'sent'
    })
    const keys = (source: 'task' | 'received' | 'sent') =>
      filterWorkRows([asked, mine], { ...EMPTY_WORK_FILTER, source }).map((r) => r.key)
    expect(keys('task')).toEqual([])
    expect(keys('received')).toEqual(['asked'])
    expect(keys('sent')).toEqual(['mine'])
    // Why: a message is found by its id and by the people on it, like a thread.
    expect(
      filterWorkRows([asked, mine], { ...EMPTY_WORK_FILTER, query: 'msg_2' }).map((r) => r.key)
    ).toEqual(['mine'])
    expect(
      filterWorkRows([asked, mine], { ...EMPTY_WORK_FILTER, query: 'gamma' }, names).map(
        (r) => r.key
      )
    ).toEqual(['asked'])
    expect(
      filterWorkRows([asked, mine], { ...EMPTY_WORK_FILTER, person: 'emp_gamma' }).map((r) => r.key)
    ).toEqual(['asked'])
  })

  it('narrows by source: cards, requests received, requests sent (with saved follow-ups)', () => {
    const all = [...rows, ...threadRows]
    const keys = (source: 'task' | 'received' | 'sent') =>
      filterWorkRows(all, { ...EMPTY_WORK_FILTER, source }).map((r) => r.key)
    expect(keys('task')).toEqual(['mine', 'iris', 'done', 'answered', 'cancelled', 'verify'])
    expect(keys('received')).toEqual(['received'])
    expect(keys('sent')).toEqual(['sent', 'rule'])
  })

  it('searches title, person name or id, card id and thread id, case-insensitively', () => {
    const all = [...rows, ...threadRows]
    const keys = (query: string) =>
      filterWorkRows(all, { ...EMPTY_WORK_FILTER, query }, names).map((r) => r.key)
    expect(keys('  DECK ')).toEqual(['received', 'sent'])
    expect(keys('gamma')).toEqual(['received', 'sent'])
    expect(keys('emp_iris')).toEqual(['iris', 'received', 'sent', 'rule'])
    expect(keys('btk_3')).toEqual(['verify'])
    expect(keys('hth_8')).toEqual(['sent'])
    expect(keys('nothing-like-this')).toEqual([])
  })

  it('matches everything on an empty query and finds people by id without a roster', () => {
    const all = [...rows, ...threadRows]
    expect(filterWorkRows(all, { ...EMPTY_WORK_FILTER, query: '   ' })).toHaveLength(all.length)
    expect(
      filterWorkRows(all, { ...EMPTY_WORK_FILTER, query: 'emp_gamma' }).map((r) => r.key)
    ).toEqual(['received', 'sent'])
  })

  it('keeps only search and source when narrowing a presorted list', () => {
    const filter = {
      ...EMPTY_WORK_FILTER,
      person: 'emp_iris',
      status: 'finished' as const,
      project: 'omnirogue',
      source: 'sent' as const,
      query: 'deck'
    }
    expect(narrowingWorkFilter(filter)).toEqual({
      ...EMPTY_WORK_FILTER,
      source: 'sent',
      query: 'deck'
    })
    expect(isWorkFilterNarrowing(EMPTY_WORK_FILTER)).toBe(false)
    expect(isWorkFilterNarrowing({ ...EMPTY_WORK_FILTER, query: ' ' })).toBe(false)
    expect(isWorkFilterNarrowing({ ...EMPTY_WORK_FILTER, source: 'task' })).toBe(true)
  })

  it('hides a put-away row from the needs-you status, and only there', () => {
    const waiting = new Set(['card:btk_1'])
    const keys = (status: 'all' | 'needs-you' | 'waiting') =>
      filterWorkRows(rows, { ...EMPTY_WORK_FILTER, status }, undefined, { waiting }).map(
        (r) => r.key
      )
    expect(keys('needs-you')).toEqual([])
    expect(keys('all')).toContain('mine')
    expect(keys('waiting')).toEqual(['iris'])
    expect(
      filterWorkRows(rows, { ...EMPTY_WORK_FILTER, status: 'needs-you' }).map((r) => r.key)
    ).toEqual(['mine'])
  })

  it('offers only people and projects present in the rows', () => {
    expect(workFilterChoices(rows)).toEqual({
      people: ['emp_iris'],
      projects: ['omnirogue', 'betacorp']
    })
  })

  it('never offers a run in progress as a person', () => {
    expect(
      workFilterChoices([row({ key: 'run', nextActor: { kind: 'run', thenIds: [] } })]).people
    ).toEqual([])
  })
})

describe('filterWorkRows over messages and put-away cards', () => {
  const message = {
    id: 'msg_1',
    project_id: 'prj',
    task_id: null,
    sender_session_id: 's',
    recipient_session_id: 'r',
    sender_employee_id: 'emp_gamma',
    recipient_employee_id: 'emp_sal',
    purpose: 'question',
    summary: 'Which deck?',
    state: 'replied' as const,
    created_at: 1,
    delivered_at: 2,
    replied_at: 3,
    resolved_at: null,
    expires_at: null,
    reply: null
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

  it('matches "replied" on an answered message as it does on a thread', () => {
    const answered = row({ key: 'message:msg_1', source: 'message', taskId: null, message })
    expect(filterWorkRows([answered], { ...EMPTY_WORK_FILTER, status: 'replied' })).toEqual([
      answered
    ])
    expect(filterWorkRows([answered], { ...EMPTY_WORK_FILTER, status: 'needs-you' })).toEqual([])
  })

  it('hides a card row with an attached thread under needs-you through either put-away key', () => {
    const merged = row({ key: 'todo:btk_1', needsYou: true, thread })
    const needsYou = { ...EMPTY_WORK_FILTER, status: 'needs-you' as const }
    expect(
      filterWorkRows([merged], needsYou, undefined, { waiting: new Set(['card:btk_1']) })
    ).toEqual([])
    expect(
      filterWorkRows([merged], needsYou, undefined, { waiting: new Set(['thread:hth_1']) })
    ).toEqual([])
    expect(
      filterWorkRows([merged], EMPTY_WORK_FILTER, undefined, { waiting: new Set(['card:btk_1']) })
    ).toEqual([merged])
  })
})

describe('describeWorkGap', () => {
  it('names an unknown viewer as its own gap', () => {
    expect(describeWorkGap('viewer-unknown')).toMatch(/who you are/)
  })

  it('never points a truncated list at a place that no longer exists', () => {
    for (const gap of ['todo-truncated', 'received-truncated', 'history-truncated'] as const) {
      expect(describeWorkGap(gap)).not.toMatch(/Handoffs/)
    }
    expect(describeWorkGap('todo-truncated')).toMatch(/load more/)
  })
})

describe('message gaps', () => {
  it('names a failed or unserved messages read on every lens', () => {
    expect(describeWorkGap('messages-unavailable')).toBe(
      'Messages from people in your shared projects could not be loaded.'
    )
    expect(describeWorkGap('messages-not-served')).toBe(
      'Messages from people are not provided by this server yet.'
    )
    for (const lens of ['needs-you', 'waiting', 'all'] as const) {
      expect(gapsForLens(lens, ['messages-unavailable', 'messages-not-served'])).toEqual([
        'messages-unavailable',
        'messages-not-served'
      ])
    }
    expect(workEmptyText('needs-you', ['messages-unavailable'])).toBe(
      'This list could not be fully loaded.'
    )
    expect(workEmptyText('needs-you', ['messages-not-served'])).toBe('Nothing needs you right now.')
  })
})

describe('human-job gaps', () => {
  it('names a failed or unserved workflow-decision read on every lens', () => {
    expect(describeWorkGap('human-jobs-unavailable')).toBe(
      'Decisions assigned to you in workflows could not be loaded.'
    )
    expect(describeWorkGap('human-jobs-not-served')).toBe(
      'Workflow decisions assigned to you are not provided by this server yet.'
    )
    for (const lens of ['needs-you', 'waiting', 'all'] as const) {
      expect(gapsForLens(lens, ['human-jobs-unavailable', 'human-jobs-not-served'])).toEqual([
        'human-jobs-unavailable',
        'human-jobs-not-served'
      ])
    }
    expect(workEmptyText('needs-you', ['human-jobs-unavailable'])).toBe(
      'This list could not be fully loaded.'
    )
  })
})
