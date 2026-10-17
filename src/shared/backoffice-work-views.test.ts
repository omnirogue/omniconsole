import { describe, expect, it } from 'vitest'
import type { BackofficeTodoItem } from './backoffice-work-types'
import type { ConsoleWorkflowJob } from './console-workflow-types'
import type { PeerMessageThread } from './peer-message-contract'
import {
  cardRow,
  cardRowKey,
  buildWorkViews,
  type WorkFollowUpRow,
  type WorkQueueThread,
  type WorkViewsInput
} from './backoffice-work-views'

const ME = 'emp_sal'

function todo(overrides: Partial<BackofficeTodoItem> & { task_id: string }): BackofficeTodoItem {
  return { title: overrides.task_id, updated_at: '2026-09-11T10:00:00Z', ...overrides }
}

function thread(overrides: Partial<WorkQueueThread> & { id: string }): WorkQueueThread {
  return {
    board_task_id: 'btk_aa',
    author_employee_id: 'emp_gamma',
    recipient_employee_id: ME,
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

function followUp(overrides: Partial<WorkFollowUpRow> & { id: string }): WorkFollowUpRow {
  return {
    taskId: 'btk_cc',
    title: 'Final deliverables',
    recipientIds: ['emp_iris'],
    action: 'review',
    state: 'waiting-for-run',
    threadIds: [],
    detail: null,
    dueAt: null,
    updatedAt: '2026-09-11T11:00:00Z',
    ...overrides
  }
}

function job(
  overrides: Partial<ConsoleWorkflowJob> & { id: string; task_id: string },
  action: ConsoleWorkflowJob['policy']['workflow']['action'] = 'approve'
): ConsoleWorkflowJob {
  return {
    node_id: null,
    title: overrides.id,
    status: 'queued',
    actor_type: 'human',
    provider: null,
    model: null,
    effort: null,
    repo: null,
    machine: null,
    pr_url: null,
    attempt: 1,
    lease_generation: 1,
    owned_paths: null,
    updated_at: '2026-09-11T12:00:00Z',
    policy: {
      workflow: {
        version: 1,
        digest: 'a'.repeat(64),
        mode: 'hybrid',
        dispatch_id: 'wf_1',
        workflow_id: 'wf_1',
        key: overrides.id,
        actor_type: 'human',
        actor_id: ME,
        action,
        after: [],
        after_keys: [],
        require_merged: [],
        approval_ancestors: []
      }
    },
    blockers: [],
    workflow_state: 'awaiting_human',
    can_decide: true,
    ...overrides
  }
}

function input(overrides: Partial<WorkViewsInput> = {}): WorkViewsInput {
  return {
    employeeId: ME,
    todo: { items: [], awaitingVerification: [], truncated: false },
    received: { open: [], history: [] },
    sent: [],
    followUps: [],
    humanJobs: [],
    messages: [],
    ...overrides
  }
}

describe('buildWorkViews', () => {
  it('keeps a decision the hub derived (mail, workflow) out of Needs You; All still lists it', () => {
    const views = buildWorkViews(
      input({
        todo: {
          items: [todo({ task_id: 'btk_1', kind: 'decision', who: ME, decision_id: 'dec_1' })],
          awaitingVerification: [],
          truncated: false
        }
      })
    )
    expect(views.needsYou).toEqual([])
    expect(views.waitingFor).toEqual([])
    expect(views.all.map((row) => row.key)).toEqual(['todo:btk_1::dec_1:task'])
    expect(views.all[0]?.needsYou).toBe(true)
    expect(views.counts).toEqual({ needsYou: 0, decisions: 0, waitingFor: 0 })
  })

  it("lists a handoff decision the Todo carries as a person's ask, and counts it as a decision", () => {
    const views = buildWorkViews(
      input({
        todo: {
          items: [
            todo({
              task_id: 'btk_1',
              kind: 'decision',
              who: ME,
              decision_id: 'dec_1',
              primary_action: { label: 'Decide', handoff_thread_id: 'hth_1' }
            })
          ],
          awaitingVerification: [],
          truncated: false
        }
      })
    )
    expect(views.needsYou.map((row) => row.key)).toEqual(['todo:btk_1::dec_1:task'])
    expect(views.counts).toEqual({ needsYou: 1, decisions: 1, waitingFor: 0 })
  })

  it('moves a task whose next move belongs to someone else to Waiting For', () => {
    const views = buildWorkViews(
      input({
        todo: {
          items: [todo({ task_id: 'btk_2', who: 'emp_iris', kind: 'fyi' })],
          awaitingVerification: [],
          truncated: false
        }
      })
    )
    expect(views.needsYou).toEqual([])
    expect(views.waitingFor[0]).toMatchObject({
      taskId: 'btk_2',
      nextActor: { kind: 'person', id: 'emp_iris' },
      kind: 'work'
    })
  })

  it('brings a returned reply back to Needs You even when someone else owns the next step', () => {
    const views = buildWorkViews(
      input({
        todo: {
          items: [todo({ task_id: 'btk_3', who: 'emp_iris', replies_waiting_count: 2 })],
          awaitingVerification: [],
          truncated: false
        }
      })
    )
    expect(views.needsYou[0]).toMatchObject({ kind: 'reply', repliesWaiting: 2 })
    expect(views.counts.decisions).toBe(0)
  })

  it('does not count a handoff decision twice through the Todo and the handoff queue', () => {
    const views = buildWorkViews(
      input({
        todo: {
          items: [
            todo({
              task_id: 'btk_4',
              kind: 'decision',
              who: ME,
              primary_action: { label: 'Approve recommendation: A', handoff_thread_id: 'hth_x' }
            })
          ],
          awaitingVerification: [],
          truncated: false
        },
        received: { open: [thread({ id: 'hth_x', action: 'decide' })], history: [] }
      })
    )
    expect(views.needsYou).toHaveLength(1)
    expect(views.needsYou[0]?.thread?.id).toBe('hth_x')
    expect(views.all).toHaveLength(1)
  })

  it('keeps separate reviewer obligations on one task as separate rows', () => {
    const views = buildWorkViews(
      input({
        received: {
          open: [
            thread({ id: 'hth_a', author_employee_id: 'emp_gamma' }),
            thread({ id: 'hth_b', author_employee_id: 'emp_iris' })
          ],
          history: []
        }
      })
    )
    expect(views.needsYou.map((row) => row.key)).toEqual(['handoff:hth_a', 'handoff:hth_b'])
  })

  it('keeps an FYI request out of the decision count', () => {
    const views = buildWorkViews(
      input({ received: { open: [thread({ id: 'hth_f', action: 'fyi' })], history: [] } })
    )
    expect(views.counts).toMatchObject({ needsYou: 1, decisions: 0 })
    expect(views.needsYou[0]?.kind).toBe('fyi')
  })

  it('shows a saved follow-up as "run finishing, then Iris" without claiming delivery', () => {
    const views = buildWorkViews(input({ followUps: [followUp({ id: 'fu_1' })] }))
    expect(views.waitingFor[0]).toMatchObject({
      source: 'follow-up',
      nextActor: { kind: 'run', thenIds: ['emp_iris'] },
      state: 'waiting-for-run'
    })
    expect(views.needsYou).toEqual([])
  })

  it('lets the delivered thread replace the rule once the server shows it', () => {
    const delivered = followUp({ id: 'fu_2', state: 'delivered', threadIds: ['hth_s'] })
    const sent = thread({
      id: 'hth_s',
      author_employee_id: ME,
      recipient_employee_id: 'emp_iris',
      board_task_id: 'btk_cc'
    })
    const views = buildWorkViews(input({ followUps: [delivered], sent: [sent] }))
    expect(views.waitingFor.map((row) => row.key)).toEqual(['handoff:hth_s'])
    expect(views.waitingFor[0]?.nextActor).toEqual({ kind: 'person', id: 'emp_iris' })
  })

  it("returns Iris's answer to Needs You and keeps finished work only in All", () => {
    const answered = thread({
      id: 'hth_r',
      author_employee_id: ME,
      recipient_employee_id: 'emp_iris',
      state: 'replied',
      unread_entries: 1
    })
    const finished = thread({ id: 'hth_done', state: 'resolved' })
    const views = buildWorkViews(
      input({ sent: [answered], received: { open: [], history: [finished] } })
    )
    expect(views.needsYou.map((row) => row.key)).toEqual(['handoff:hth_r'])
    expect(views.waitingFor).toEqual([])
    expect(views.all.map((row) => row.key).sort()).toEqual(['handoff:hth_done', 'handoff:hth_r'])
  })

  it('turns a failed follow-up into a recoverable exception in All, not a Needs You ask', () => {
    const views = buildWorkViews(
      input({ followUps: [followUp({ id: 'fu_3', state: 'exception', detail: 'Run failed' })] })
    )
    // Why: a rule that failed is an honest failure. Nobody asked the reader anything, so it is
    // an exception row in All: not Needs You, not theirs to move, and waiting on nobody.
    expect(views.needsYou).toEqual([])
    expect(views.all[0]).toMatchObject({
      kind: 'exception',
      why: 'Run failed',
      needsYou: false,
      waitingFor: false
    })
    expect(views.all[0]!.nextActor).not.toEqual({ kind: 'me' })
  })

  it("makes a follow-up the reader's move only through the ask of an open request", () => {
    const asked = followUp({
      id: 'fu_4',
      state: 'exception',
      detail: 'Run failed',
      ask: 'Sign claude in again.'
    })
    const views = buildWorkViews(input({ followUps: [asked] }))
    expect(views.all[0]).toMatchObject({
      kind: 'exception',
      why: 'Sign claude in again.',
      nextActor: { kind: 'me' },
      needsYou: true,
      waitingFor: false
    })
    // An ask that says nothing asks nothing: the row stays the failure it is.
    for (const ask of [null, '  ']) {
      const silent = buildWorkViews(input({ followUps: [{ ...asked, ask }] }))
      expect(silent.needsYou).toEqual([])
      expect(silent.all[0]).toMatchObject({ why: 'Run failed', needsYou: false })
    }
  })

  it('names every missing feed instead of showing an empty list as complete', () => {
    const views = buildWorkViews(
      input({
        todo: { items: [], awaitingVerification: null, truncated: true },
        received: { open: null, history: null },
        sent: null
      })
    )
    expect(views.gaps).toEqual([
      'todo-truncated',
      'verification-not-served',
      'received-unavailable',
      'history-unavailable',
      'sent-not-served'
    ])
    expect(buildWorkViews(input({ todo: null })).gaps).toContain('todo-unavailable')
    expect(buildWorkViews(input({ humanJobs: null })).gaps).toContain('human-jobs-not-served')
    expect(buildWorkViews(input({ humanJobs: null, humanJobsFailed: true })).gaps).toContain(
      'human-jobs-unavailable'
    )
  })

  it('orders decisions before other work and earlier due dates first', () => {
    const handoff = (id: string) => ({ primary_action: { handoff_thread_id: id } })
    const views = buildWorkViews(
      input({
        todo: {
          items: [
            todo({ task_id: 'btk_w', who: ME, due_date: '2026-09-12', ...handoff('hth_w') }),
            todo({
              task_id: 'btk_d',
              who: ME,
              kind: 'approval',
              due_date: '2026-09-20',
              ...handoff('hth_d')
            }),
            todo({
              task_id: 'btk_e',
              who: ME,
              blocker: { kind: 'failed', detail: 'x' },
              ...handoff('hth_e')
            })
          ],
          awaitingVerification: [],
          truncated: false
        }
      })
    )
    expect(views.needsYou.map((row) => row.taskId)).toEqual(['btk_d', 'btk_e', 'btk_w'])
  })
})

describe('buildWorkViews human decision stages', () => {
  it('lists a stage opened for my decision in All, keyed by the job, never in Needs You', () => {
    const views = buildWorkViews(input({ humanJobs: [job({ id: 'job_a', task_id: 'btk_j1' })] }))
    // Why: a workflow stage is the run asking, not a person; Needs You is people's handoffs only.
    expect(views.needsYou).toEqual([])
    expect(views.all).toHaveLength(1)
    expect(views.all[0]).toMatchObject({
      key: 'job:job_a',
      source: 'human-job',
      taskId: 'btk_j1',
      kind: 'approval',
      nextActor: { kind: 'me' },
      actionLabel: 'approve',
      state: 'awaiting_human',
      needsYou: true
    })
    expect(views.counts).toEqual({ needsYou: 0, decisions: 0, waitingFor: 0 })
    expect(
      buildWorkViews(input({ humanJobs: [job({ id: 'job_d', task_id: 'btk_j1' }, 'decide')] }))
        .all[0]?.kind
    ).toBe('decision')
  })

  it('keeps two decision stages on one card as two rows beside the card itself', () => {
    const views = buildWorkViews(
      input({
        todo: {
          items: [todo({ task_id: 'btk_j2', who: ME })],
          awaitingVerification: [],
          truncated: false
        },
        humanJobs: [
          job({ id: 'job_x', task_id: 'btk_j2' }),
          job({ id: 'job_y', task_id: 'btk_j2' }, 'decide')
        ]
      })
    )
    expect(views.all.map((row) => row.key).sort()).toEqual([
      'job:job_x',
      'job:job_y',
      'todo:btk_j2:::task'
    ])
    expect(views.needsYou).toEqual([])
  })

  it("folds a stage the Todo already lists as that card's decision", () => {
    const views = buildWorkViews(
      input({
        todo: {
          items: [todo({ task_id: 'btk_j3', who: ME, kind: 'decision', decision_id: 'job_same' })],
          awaitingVerification: [],
          truncated: false
        },
        humanJobs: [
          job({ id: 'job_same', task_id: 'btk_j3' }),
          job({ id: 'job_same', task_id: 'btk_other' })
        ]
      })
    )
    expect(views.all.map((row) => row.key).sort()).toEqual([
      'job:job_same',
      'todo:btk_j3::job_same:task'
    ])
    expect(views.all.find((row) => row.key === 'job:job_same')?.taskId).toBe('btk_other')
  })

  it('shows a stage the run still holds as waiting, with its blockers as the reason', () => {
    const views = buildWorkViews(
      input({
        humanJobs: [
          job({ id: 'job_w', task_id: 'btk_j4', can_decide: false, blockers: ['Build not done'] })
        ]
      })
    )
    expect(views.needsYou).toEqual([])
    expect(views.waitingFor[0]).toMatchObject({
      key: 'job:job_w',
      nextActor: { kind: 'run', thenIds: [] },
      why: 'Build not done',
      waitingFor: true
    })
  })
})

describe('buildWorkViews peer messages', () => {
  function message(
    overrides: Partial<PeerMessageThread> & { id: string; state: PeerMessageThread['state'] }
  ): PeerMessageThread {
    return {
      project_id: 'prj_shared',
      task_id: null,
      sender_session_id: 'sess_gamma',
      recipient_session_id: 'sess_sal',
      sender_employee_id: 'emp_gamma',
      recipient_employee_id: ME,
      purpose: 'question',
      summary: 'Can you check the Q3 numbers?\nThe deck is attached.',
      created_at: 1_789_200_000,
      delivered_at: 1_789_200_060,
      replied_at: null,
      resolved_at: null,
      expires_at: null,
      reply: null,
      ...overrides
    }
  }

  it('lists an unanswered message asked of me in All as a reply, titled by its first line', () => {
    const views = buildWorkViews(
      input({ messages: [message({ id: 'msg_1', state: 'delivered', task_id: 'btk_aaaa' })] })
    )
    // Why: a peer message is read-only here and not a handoff; it never enters Needs You.
    expect(views.needsYou).toEqual([])
    expect(views.all.map((row) => row.key)).toEqual(['message:msg_1'])
    expect(views.all[0]).toMatchObject({
      source: 'message',
      kind: 'reply',
      title: 'Can you check the Q3 numbers?',
      taskId: 'btk_aaaa',
      direction: 'received',
      nextActor: { kind: 'me' },
      needsYou: true,
      updatedAt: new Date(1_789_200_060 * 1000).toISOString()
    })
    expect(views.counts).toEqual({ needsYou: 0, decisions: 0, waitingFor: 0 })
  })

  it('shows a message I asked and nobody answered as waiting on its recipient', () => {
    const views = buildWorkViews(
      input({
        messages: [
          message({
            id: 'msg_2',
            state: 'queued',
            sender_employee_id: ME,
            recipient_employee_id: 'emp_iris'
          })
        ]
      })
    )
    expect(views.needsYou).toEqual([])
    expect(views.waitingFor.map((row) => row.key)).toEqual(['message:msg_2'])
    expect(views.waitingFor[0]).toMatchObject({
      direction: 'sent',
      kind: 'work',
      nextActor: { kind: 'person', id: 'emp_iris' }
    })
  })

  it('keeps answered, resolved and expired messages only in All', () => {
    const views = buildWorkViews(
      input({
        messages: [
          message({ id: 'msg_3', state: 'replied', replied_at: 1_789_200_500 }),
          message({ id: 'msg_4', state: 'resolved', resolved_at: 1_789_200_600 }),
          message({ id: 'msg_5', state: 'expired' })
        ]
      })
    )
    expect(views.needsYou).toEqual([])
    expect(views.waitingFor).toEqual([])
    expect(views.all.map((row) => row.key)).toEqual([
      'message:msg_4',
      'message:msg_3',
      'message:msg_5'
    ])
    expect(views.all.map((row) => row.state)).toEqual(['resolved', 'replied', 'expired'])
  })

  it('names a card only when the message carries a real board id', () => {
    const rows = buildWorkViews(
      input({
        messages: [
          message({ id: 'msg_6', state: 'delivered', task_id: 'not-a-card' }),
          message({ id: 'msg_7', state: 'delivered', task_id: undefined })
        ]
      })
    ).all
    expect(rows.map((row) => row.taskId)).toEqual([null, null])
  })

  it('files no message and names the gap when no feed said who the viewer is', () => {
    const views = buildWorkViews(
      input({
        employeeId: null,
        messages: [message({ id: 'msg_1', state: 'delivered' })]
      })
    )
    const row = views.all.find((candidate) => candidate.key === 'message:msg_1')
    expect(row).toMatchObject({ needsYou: false, waitingFor: false })
    expect(row?.direction).toBeUndefined()
    expect(views.needsYou).toEqual([])
    expect(views.waitingFor).toEqual([])
    expect(views.gaps).toContain('viewer-unknown')
    expect(buildWorkViews(input({ employeeId: null, messages: [] })).gaps).not.toContain(
      'viewer-unknown'
    )
  })

  it('names the messages feed when it failed or is not served', () => {
    expect(buildWorkViews(input({ messages: null })).gaps).toEqual(['messages-not-served'])
    expect(buildWorkViews(input({ messages: null, messagesFailed: true })).gaps).toEqual([
      'messages-unavailable'
    ])
    expect(buildWorkViews(input()).gaps).toEqual([])
  })
})

describe('cardRow', () => {
  it('shows a card read by id as a read-only row until it loads, then with its facts', () => {
    const loading = cardRow('btk_x1', null, ME)
    expect(loading).toMatchObject({
      key: cardRowKey('btk_x1'),
      title: 'btk_x1',
      card: null,
      needsYou: false
    })
    const loaded = cardRow(
      'btk_x1',
      {
        id: 'btk_x1',
        title: 'Check ide',
        status: 'open',
        owner_employee_id: 'emp_uma',
        next_action: 'Claim it',
        due_date: '2026-09-12'
      },
      ME
    )
    expect(loaded).toMatchObject({
      title: 'Check ide',
      state: 'open',
      what: 'Claim it',
      dueAt: '2026-09-12',
      nextActor: { kind: 'person', id: 'emp_uma' }
    })
    expect(loaded.card?.id).toBe('btk_x1')
    expect(loaded.todo).toMatchObject({ task_id: 'btk_x1', status: 'open', href: '/board/btk_x1' })
    expect(loading.todo).toBeUndefined()
  })
})
