/**
 * Backoffice work-item shapes (Tasks surface, provider 'backoffice').
 *
 * Mirrors the BFF's member-scoped GET /api/work/todo payload. Every field is
 * optional-tolerant: the list renders what the server actually sent, never a
 * fabricated default.
 */

import type { HandoffQuestionOption } from './console-handoff-question'

export type BackofficeTodoBlocker = {
  kind?: string | null
  detail?: string | null
}

export type BackofficeTodoPr = {
  repo?: string | null
  number?: number | null
  url?: string | null
  checks_state?: string | null
  review_decision?: string | null
}

/**
 * The hub's prepared action for an obligation, reduced to what the IDE may show.
 * Deliberately no `path` or `body`: a read payload never becomes a request here;
 * supported actions run through the existing typed, authenticated verbs.
 */
export type BackofficeTodoPrimaryAction = {
  label?: string | null
  method?: string | null
  external?: boolean
  /** The task-file handoff thread a handoff decision belongs to, when the hub names it. */
  handoff_thread_id?: string | null
  /** An agent's handoff question: the options it offered, answered by `decideHandoffQuestion`. */
  handoff_options?: HandoffQuestionOption[] | null
  /** The option the agent recommended, when it is one of `handoff_options`. */
  handoff_recommended?: string | null
}

export type BackofficeTodoCounts = {
  total: number | null
  blocked: number | null
  replies_waiting: number | null
  awaiting_verification: number | null
}

export type BackofficeTodoItem = {
  task_id: string
  title: string
  company_slug?: string | null
  status?: string | null
  kanban_status?: string | null
  kanban_reason?: string | null
  kanban_disposition?: string | null
  kanban_eligible?: boolean | null
  parent_task_id?: string | null
  verified_at?: string | null
  verification_failed_at?: string | null
  triage_state?: string | null
  state_revision?: number | null
  execution_state?: string | null
  role?: string | null
  /** The hub attention kind: approval, decision, qa or fyi (its catch-all, not an unread note). */
  kind?: string | null
  primary_action?: BackofficeTodoPrimaryAction | null
  qa_policy_id?: string | null
  decision_id?: string | null
  /** Unread replies on this task's handoff threads; null when the hub could not count them. */
  replies_waiting_count?: number | null
  owner_employee_id?: string | null
  defer_until?: string | null
  paused_at?: string | null
  next_action?: string | null
  due_date?: string | null
  updated_at?: string | null
  session_id?: string | null
  goal_id?: string | null
  project_id?: string | null
  /** The department this card is filed under; the tree of durable work groups by it. */
  org_unit_id?: string | null
  who?: string | null
  href?: string | null
  why?: string | null
  what?: string | null
  blocker?: BackofficeTodoBlocker | null
  ask?: string | null
  pr?: BackofficeTodoPr | null
}

/** The BFF's opaque Todo page position; the strict alphabet keeps it from carrying query syntax. */
export const BACKOFFICE_TODO_CURSOR = /^[A-Za-z0-9_-]{1,512}$/

/** One page of the Todo: omitted, the first page; `cursor` is a `nextCursor` a previous page answered. */
export type BackofficeTodoListArgs = { cursor?: string }

export type BackofficeTodoResult =
  | {
      ok: true
      notModified?: true
      baseUrl: string
      employeeId: string | null
      generatedAt: string | null
      items: BackofficeTodoItem[]
      /** Work this person delivered that still awaits verification; null when the server does not send it. */
      awaitingVerification: BackofficeTodoItem[] | null
      counts: BackofficeTodoCounts | null
      /** The position of the next page; null on the last page or on a server without Todo pages. */
      nextCursor: string | null
      /** More rows exist than this answer holds: a page follows, or an older server capped its list. */
      truncated: boolean
    }
  /** `stale`: the page position names a list snapshot the server let go; the walk restarts. */
  | { ok: false; message: string; stale?: boolean }

export type BackofficeAssignmentEvent = {
  baseUrl: string
  items: Pick<BackofficeTodoItem, 'task_id' | 'title' | 'company_slug' | 'due_date'>[]
}

/**
 * The outcome of archiving one assigned card. Archive is the backoffice's only
 * closing verb — idempotent, and NOT a delete (the hub exposes no unarchive),
 * so a repeated click is harmless and nothing is ever destroyed.
 */
export type BackofficeArchiveResult = { ok: true } | { ok: false; message: string }

export type BackofficeTaskCompletionResult =
  | { ok: true }
  /** needsEvidence: the hub's done-gate wants a result ref (PR/run URL or a sentence). */
  | { ok: false; message: string; stale?: boolean; needsEvidence?: boolean }

/** A card created from the IDE so work can be handed to a person. */
export type BackofficeTaskCreationResult =
  | {
      ok: true
      taskId: string
      title: string
      principal?: string
      /** False when the card exists but its Proposed/company tags were refused; `warning` says why. */
      tagsApplied?: boolean
      warning?: string
    }
  | { ok: false; message: string }

/**
 * One read of a backoffice feed the 3D office renders from. Read-only and
 * exact-path allowlisted in the main process; the renderer never sees the base
 * URL or the bearer.
 */
export type BackofficeFeedResult =
  | { ok: true; body: unknown; notModified?: true }
  | { ok: false; message: string }

/** A message the signed-in person sends from the Inbox to a colleague (POST /api/peer/send). */
export type BackofficeInboxSendArgs = {
  to: string
  text: string
  purpose: 'question' | 'status' | 'dependency'
  idempotencyKey: string
  references?: string[]
}
export type BackofficeInboxSendResult =
  | { ok: true; body: unknown }
  | { ok: false; message: string; code?: string }
