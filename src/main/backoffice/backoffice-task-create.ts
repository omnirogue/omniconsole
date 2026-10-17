/**
 * Create a hub card from the IDE (main-process only, same bearer as the other card writes).
 *
 * A person is involved only through a card: when work leaves a session for someone and
 * the workspace has no card yet, this creates one, so the handoff has a place to land.
 */
import type { BackofficeTaskCreationResult } from '../../shared/backoffice-work-types'
import { isBoardTaskId } from '../../shared/board-task-id'
import { fitsCardTagBounds, newTaskTags, unfitCompanySlugs } from '../../shared/proposed-task'
import { postTaskWithTags, createdCardTags } from './backoffice-task-create-request'
import { captureConsoleWorkflowPerson } from './console-workflow-person'
import {
  TASK_DESCRIPTION_MAX,
  taskDueDate,
  taskPriority,
  taskSequentialSteps,
  taskPlan,
  type TaskPlan
} from '../../shared/task-details'
import { getBackofficeSnapshot } from './backoffice-config'

/** Mirrors the console relay's `board-create` rule: title required, text bounded. */
const TITLE_MAX = 500
export const IDE_CARD_SOURCE = 'omniconsole-ide'

/** The people on the card, deduplicated, in the order they were named. */
function actors(ids: readonly string[] | undefined): string[] {
  const seen = new Set<string>()
  for (const id of ids ?? []) {
    const trimmed = (id ?? '').trim()
    if (trimmed && EMPLOYEE_ID.test(trimmed)) {
      seen.add(trimmed)
    }
  }
  return [...seen].slice(0, 12)
}

function createdCardId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const row = payload as Record<string, unknown>
  // Why: the hub answers the created row and spells its id more than one way across routes.
  for (const key of ['id', 'task_id', 'board_task_id']) {
    const value = row[key]
    if (typeof value === 'string' && isBoardTaskId(value.trim())) {
      return value.trim()
    }
  }
  // Why: the console answers a delegated write as {ok, status, payload: <the hub's row>}.
  for (const nested of [row.task, row.board_task, row.payload, row.result]) {
    const found = nested && typeof nested === 'object' ? createdCardId(nested) : null
    if (found) {
      return found
    }
  }
  return null
}

const EMPLOYEE_ID = /^[A-Za-z0-9._-]{1,64}$/
/** The console relay's own shape for a filing id; anything else is dropped, never sent. */
const FILING_ID = /^[A-Za-z0-9._:-]{1,64}$/

function filing(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  return trimmed && FILING_ID.test(trimmed) ? trimmed : null
}

