/**
 * The one way the window changes session organization (design: docs/reference/
 * session-organization-change-path.md). A person's change applies first and is recorded after,
 * best effort; any other executor's change is recorded as prepared first and refused when that
 * fails. Many targets are one change and one record.
 */

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { useSessionTags } from '@/store/session-tags'
import { useWaitLater } from '@/store/wait-later-store'
import {
  isPersonExecutor,
  SESSION_ORGANIZATION_RPC,
  type OrganizationChange,
  type OrganizationExecutor,
  type OrganizationUndoPlan,
  type OrganizationUndoTarget
} from '../../../shared/session-organization-change'
import { selectOrganizationUndo } from '../../../shared/session-organization-undo-plan'
import { noteOrganizationApplied } from './session-organization-applied'
import {
  checkOrganizationRevision,
  type OrganizationChangeDeps,
  type OrganizationChangeOutcome,
  type OrganizationChangeRequest,
  type OrganizationRpc
} from './session-organization-change-contract'
import {
  applyOrganizationValues,
  readOrganizationValue,
  readOrganizationValues,
  type OrganizationStores
} from './session-organization-values'

export {
  checkOrganizationRevision,
  setOrganizationRevisionCheck
} from './session-organization-change-contract'
export type {
  OrganizationChangeDeps,
  OrganizationChangeOutcome,
  OrganizationChangeRequest,
  OrganizationRevisionCheck,
  OrganizationRpc
} from './session-organization-change-contract'

type Recorded = { revision?: string; error?: string }

const localRpc: OrganizationRpc = (method, params) =>
  callRuntimeRpc({ kind: 'local' }, method, params)

/** The window's own sidebar stores, which a change reads and writes unless deps name others. */
export function windowOrganizationStores(): OrganizationStores {
  return {
    folders: useSessionFolders,
    view: useSessionSidebarView,
    tags: useSessionTags,
    waitLater: useWaitLater
  }
}

function storesOf(deps: OrganizationChangeDeps): OrganizationStores {
  return deps.stores ?? windowOrganizationStores()
}

