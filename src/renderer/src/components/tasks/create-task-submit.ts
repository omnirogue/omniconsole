import { translate } from '@/i18n/i18n'
import { linkSessionToTask } from '@/store/session-task-store'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { sidebarSessionSourceIdentity } from '@/lib/sidebar-session-source-identity'
import { rememberAttachedTaskContext, type TaskContextSession } from '@/lib/session-task-context'
import { readSessionTaskContextForSource } from '@/lib/session-task-context-recovery'
import { selectConsoleAccountScope } from '@/lib/console-account-scope'
import { useAppStore } from '@/store'
import type { TaskDetailsPatch } from '../../../../shared/task-details'
import { invalidateBackofficeWork } from '@/components/task-page/backoffice/backoffice-work-store'

export type CreateTaskInput = TaskDetailsPatch & {
  title: string
  companyId?: string | null
  /** The primary company's slug, so extra companies are never tagged twice. */
  companySlug?: string | null
  /** Other companies the work is for; recorded on the card as `company:<slug>` tags. */
  additionalCompanySlugs?: readonly string[]
  /** An idea for the Proposed lane (the `proposed` tag) rather than committed work. */
  proposed?: boolean
  unitId?: string | null
  goalId?: string | null
  projectId?: string | null
  /** Everyone involved. The signed-in person is added by the caller as the owner. */
  actorIds?: readonly string[]
  ownerEmployeeId?: string | null
  /** The folder the conversation runs in, recorded so a later reader can find the work. */
  cwd?: string | null
  /** The agent behind the conversation, for the hub's session row. */
  provider?: string | null
  model?: string | null
}

export type CreateTaskOutcome =
  | {
      ok: true
      taskId: string
      title: string
      sessionId: string | null
      attached: boolean
      /** The conversation's row on the estate session ledger now names this task. */
      ledgerLinked: boolean
      principal?: string
      contextWarning?: string
      /** The card exists but part of its filing (Proposed/company tags) was refused. */
      warning?: string
    }
  | { ok: false; message: string }

/** Create an outcome without starting or inventing an execution session. */
export async function createTaskFromUi(input: CreateTaskInput): Promise<CreateTaskOutcome> {
  const accountScope = selectConsoleAccountScope(useAppStore.getState())
  const title = input.title.trim()
  if (!title) {
    return {
      ok: false,
      message: translate('tasks.needsTitle', 'A task needs a name before it can be tracked.')
    }
  }
  const created = await window.api.backoffice.createTask({
    title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.acceptanceCriteria !== undefined
      ? { acceptanceCriteria: input.acceptanceCriteria }
      : {}),
    ...(input.taskPlan !== undefined ? { taskPlan: input.taskPlan } : {}),
    ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.sequentialSteps !== undefined ? { sequentialSteps: input.sequentialSteps } : {}),
    ...(input.ownerEmployeeId ? { ownerEmployeeId: input.ownerEmployeeId } : {}),
    ...(input.companyId ? { companyId: input.companyId } : {}),
    ...(input.companySlug ? { companySlug: input.companySlug } : {}),
    ...(input.additionalCompanySlugs && input.additionalCompanySlugs.length > 0
      ? { additionalCompanySlugs: input.additionalCompanySlugs }
      : {}),
    ...(input.proposed ? { proposed: true } : {}),
    ...(input.unitId ? { unitId: input.unitId } : {}),
    ...(input.goalId ? { goalId: input.goalId } : {}),
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.actorIds && input.actorIds.length > 0 ? { actorIds: input.actorIds } : {})
  })
  if (created.ok && selectConsoleAccountScope(useAppStore.getState()) === accountScope) {
    invalidateBackofficeWork()
  }
  return created.ok
    ? { ...created, sessionId: null, attached: false, ledgerLinked: false }
    : created
}

/**
 * The estate's one session ledger is the console's `agent_sessions` row, which this desktop
 * already writes for every stamped pane. A conversation belongs to its task there whether or
 * not the hub has a session row for it, so this runs after the hub attempt whatever it
 * answered. False when this desktop holds no ledger row for the conversation.
 */
async function linkLedgerCard(
  sourceKey: string,
  taskId: string,
  title: string | null
): Promise<boolean> {
  try {
    const linked = await window.api?.sessionLedger?.linkCard?.(sourceKey, {
      cardId: taskId,
      cardTitle: title
    })
    return linked === true
  } catch {
    // Why: a ledger that cannot be told costs the link, never the task the person just made.
    return false
  }
}

/**
 * Create the outcome first, then link the exact existing conversation. A failed
 * link leaves one saved outcome and never starts another execution session.
 */
