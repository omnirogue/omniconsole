/**
 * The BFF's member Todo payload reduced to what the Tasks views render. Every field
 * is optional-tolerant: a malformed row is dropped, never completed with a guess.
 */
import {
  BACKOFFICE_TODO_CURSOR,
  type BackofficeTodoCounts,
  type BackofficeTodoItem,
  type BackofficeTodoPrimaryAction,
  type BackofficeTodoResult
} from '../../shared/backoffice-work-types'
import { readHandoffQuestionOptions } from '../../shared/console-handoff-question'

export type RawTodoPayload = {
  ok?: unknown
  employee_id?: unknown
  generated_at?: unknown
  items?: unknown
  awaiting_verification?: unknown
  next_cursor?: unknown
  counts?: unknown
  reason?: unknown
  detail?: unknown
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

const HANDOFF_THREAD_ID = /^hth_[A-Za-z0-9_-]{1,128}$/

/** Keep only the descriptive half of the hub's prepared action; its path is never executed from a read. */
function normalizePrimaryAction(raw: unknown): BackofficeTodoPrimaryAction | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const action = raw as Record<string, unknown>
  const decision =
    typeof action.handoff_decision === 'object' && action.handoff_decision !== null
      ? (action.handoff_decision as Record<string, unknown>)
      : null
  const threadId = asString(decision?.thread_id)
  const options = readHandoffQuestionOptions(decision?.options)
  const recommended = asString((decision?.recommended as { value?: unknown } | null)?.value)
  return {
    label: asString(action.label),
    method: asString(action.method),
    external: action.external === true,
    handoff_thread_id: threadId && HANDOFF_THREAD_ID.test(threadId) ? threadId : null,
    handoff_options: options,
    handoff_recommended:
      recommended && options?.some((option) => option.value === recommended) ? recommended : null
  }
}

function normalizeCounts(raw: unknown): BackofficeTodoCounts | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const counts = raw as Record<string, unknown>
  return {
    total: nonNegativeInteger(counts.total),
    blocked: nonNegativeInteger(counts.blocked),
    replies_waiting: nonNegativeInteger(counts.replies_waiting),
    awaiting_verification: nonNegativeInteger(counts.awaiting_verification)
  }
}

export function normalizeTodoItem(raw: unknown): BackofficeTodoItem | null {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const item = raw as Record<string, unknown>
  const taskId = asString(item.task_id)
  const title = asString(item.title)
  if (!taskId || !title) {
    return null
  }
  const blocker = typeof item.blocker === 'object' && item.blocker !== null ? item.blocker : null
  const pr =
    typeof item.pr === 'object' && item.pr !== null ? (item.pr as Record<string, unknown>) : null
  return {
    task_id: taskId,
    title,
    company_slug: asString(item.company_slug),
    status: asString(item.status),
    state_revision:
      typeof item.state_revision === 'number' &&
      Number.isSafeInteger(item.state_revision) &&
      item.state_revision >= 0
        ? item.state_revision
        : null,
    execution_state: asString(item.execution_state),
    role: asString(item.role),
    kind: asString(item.kind),
    primary_action: normalizePrimaryAction(item.primary_action),
    qa_policy_id: asString(item.qa_policy_id),
    decision_id: asString(item.decision_id),
    replies_waiting_count: nonNegativeInteger(item.replies_waiting_count),
    owner_employee_id: asString(item.owner_employee_id),
    defer_until: asString(item.defer_until),
    kanban_status: asString(item.kanban_status),
    kanban_reason: asString(item.kanban_reason),
    kanban_disposition: asString(item.kanban_disposition),
    kanban_eligible: typeof item.kanban_eligible === 'boolean' ? item.kanban_eligible : undefined,
    parent_task_id: asString(item.parent_task_id),
    verified_at: asString(item.verified_at),
    verification_failed_at: asString(item.verification_failed_at),
    triage_state: asString(item.triage_state),
    paused_at: asString(item.paused_at),
    next_action: asString(item.next_action),
    due_date: asString(item.due_date),
    updated_at: asString(item.updated_at),
    session_id: asString(item.session_id),
    goal_id: asString(item.goal_id),
    project_id: asString(item.project_id),
    org_unit_id: asString(item.org_unit_id),
    who: asString(item.who),
    href: asString(item.href),
    why: asString(item.why),
    what: asString(item.what),
    blocker: blocker
      ? {
          kind: asString((blocker as Record<string, unknown>).kind),
          detail: asString((blocker as Record<string, unknown>).detail)
        }
      : null,
    ask: asString(item.ask),
    pr: pr
      ? {
          repo: asString(pr.repo),
          number: typeof pr.number === 'number' ? pr.number : null,
          url: asString(pr.url),
          checks_state: asString(pr.checks_state),
          review_decision: asString(pr.review_decision)
        }
      : null
  }
}

function normalizeList(raw: unknown[]): BackofficeTodoItem[] {
  // Why: the hub answers one row per (task, role); the list shows a card once, under its first role.
  const seen = new Set<string>()
  return raw
    .map(normalizeTodoItem)
    .filter((item): item is BackofficeTodoItem => item !== null)
    .filter((item) => {
      if (seen.has(item.task_id)) {
        return false
      }
      seen.add(item.task_id)
      return true
    })
}

export function normalizeTodoPayload(
  payload: RawTodoPayload,
  baseUrl: string
): Extract<BackofficeTodoResult, { ok: true }> {
  const items = Array.isArray(payload.items) ? normalizeList(payload.items) : []
  const counts = normalizeCounts(payload.counts)
  const cursor = asString(payload.next_cursor)
  const nextCursor = cursor && BACKOFFICE_TODO_CURSOR.test(cursor) ? cursor : null
  return {
    ok: true,
    baseUrl,
    employeeId: asString(payload.employee_id),
    generatedAt: asString(payload.generated_at),
    items,
    awaitingVerification: Array.isArray(payload.awaiting_verification)
      ? normalizeList(payload.awaiting_verification)
      : null,
    counts,
    nextCursor,
    // Why: a paging BFF says itself whether a page follows; an older one caps its projection
    // (200) without saying so, and only its total tells that this is a first page.
    truncated:
      'next_cursor' in payload
        ? nextCursor !== null
        : counts?.total != null && counts.total > items.length
  }
}
