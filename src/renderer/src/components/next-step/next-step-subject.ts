import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { BackofficeTodoItem } from '../../../../shared/backoffice-work-types'
import type { HandoffDetail } from '../../../../shared/console-handoff-contract'

/**
 * What the three controls act on. The same ＋ ⏳ ✓ sit on a running session, a card in
 * Tasks and a received handoff thread; what each control does underneath differs, the
 * question the person answers does not.
 */
export type NextStepSubject =
  | { kind: 'session'; session: SidebarSession }
  | { kind: 'card'; item: BackofficeTodoItem }
  | { kind: 'thread'; detail: HandoffDetail; viewer: string | null }

export function nextStepSubjectTitle(subject: NextStepSubject): string {
  switch (subject.kind) {
    case 'session':
      return subject.session.label
    case 'card':
      return subject.item.title
    case 'thread':
      return subject.detail.thread.title
  }
}

/** The card a people handoff lands on, when the subject already names one. */
export function nextStepSubjectTask(
  subject: NextStepSubject
): { id: string; title: string } | null {
  switch (subject.kind) {
    case 'session':
      return null
    case 'card':
      return { id: subject.item.task_id, title: subject.item.title }
    case 'thread': {
      // Why: a card-less thread names no task; people on it get a forward, never a card send.
      const { board_task_id: id, title } = subject.detail.thread
      return id ? { id, title } : null
    }
  }
}

/** Only the party a thread was sent to acts on it; the author sees it read-only here. */
export function isThreadRecipient(subject: NextStepSubject): boolean {
  return (
    subject.kind === 'thread' &&
    subject.viewer !== null &&
    subject.detail.thread.recipient_employee_id === subject.viewer
  )
}