export async function createTaskFromSession(
  session: Pick<SidebarSession, 'label' | 'agent'> & TaskContextSession,
  input: CreateTaskInput
): Promise<CreateTaskOutcome> {
  const accountScope = selectConsoleAccountScope(useAppStore.getState())
  const created = await createTaskFromUi({
    ...input,
    description:
      input.description ??
      translate(
        'tasks.createdFromConversation',
        'Created from the OmniConsole conversation “{{conversation}}”.',
        { conversation: session.label }
      )
  })
  if (!created.ok) {
    return created
  }
  if (selectConsoleAccountScope(useAppStore.getState()) !== accountScope) {
    return {
      ok: true,
      taskId: created.taskId,
      title: created.title,
      ...(created.warning ? { warning: created.warning } : {}),
      sessionId: null,
      attached: false,
      ledgerLinked: false
    }
  }
  const attachment = await attachSessionToTask(session, created.taskId, {
    ...input,
    title: created.title
  })
  if (
    (attachment.attached || attachment.ledgerLinked) &&
    selectConsoleAccountScope(useAppStore.getState()) === accountScope
  ) {
    linkSessionToTask(sidebarSessionSourceIdentity(session)?.sourceKey ?? '', {
      taskId: created.taskId,
      ...(attachment.sessionId ? { sessionId: attachment.sessionId } : {}),
      title: created.title,
      at: new Date().toISOString()
    })
  }
  return {
    ok: true,
    taskId: created.taskId,
    title: created.title,
    ...(created.principal ? { principal: created.principal } : {}),
    ...(created.warning ? { warning: created.warning } : {}),
    sessionId: attachment.sessionId,
    attached: attachment.attached,
    ledgerLinked: attachment.ledgerLinked,
    ...(attachment.contextWarning || attachment.errorMessage
      ? {
          contextWarning:
            attachment.contextWarning ??
            `The task was saved, but the hub did not link this conversation: ${attachment.errorMessage} (${attachment.errorCode ?? 'refused'}).`
        }
      : {})
  }
}

/**
 * Join a conversation to a task that already exists — the second, third and later
 * session of one task. Registers the conversation with the hub first when it has no
 * session row yet.
 */
export async function attachSessionToTask(
  session: Pick<SidebarSession, 'label' | 'agent'> & TaskContextSession,
  taskId: string,
  input: AttachInput = {}
): Promise<AttachOutcome> {
  const accountScope = selectConsoleAccountScope(useAppStore.getState())
  const identity = sidebarSessionSourceIdentity(session)
  if (!identity) {
    return { sessionId: null, attached: false, ledgerLinked: false }
  }
  const hub = await attachHubSession(session, taskId, identity.sessionRef, input).catch(
    (error: unknown): Omit<AttachOutcome, 'ledgerLinked'> => ({
      sessionId: null,
      attached: false,
      errorCode: 'connection_failed',
      errorMessage: error instanceof Error ? error.message : 'The session link request failed.'
    })
  )
  if (selectConsoleAccountScope(useAppStore.getState()) !== accountScope) {
    return { sessionId: null, attached: false, ledgerLinked: false }
  }
  const ledgerLinked = await linkLedgerCard(
    identity.sourceKey,
    taskId,
    (input.title ?? '').trim() || null
  )
  if (ledgerLinked && !hub.attached) {
    let remembered = false
    const confirmed = await readSessionTaskContextForSource(
      session,
      taskId,
      undefined,
      () => selectConsoleAccountScope(useAppStore.getState()) === accountScope,
      (result) => {
        remembered = rememberAttachedTaskContext(session, result, accountScope)
      }
    )
    if (confirmed && remembered) {
      return { sessionId: confirmed.sessionId!, attached: true, ledgerLinked: true }
    }
  }
  return { ...hub, ledgerLinked }
}

type AttachInput = Pick<CreateTaskInput, 'cwd' | 'provider' | 'model'> & {
  /** The task's name, recorded on the ledger row beside its id. */
  title?: string | null
}

type AttachOutcome = {
  sessionId: string | null
  attached: boolean
  /** The pane's session-ledger row now names this task, even when the hub holds no session. */
  ledgerLinked: boolean
  contextWarning?: string
  /** The refusal code (e.g. `mutation_not_allowlisted`), so a caller can show an honest reason. */
  errorCode?: string
  errorMessage?: string
}

/** The hub half: a session row the hub knows, joined to the card. Skipped when it has none. */
async function attachHubSession(
  session: Pick<SidebarSession, 'label' | 'agent'> & TaskContextSession,
  taskId: string,
  sessionRef: string,
  input: AttachInput
): Promise<Omit<AttachOutcome, 'ledgerLinked'>> {
  const accountScope = selectConsoleAccountScope(useAppStore.getState())
  const api = window.api?.consoleWorkflows
  if (!api?.ingestSession || !api.attachSession) {
    return { sessionId: null, attached: false }
  }
  const ingested = await api.ingestSession({
    sessionRef,
    cwd: (input.cwd ?? '').trim() || '~',
    provider: (input.provider ?? session.agent ?? 'claude').trim() || 'claude',
    title: session.label,
    ...(input.model ? { model: input.model } : {})
  })
  if (!ingested.ok) {
    return {
      sessionId: null,
      attached: false,
      errorCode: ingested.error.code,
      errorMessage: ingested.error.message
    }
  }
  if (selectConsoleAccountScope(useAppStore.getState()) !== accountScope) {
    return { sessionId: null, attached: false }
  }
  const attached = await api.attachSession({ sessionId: ingested.data.sessionId, taskId })
  if (selectConsoleAccountScope(useAppStore.getState()) !== accountScope) {
    return { sessionId: ingested.data.sessionId, attached: false }
  }
  if (!attached.ok) {
    return {
      sessionId: ingested.data.sessionId,
      attached: false,
      errorCode: attached.error.code,
      errorMessage: attached.error.message
    }
  }
  let contextWarning =
    attached.data.contextWarning ??
    'The task is linked, but shared context could not be prepared for this conversation.'
  if (
    attached.data.sessionId === ingested.data.sessionId &&
    attached.data.taskId === taskId &&
    rememberAttachedTaskContext(session, attached.data, accountScope)
  ) {
    contextWarning = ''
  }
  return {
    sessionId: ingested.data.sessionId,
    attached: true,
    ...(contextWarning ? { contextWarning } : {})
  }
}