export async function createBackofficeTask(input: {
  title: string
  description?: string
  acceptanceCriteria?: string
  taskPlan?: TaskPlan | null
  dueDate?: string | null
  priority?: string
  sequentialSteps?: string[]
  /** The signed-in person's hub employee id: the card's custodian, so its files may be attached. */
  ownerEmployeeId?: string
  /** Where the work belongs. Without these the card is a stray in the estate's own filing. */
  companyId?: string
  /** The primary company's slug; keeps it out of the extra-company tags. */
  companySlug?: string
  /** Other companies the work is for, tagged `company:<slug>` at creation. */
  additionalCompanySlugs?: readonly string[]
  /** An idea for the Kanban's Proposed lane: tagged `proposed` at creation. */
  proposed?: boolean
  unitId?: string
  projectId?: string
  /** The company goal this work serves; the hub refuses to run a card without one. */
  goalId?: string
  /** Everyone involved, the owner included; the hub keeps them as the card's actors. */
  actorIds?: readonly string[]
}): Promise<BackofficeTaskCreationResult> {
  const title = (typeof input?.title === 'string' ? input.title : '').trim().slice(0, TITLE_MAX)
  if (!title) {
    return { ok: false, message: 'A new task needs a title.' }
  }
  const description = typeof input.description === 'string' ? input.description.trim() : ''
  if (description.length > TASK_DESCRIPTION_MAX) {
    return { ok: false, message: `Task notes must fit within ${TASK_DESCRIPTION_MAX} characters.` }
  }
  if (input.dueDate != null && !taskDueDate.safeParse(input.dueDate).success) {
    return { ok: false, message: 'Choose a valid due date.' }
  }
  if (input.priority !== undefined && !taskPriority.safeParse(input.priority).success) {
    return { ok: false, message: 'Choose a valid priority.' }
  }
  const steps = taskSequentialSteps.optional().safeParse(input.sequentialSteps)
  if (!steps.success) {
    return { ok: false, message: 'Use up to 100 steps, each with 1–2000 characters.' }
  }
  const plan = taskPlan.nullable().optional().safeParse(input.taskPlan)
  if (!plan.success) {
    return { ok: false, message: 'Check the task steps, people and completion outcome.' }
  }
  if (
    input.acceptanceCriteria !== undefined &&
    (typeof input.acceptanceCriteria !== 'string' ||
      input.acceptanceCriteria.length > TASK_DESCRIPTION_MAX)
  ) {
    return {
      ok: false,
      message: `The task outcome must fit within ${TASK_DESCRIPTION_MAX} characters.`
    }
  }
  const snapshot = getBackofficeSnapshot()
  if (!snapshot.configured) {
    return { ok: false, message: snapshot.message }
  }
  const captured = await captureConsoleWorkflowPerson()
  if (!captured.ok) {
    return { ok: false, message: captured.error.message }
  }
  const { bearer, baseUrl, principal, isCurrent } = captured.data
  const tags = newTaskTags({
    proposed: input.proposed,
    primarySlug: input.companySlug,
    additionalCompanySlugs: input.additionalCompanySlugs
  })
  let response: Response
  try {
    if (!isCurrent()) {
      return { ok: false, message: 'The signed-in account changed. Reopen the task form.' }
    }
    response = await postTaskWithTags(
      `${baseUrl}/api/collab/board`,
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }
      },
      {
        ...(tags.length > 0 && fitsCardTagBounds(tags) ? { tags } : {}),
        title,
        card_class: 'CAPTURE',
        source: IDE_CARD_SOURCE,
        ...(description ? { description } : {}),
        ...(input.acceptanceCriteria !== undefined
          ? { acceptance_criteria: input.acceptanceCriteria }
          : {}),
        ...(plan.data !== undefined ? { task_plan: plan.data } : {}),
        ...(input.dueDate ? { due_date: input.dueDate } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(steps.data !== undefined ? { sequential_steps: steps.data } : {}),
        // Why: the hub attaches a card's files only for its owner or a participant; a card
        // the person creates to hand work on is theirs, else the summary upload is refused.
        ...(typeof input.ownerEmployeeId === 'string' && EMPLOYEE_ID.test(input.ownerEmployeeId)
          ? { owner_employee_id: input.ownerEmployeeId }
          : {}),
        // Why: a card with no company and no department lands in the estate's unfiled
        // bucket, where nobody looks. The desktop knows the place, so it says it.
        ...(filing(input.companyId) ? { org_company_id: filing(input.companyId) } : {}),
        ...(filing(input.unitId) ? { org_unit_id: filing(input.unitId) } : {}),
        ...(filing(input.projectId) ? { project_id: filing(input.projectId) } : {}),
        // Why: without a goal the hub refuses to dispatch the card at all ("Complete the
        // task's company, goal and department"), so the desktop files it at creation.
        ...(filing(input.goalId) ? { goal_id: filing(input.goalId) } : {}),
        ...(actors(input.actorIds).length > 0 ? { actors: actors(input.actorIds) } : {})
      },
      isCurrent
    )
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach ${snapshot.baseUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`
    }
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined)
    return {
      ok: false,
      message:
        response.status === 401
          ? 'Your OmniConsole sign-in needs to be renewed under Settings → OmniConsole Account.'
          : 'Your account does not have permission to create a task here. Check the selected company and your task permissions.'
    }
  }
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok) {
    const detail =
      payload && typeof payload === 'object'
        ? ((payload as Record<string, unknown>).detail ??
          (payload as Record<string, unknown>).reason)
        : null
    return {
      ok: false,
      message:
        typeof detail === 'string' && detail.trim()
          ? detail.trim()
          : `The backoffice answered HTTP ${response.status}.`
    }
  }
  const taskId = createdCardId(payload)
  if (!taskId) {
    return {
      ok: false,
      message: 'The backoffice created the task but answered without its id. Open Tasks to find it.'
    }
  }
  // Why named: a company the person ticked must never vanish from the card in silence.
  const dropped = unfitCompanySlugs(input.additionalCompanySlugs ?? [])
  if (tags.length === 0 && dropped.length === 0) {
    return { ok: true, taskId, title, principal }
  }
  if (!fitsCardTagBounds(tags)) {
    return { ok: true, taskId, title, principal, tagsApplied: false, warning: TAGS_TOO_MANY }
  }
  const savedTags = createdCardTags(payload)
  const warning =
    tags.length > 0 && !tags.every((tag) => savedTags?.includes(tag))
      ? await tagCreatedCard(
          baseUrl,
          bearer,
          taskId,
          [...new Set([...(savedTags ?? []), ...tags])],
          createdRevision(payload),
          isCurrent
        )
      : null
  if (warning) {
    return { ok: true, taskId, title, principal, tagsApplied: false, warning }
  }
  return dropped.length > 0
    ? { ok: true, taskId, title, principal, tagsApplied: true, warning: droppedCompanies(dropped) }
    : { ok: true, taskId, title, principal, tagsApplied: true }
}

const TAGS_TOO_MANY =
  'The task is saved, but it names more companies than a card can carry; edit its tags from the task.'

function droppedCompanies(slugs: readonly string[]): string {
  return `The task is saved, but a company name is too long for a card tag and was left off: ${slugs.join(', ')}.`
}

/** The revision the hub answered the create with, when it did; the filing PATCH names it. */
function createdRevision(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const row = payload as Record<string, unknown>
  if (
    typeof row.state_revision === 'number' &&
    Number.isSafeInteger(row.state_revision) &&
    row.state_revision >= 0
  ) {
    return row.state_revision
  }
  for (const nested of [row.task, row.board_task, row.payload, row.result]) {
    const found = nested && typeof nested === 'object' ? createdRevision(nested) : null
    if (found !== null) {
      return found
    }
  }
  return null
}

async function tagCreatedCard(
  baseUrl: string,
  bearer: string,
  taskId: string,
  tags: readonly string[],
  expectedRevision: number | null,
  isCurrent: () => boolean
): Promise<string | null> {
  const unapplied = (why: string) =>
    `The task is saved, but its Proposed/company tags were not applied (${why}). Edit them from the task.`
  if (!isCurrent()) {
    return unapplied('the signed-in account changed')
  }
  if (expectedRevision === null) {
    return unapplied('the create response had no revision for a safe tag repair')
  }
  let response: Response
  try {
    response = await fetch(`${baseUrl}/api/collab/board/${taskId}`, {
      method: 'PATCH',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(expectedRevision !== null ? { expected_revision: expectedRevision } : {}),
        tags
      })
    })
  } catch (error) {
    return unapplied(error instanceof Error ? error.message : String(error))
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return null
  }
  let detail: unknown = null
  try {
    const body = (await response.json()) as Record<string, unknown>
    detail = body.detail ?? body.reason
  } catch {
    detail = null
  }
  return unapplied(
    typeof detail === 'string' && detail.trim() ? detail.trim() : `HTTP ${response.status}`
  )
}
