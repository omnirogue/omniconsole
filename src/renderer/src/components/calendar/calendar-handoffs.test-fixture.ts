import type { WorkReads } from '@/components/task-page/backoffice/backoffice-work-reads'
import type { HandoffQueue } from '../../../../shared/console-handoff-contract'
import { upNextDueAt } from '../../../../shared/up-next-person-due'

type Thread = HandoffQueue['threads'][number]
type HandoffReads = Pick<WorkReads, 'receivedOpen' | 'receivedHistory' | 'sent'>

/** One handoff thread as the hub's queue lists it; the viewer is `emp_me`. */
export function handoffThread(patch: Partial<Thread> & { id: string }): Thread {
  return {
    board_task_id: null,
    author_employee_id: 'emp_me',
    recipient_employee_id: 'emp_iris',
    title: patch.id,
    state: 'open',
    action: 'edit',
    due_at: null,
    parent_thread_id: null,
    delivery_id: null,
    updated: '2026-09-18T10:00:00Z',
    files: [],
    reviews: [],
    ...patch
  }
}

const queue = (threads: Thread[], view?: string): HandoffQueue => ({
  assignee: 'emp_me',
  ...(view ? { view } : {}),
  threads
})

/** What the Work store holds: a sent handoff, a received review, a finished one, and a dateless one. */
export function handoffReads(): HandoffReads {
  return {
    receivedOpen: {
      phase: 'ready',
      value: queue([
        handoffThread({
          id: 'hth_review',
          title: 'Check the signing',
          author_employee_id: 'emp_sal',
          recipient_employee_id: 'emp_me',
          action: 'review',
          state: 'replied',
          due_at: upNextDueAt('2026-09-22', '15:30')
        }),
        handoffThread({
          id: 'hth_nodue',
          author_employee_id: 'emp_sal',
          recipient_employee_id: 'emp_me'
        })
      ])
    },
    receivedHistory: {
      phase: 'ready',
      value: queue([
        handoffThread({
          id: 'hth_done',
          title: 'Old handoff',
          author_employee_id: 'emp_sal',
          recipient_employee_id: 'emp_me',
          state: 'resolved',
          due_at: upNextDueAt('2026-09-23')
        })
      ])
    },
    sent: {
      phase: 'ready',
      value: queue(
        [
          handoffThread({
            id: 'hth_sent',
            title: 'Ship the receipts',
            due_at: upNextDueAt('2026-09-21')
          })
        ],
        'sent'
      )
    }
  }
}
