import type { WorkFollowUpRow, WorkViewsInput } from '../../../../../shared/backoffice-work-views'
import type { HandoffQueue } from '../../../../../shared/console-handoff-contract'
import type { ConsoleWorkflowJob } from '../../../../../shared/console-workflow-types'
import type { PeerMessageThread } from '../../../../../shared/peer-message-contract'
import type { TodoFeed } from './backoffice-work-pages'

/** The reads the work store keeps, each in its own honest state, and the projection input built from them. */
export type RosterEntry = { id: string; name: string }

export type WorkLoad<T> =
  | { phase: 'idle' }
  | { phase: 'loading'; previous: T | null }
  | { phase: 'ready'; value: T }
  | { phase: 'error'; message: string; previous: T | null }
  /** The server does not offer this read yet (an older hub or BFF). */
  | { phase: 'not-served' }

export type WorkReads = {
  todo: WorkLoad<TodoFeed>
  receivedOpen: WorkLoad<HandoffQueue>
  receivedHistory: WorkLoad<HandoffQueue>
  sent: WorkLoad<HandoffQueue>
  roster: WorkLoad<RosterEntry[]>
  /** Workflow stages assigned to this person (approve, decide, review); a sixth obligation feed. */
  humanActions: WorkLoad<ConsoleWorkflowJob[]>
  /** Peer messages in this person's shared projects: asked of them, or asked by them. */
  messages: WorkLoad<PeerMessageThread[]>
}

/** A read's current value: what is ready, or what a refresh still shows while it runs. */
export function valueOf<T>(load: WorkLoad<T>): T | null {
  return load.phase === 'ready' ? load.value : load.phase === 'loading' ? load.previous : null
}

/** The projection input from the current reads; a failed or unoffered read becomes null (a named gap). */
export function toWorkViewsInput(
  reads: WorkReads,
  followUps: readonly WorkFollowUpRow[]
): WorkViewsInput {
  const todo = valueOf(reads.todo)
  // Why: the Todo names the viewer; when it failed, the handoff queues name the same person.
  const employeeId =
    todo?.employeeId ??
    valueOf(reads.receivedOpen)?.assignee ??
    valueOf(reads.sent)?.assignee ??
    null
  return {
    employeeId,
    todo: todo
      ? {
          items: todo.items,
          // Why: older mains omit these fields entirely; unknown stays unknown.
          awaitingVerification: todo.awaitingVerification ?? null,
          truncated: Boolean(todo.nextCursor) || (todo.truncated ?? false)
        }
      : null,
    received: {
      open: valueOf(reads.receivedOpen)?.threads ?? null,
      // Why: an idle history was never asked for (no lens needed it); that is not a failed read.
      history:
        reads.receivedHistory.phase === 'idle'
          ? []
          : (valueOf(reads.receivedHistory)?.threads ?? null)
    },
    sent: valueOf(reads.sent)?.threads ?? null,
    sentFailed: reads.sent.phase === 'error',
    truncated: {
      received: Boolean(valueOf(reads.receivedOpen)?.next_cursor),
      history: Boolean(valueOf(reads.receivedHistory)?.next_cursor),
      sent: Boolean(valueOf(reads.sent)?.next_cursor)
    },
    followUps,
    humanJobs: valueOf(reads.humanActions),
    humanJobsFailed: reads.humanActions.phase === 'error',
    messages: valueOf(reads.messages),
    messagesFailed: reads.messages.phase === 'error'
  }
}
