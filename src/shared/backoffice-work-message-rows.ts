import { isBoardTaskId } from './board-task-id'
import type { WorkRow } from './backoffice-work-views'
import {
  isPeerMessageOpen,
  peerMessageUpdatedAt,
  type PeerMessageThread
} from './peer-message-contract'

const TITLE_MAX = 160

/** A message is titled by its first non-empty line, the way a card is titled from a note. */
export function peerMessageTitle(thread: Pick<PeerMessageThread, 'summary' | 'purpose'>): string {
  const firstLine = thread.summary
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return (firstLine ?? thread.purpose.trim()).slice(0, TITLE_MAX)
}

/**
 * A peer message as one row: unanswered and addressed to this person, it needs them;
 * unanswered and sent by them, it waits on the recipient; an answer needs its sender.
 */
export function messageRow(thread: PeerMessageThread, employeeId: string | null): WorkRow {
  const open = isPeerMessageOpen(thread)
  // Why: without a viewer nothing says which way a message went, so it is neither ask nor wait.
  const known = employeeId !== null
  const toMe = known && thread.recipient_employee_id === employeeId
  const fromMe = known && thread.sender_employee_id === employeeId
  const ownChat = fromMe && thread.task_id === null
  const direction: WorkRow['direction'] = ownChat
    ? 'sent'
    : toMe
      ? 'received'
      : fromMe
        ? 'sent'
        : undefined
  const answerWaiting = fromMe && thread.state === 'replied'
  const needsYou = (open && toMe && !ownChat) || answerWaiting
  const waitingFor = open && fromMe && (!toMe || ownChat)
  return {
    key: `message:${thread.id}`,
    source: 'message',
    taskId:
      typeof thread.task_id === 'string' && isBoardTaskId(thread.task_id) ? thread.task_id : null,
    title: peerMessageTitle(thread),
    kind: needsYou ? 'reply' : 'work',
    nextActor: needsYou
      ? { kind: 'me' }
      : waitingFor
        ? { kind: 'person', id: thread.recipient_employee_id }
        : { kind: 'person', id: toMe ? thread.sender_employee_id : thread.recipient_employee_id },
    why: null,
    what: null,
    actionLabel: thread.communication_type ?? (thread.purpose.trim() || null),
    state: thread.state,
    dueAt: null,
    updatedAt: peerMessageUpdatedAt(thread),
    repliesWaiting: 0,
    needsYou,
    waitingFor,
    message: thread,
    ...(direction ? { direction } : {})
  }
}
