import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { HandoffQueue } from '../../../../shared/console-handoff-contract'
import type { PeerMessageThread } from '../../../../shared/peer-message-contract'
import { peerMessageTitle } from '../../../../shared/backoffice-work-message-rows'
import { toWorkViewsInput, type WorkReads } from '../task-page/backoffice/backoffice-work-reads'

function createArrivalTracker<T>(idOf: (item: T) => string, eligible: (item: T) => boolean) {
  let activeScope: string | null = null
  let seen = new Set<string>()
  return (scope: string, items: readonly T[]) => {
    if (scope !== activeScope) {
      activeScope = scope
      seen = new Set(items.map(idOf))
      return []
    }
    const arrivals: T[] = []
    for (const item of items) {
      const id = idOf(item)
      if (!seen.has(id) && eligible(item)) {
        arrivals.push(item)
      }
      seen.add(id)
    }
    return arrivals
  }
}

/** First read establishes a baseline; refreshes alert once for each newly received thread. */
export function createHandoffArrivalTracker() {
  const track = createArrivalTracker<HandoffQueue['threads'][number]>(
    (thread) => thread.id,
    (thread) => thread.state === 'open'
  )
  return (scope: string, queue: HandoffQueue) =>
    track(
      JSON.stringify([scope, queue.assignee]),
      queue.threads.filter((thread) => thread.recipient_employee_id === queue.assignee)
    )
}

export function createAgentReplyArrivalTracker() {
  const track = createArrivalTracker<PeerMessageThread>(
    (thread) => thread.reply!.id,
    (thread) => thread.state === 'replied'
  )
  return (scope: string, employeeId: string | null, messages: readonly PeerMessageThread[]) =>
    track(
      JSON.stringify([scope, employeeId]),
      messages.filter(
        (thread) =>
          employeeId !== null &&
          thread.sender_employee_id === employeeId &&
          thread.task_id === null &&
          thread.reply !== null
      )
    )
}

export function createInboxMessageArrivalTracker() {
  const track = createArrivalTracker<PeerMessageThread>(
    (thread) => thread.id,
    (thread) => thread.state === 'queued' || thread.state === 'delivered'
  )
  return (scope: string, employeeId: string | null, messages: readonly PeerMessageThread[]) =>
    track(
      JSON.stringify([scope, employeeId]),
      messages.filter(
        (thread) => employeeId !== null && thread.recipient_employee_id === employeeId
      )
    )
}

function showHandoffNotification(
  id: string,
  label: string,
  title: string,
  nativeTitle = title,
  destination?: 'inbox'
): void {
  toast.message(label, { description: title, id })
  void window.api.notifications
    ?.dispatch({
      source: 'handoff',
      notificationId: id,
      handoffTitle: nativeTitle,
      ...(destination ? { handoffDestination: destination } : {})
    })
    .catch(() => {
      /* The in-app notification remains available if native delivery fails. */
    })
}

const arrivalsSinceLastRead = createHandoffArrivalTracker()
export function notifyHandoffArrivals(scope: string, queue: HandoffQueue): void {
  for (const thread of arrivalsSinceLastRead(scope, queue)) {
    showHandoffNotification(
      `handoff:${scope}:${thread.id}`,
      translate('handoffNotifications.new', 'New handoff'),
      thread.title
    )
  }
}

const repliesSinceLastRead = createAgentReplyArrivalTracker()
const messagesSinceLastRead = createInboxMessageArrivalTracker()
export function notifyAgentReplyArrivals(
  scope: string,
  employeeId: string | null,
  messages: readonly PeerMessageThread[]
): void {
  for (const thread of repliesSinceLastRead(scope, employeeId, messages)) {
    const label = translate('handoffNotifications.reply', 'Agent replied')
    const title = peerMessageTitle(thread)
    showHandoffNotification(
      `handoff:${scope}:reply:${thread.reply!.id}`,
      label,
      title,
      `${label}: ${title}`
    )
  }
}

export function notifyWorkArrivals(scope: string, reads: WorkReads): void {
  if (reads.receivedOpen.phase === 'ready') {
    notifyHandoffArrivals(scope, reads.receivedOpen.value)
  }
  if (reads.messages.phase === 'ready') {
    const viewer = toWorkViewsInput(reads, []).employeeId
    notifyAgentReplyArrivals(scope, viewer, reads.messages.value)
    for (const thread of messagesSinceLastRead(scope, viewer, reads.messages.value)) {
      showHandoffNotification(
        `inbox:${scope}:${thread.id}`,
        translate('inbox.notifyOne', 'New Inbox message'),
        peerMessageTitle(thread),
        peerMessageTitle(thread),
        'inbox'
      )
    }
  }
}