function withOpId(
  request: OrganizationChangeRequest,
  deps: OrganizationChangeDeps
): OrganizationChange {
  return { ...request, opId: request.opId ?? (deps.mintOpId ?? (() => crypto.randomUUID()))() }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function notifyRecordFailure(deps: OrganizationChangeDeps, message: string): void {
  if (deps.onRecordFailure) {
    deps.onRecordFailure(message)
    return
  }
  toast.error(
    translate(
      'conversations.organization.recordFailed',
      'The change was made, but it could not be added to the session history.'
    ),
    { description: message }
  )
}

async function settle(
  deps: OrganizationChangeDeps,
  params: {
    phase: 'applied' | 'failed'
    change: OrganizationChange
    before?: unknown[]
    after?: unknown[]
    error?: string
  }
): Promise<Recorded> {
  const answer = await (deps.rpc ?? localRpc)<{ revision?: string; auditError?: string }>(
    SESSION_ORGANIZATION_RPC.settle,
    params
  )
  return {
    ...(answer?.revision ? { revision: answer.revision } : {}),
    ...(answer?.auditError ? { error: answer.auditError } : {})
  }
}

/**
 * A person's change, applied before this returns (a drop waits on no IPC); `recorded` settles
 * once main has the record. A record failure never undoes the change: it shows a toast.
 */
export function applyPersonOrganizationChange(
  request: OrganizationChangeRequest,
  deps: OrganizationChangeDeps = {}
): { outcome: OrganizationChangeOutcome; recorded: Promise<Recorded> } {
  const change = withOpId(request, deps)
  if (!isPersonExecutor(change.executor)) {
    throw new Error('applyPersonOrganizationChange takes a person executor.')
  }
  const refusal = checkOrganizationRevision(change, deps.checkRevision)
  if (refusal) {
    return {
      outcome: { status: 'refused', opId: change.opId, error: refusal },
      recorded: Promise.resolve({})
    }
  }
  const applied = applyOrganizationValues(change, storesOf(deps), deps.act)
  if (!('before' in applied) || (!applied.changed && applied.error)) {
    return {
      outcome: { status: 'failed', opId: change.opId, error: applied.error ?? 'Nothing changed.' },
      recorded: Promise.resolve({})
    }
  }
  const outcome: OrganizationChangeOutcome = {
    status: 'applied',
    opId: change.opId,
    before: applied.before,
    after: applied.after,
    ...(applied.error ? { error: applied.error } : {})
  }
  const recorded = recordApplied(change, applied, deps)
  return { outcome, recorded }
}

/** Every person change, applied by a value applier or already made by a store action. */
function recordApplied(
  change: OrganizationChange,
  values: { before?: unknown[]; after?: unknown[] },
  deps: OrganizationChangeDeps
): Promise<Recorded> {
  // Why before recording: the person's revocation must hold before anything else can ask.
  noteOrganizationApplied(change, values, deps.onApplied)
  return settle(deps, {
    phase: 'applied',
    change,
    ...(values.before ? { before: values.before } : {}),
    ...(values.after ? { after: values.after } : {})
  })
    .then((result) => {
      if (result.error) {
        notifyRecordFailure(deps, result.error)
      }
      return result
    })
    .catch((error: unknown) => {
      notifyRecordFailure(deps, messageOf(error))
      return { error: messageOf(error) }
    })
}

/**
 * Records a person's change a store action already made, for kinds no value applier can make
 * (a folder created or deleted, a folder-tree Undo). Best effort, like every person record.
 */
export function recordPersonOrganizationChange(
  request: OrganizationChangeRequest,
  values: { before?: unknown[]; after?: unknown[] },
  deps: OrganizationChangeDeps = {}
): { opId: string; recorded: Promise<Recorded> } {
  const change = withOpId(request, deps)
  if (!isPersonExecutor(change.executor)) {
    throw new Error('recordPersonOrganizationChange takes a person executor.')
  }
  return { opId: change.opId, recorded: recordApplied(change, values, deps) }
}

/** Every organization change goes through here: person or not, one target or many. */
export async function applyOrganizationChange(
  request: OrganizationChangeRequest,
  deps: OrganizationChangeDeps = {}
): Promise<OrganizationChangeOutcome> {
  if (isPersonExecutor(request.executor)) {
    const { outcome, recorded } = applyPersonOrganizationChange(request, deps)
    const record = await recorded
    return outcome.status === 'applied'
      ? {
          ...outcome,
          ...(record.revision ? { revision: record.revision } : {}),
          ...(record.error ? { recordError: record.error } : {})
        }
      : outcome
  }
  const change = withOpId(request, deps)
  const stores = storesOf(deps)
  const refusal = checkOrganizationRevision(change, deps.checkRevision)
  if (refusal) {
    return { status: 'refused', opId: change.opId, error: refusal }
  }
  const before = readOrganizationValues(change.kind, change.targets, stores, change)
  try {
    await (deps.rpc ?? localRpc)(SESSION_ORGANIZATION_RPC.prepare, {
      change,
      ...(before ? { before } : {})
    })
  } catch (error) {
    // Why refuse: a change nobody recorded could later be claimed by no one or anyone.
    return { status: 'refused', opId: change.opId, error: messageOf(error) }
  }
  const applied = applyOrganizationValues(change, stores, deps.act)
  if (!('before' in applied) || (!applied.changed && applied.error)) {
    const error = applied.error ?? 'Nothing changed.'
    await settle(deps, { phase: 'failed', change, error }).catch(() => ({}))
    return { status: 'failed', opId: change.opId, error }
  }
  const record = await settle(deps, {
    phase: 'applied',
    change,
    before: applied.before,
    after: applied.after
  }).catch((error: unknown) => ({ error: messageOf(error) }) as Recorded)
  noteOrganizationApplied(
    change,
    {
      before: applied.before,
      after: applied.after,
      ...(record.revision ? { revision: record.revision } : { unconfirmed: true })
    },
    deps.onApplied
  )
  return {
    status: 'applied',
    opId: change.opId,
    before: applied.before,
    after: applied.after,
    ...(record.revision ? { revision: record.revision } : {}),
    ...(record.error ? { recordError: record.error } : {}),
    ...(applied.error ? { error: applied.error } : {})
  }
}

export type OrganizationUndoOutcome = {
  /** Targets put back. */
  undone: number
  total: number
  /** Changed since, or not undoable: never overwritten. */
  skipped: OrganizationUndoTarget[]
  outcome?: OrganizationChangeOutcome
  error?: string
}

/**
 * Undo from main's record (so it works after a restart): targets changed since are skipped and
 * reported ("undid 3 of 5"). A target changed here by a path that records nothing yet is caught
 * by re-reading it against the value the change left.
 */
export async function undoOrganizationChange(
  opId: string,
  deps: OrganizationChangeDeps & {
    via?: Extract<OrganizationExecutor, { kind: 'person' }>['via']
  } = {}
): Promise<OrganizationUndoOutcome> {
  let plan: OrganizationUndoPlan
  try {
    plan = await (deps.rpc ?? localRpc)<OrganizationUndoPlan>(SESSION_ORGANIZATION_RPC.undoPlan, {
      opId
    })
  } catch (error) {
    return { undone: 0, total: 0, skipped: [], error: messageOf(error) }
  }
  const stores = storesOf(deps)
  // Why shared: the host undoes a headless change exactly the same way (session-organization-host).
  const selection = selectOrganizationUndo(
    plan,
    (kind, target, value) => readOrganizationValue(kind, target, stores, value),
    'It changed in this window since.'
  )
  const { skipped, total } = selection
  if (!selection.change) {
    return { undone: 0, total, skipped }
  }
  const outcome = await applyOrganizationChange(
    { ...selection.change, executor: { kind: 'person', via: deps.via ?? 'notice' } },
    deps
  )
  return { undone: outcome.status === 'applied' ? selection.kept : 0, total, skipped, outcome }
}
