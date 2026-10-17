/**
 * Organization records for changes main relays from the CLI or a launch (`sessionFolders.mutate`):
 * main prepared the record and settles it from what this window answers. A main that sends no
 * `change` predates records, so the window records the change itself, best effort, as `cli`.
 */

import type {
  SessionFolderMutationResult,
  SessionFolderOp
} from '../../../shared/session-folder-cli'
import { resolveSessionFolderRef } from '../../../shared/session-folder-ref'
import type { SessionWorkflowAnchorRef } from '../../../shared/session-workflow-anchor'
import {
  SESSION_ORGANIZATION_RPC,
  type OrganizationChange,
  type OrganizationProbeAnswer,
  type OrganizationRecord,
  type OrganizationRelayedChange,
  type OrganizationRelayedOutcome,
  type OrganizationTarget
} from '../../../shared/session-organization-change'
import {
  organizationKindForFolderOp,
  requestedValueForFolderOp
} from '../../../shared/session-organization-folder-ops'
import { noteOrganizationApplied } from './session-organization-applied'
import {
  checkOrganizationRevision,
  type OrganizationChangeDeps,
  type OrganizationRpc
} from './session-organization-change'
import {
  applyOrganizationValues,
  readOrganizationValue,
  readOrganizationValues,
  type OrganizationStores
} from './session-organization-values'
import { SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import { resolveOrganizationTagRef } from './session-organization-view-values'

export type RelayedSession = { key: string; tabId?: string | null }

export type RelayedOrganizationChange = {
  /** Adds the record's resolved targets and values to the window's answer (or records it). */
  finish: (result: SessionFolderMutationResult) => SessionFolderMutationResult
}

type SessionOp = Extract<
  SessionFolderOp,
  { kind: 'moveSession' | 'archiveSession' | 'deleteSession' }
>

function isSessionOp(op: SessionFolderOp): op is SessionOp {
  return op.kind === 'moveSession' || op.kind === 'archiveSession' || op.kind === 'deleteSession'
}

function targetsBefore(
  op: SessionFolderOp,
  session: RelayedSession | null,
  stores: OrganizationStores
): OrganizationTarget[] {
  if (isSessionOp(op)) {
    const tabId = op.tabId ?? session?.tabId
    return session
      ? [
          {
            sessionKey: session.key,
            ...(op.paneKey ? { paneKey: op.paneKey } : {}),
            ...(tabId ? { tabId } : {})
          }
        ]
      : []
  }
  if (!('folder' in op)) {
    return []
  }
  const resolved = resolveSessionFolderRef(stores.folders.getState().metadata.folders, op.folder)
  return resolved.ok
    ? [
        {
          folderId:
            resolved.target.kind === 'folder' ? resolved.target.folder.id : SAVED_SESSIONS_FOLDER_ID
        }
      ]
    : []
}

/**
 * Call before applying a relayed op: refuses (throws) when the revision check does, and reads
 * the targets' values so `finish` can report before and after.
 */
export function beginRelayedOrganizationChange(input: {
  op: SessionFolderOp
  change: OrganizationRelayedChange | undefined
  session: RelayedSession | null
  stores: OrganizationStores
  deps?: Pick<OrganizationChangeDeps, 'checkRevision' | 'rpc' | 'mintOpId' | 'onApplied'>
}): RelayedOrganizationChange {
  const { op, change, session, stores, deps = {} } = input
  const kind = organizationKindForFolderOp(op)
  const targets = targetsBefore(op, session, stores)
  if (change) {
    const refusal = checkOrganizationRevision(
      { ...change, kind, targets, value: requestedValueForFolderOp(op) },
      deps.checkRevision
    )
    if (refusal) {
      throw new Error(refusal)
    }
  }
  const before = readOrganizationValues(kind, targets, stores)
  return {
    finish: (result) => {
      const resolved =
        op.kind === 'createFolder' && result.folder ? [{ folderId: result.folder.id }] : targets
      const after = readOrganizationValues(kind, resolved, stores)
      const value =
        after && after.length > 0 && kind !== 'folder.create'
          ? after[0]
          : requestedValueForFolderOp(op)
      const outcome = {
        targets: resolved,
        value,
        ...(before && resolved === targets ? { before } : {}),
        ...(after ? { after } : {})
      }
      if (change) {
        // Why now: main records it applied from this answer, with the same targets and values.
        noteOrganizationApplied(
          { ...change, kind, targets: outcome.targets, value: outcome.value },
          outcome,
          deps.onApplied
        )
        return { ...result, organization: { opId: change.opId, ...outcome } }
      }
      recordForOlderMain(
        {
          opId: (deps.mintOpId ?? (() => crypto.randomUUID()))(),
          kind,
          executor: { kind: 'cli' },
          ...outcome
        },
        deps.rpc
      )
      return result
    }
  }
}

/** Best effort: an older main has no record methods, and that must never fail the change. */
function recordForOlderMain(
  change: OrganizationChange & { before?: unknown[]; after?: unknown[] },
  rpc: OrganizationRpc | undefined
): void {
  if (!rpc) {
    return
  }
  const { before, after, ...body } = change
  void rpc(SESSION_ORGANIZATION_RPC.prepare, { change: body, ...(before ? { before } : {}) })
    .then(() =>
      rpc(SESSION_ORGANIZATION_RPC.settle, {
        phase: 'applied',
        change: body,
        ...(before ? { before } : {}),
        ...(after ? { after } : {})
      })
    )
    .catch(() => {})
}

/** The folder a move's value names now: an id, a path, the Saved root, or null (unfiled). */
function intendedPlacement(
  value: unknown,
  stores: OrganizationStores
): { ok: boolean; id: string | null } {
  if (value === null) {
    return { ok: true, id: null }
  }
  if (typeof value !== 'string') {
    return { ok: false, id: null }
  }
  const resolved = resolveSessionFolderRef(stores.folders.getState().metadata.folders, value)
  if (!resolved.ok) {
    return { ok: false, id: null }
  }
  return {
    ok: true,
    id: resolved.target.kind === 'folder' ? resolved.target.folder.id : SAVED_SESSIONS_FOLDER_ID
  }
}

type FindRelayedSession = (target: {
  paneKey?: string
  tabId?: string
  workflow?: SessionWorkflowAnchorRef
}) => RelayedSession | null

/**
 * A change main prepared for many targets (a bulk command): targets named by pane or tab are
 * found in the sidebar and a move's folder reference is resolved, then it applies through the
 * same store actions as the sidebar, as one change. Throws, with nothing changed, when a target
 * or folder is missing or the revision check refuses.
 */
export function applyRelayedOrganizationChange(
  change: OrganizationChange,
  stores: OrganizationStores,
  findSession: FindRelayedSession,
  deps: Pick<OrganizationChangeDeps, 'checkRevision' | 'onApplied'> = {}
): OrganizationRelayedOutcome {
  const targets = change.targets.map((target) => {
    if (target.sessionKey || target.folderId) {
      return target
    }
    const found = findSession({
      ...(target.paneKey ? { paneKey: target.paneKey } : {}),
      ...(target.tabId ? { tabId: target.tabId } : {}),
      ...(target.workflow ? { workflow: target.workflow } : {})
    })
    if (!found) {
      throw new Error(
        `No conversation in the sidebar matches ${target.paneKey ? `pane ${target.paneKey}` : `tab ${target.tabId}`}. Nothing changed.`
      )
    }
    return { ...target, sessionKey: found.key }
  })
  const resolveValue = (value: unknown): unknown => {
    if (change.kind === 'tag' || change.kind === 'untag') {
      return resolveOrganizationTagRef(value, stores)
    }
    if (change.kind !== 'move' || value === undefined) {
      return value
    }
    const placement = intendedPlacement(value, stores)
    if (!placement.ok) {
      throw new Error(`No folder matches ${JSON.stringify(value)}. Nothing changed.`)
    }
    return placement.id
  }
  const resolved: OrganizationChange = {
    ...change,
    targets,
    value: resolveValue(change.value),
    ...(change.values ? { values: change.values.map(resolveValue) } : {})
  }
  const refusal = checkOrganizationRevision(resolved, deps.checkRevision)
  if (refusal) {
    throw new Error(refusal)
  }
  const applied = applyOrganizationValues(resolved, stores)
  if (!('before' in applied) || (!applied.changed && applied.error)) {
    throw new Error(applied.error ?? 'Nothing changed.')
  }
  noteOrganizationApplied(resolved, applied, deps.onApplied)
  return {
    opId: change.opId,
    targets,
    value: resolved.value,
    ...(resolved.values ? { values: resolved.values } : {}),
    before: applied.before,
    after: applied.after
  }
}

const PROBED_KINDS = new Set(['move', 'archive', 'unarchive', 'delete', 'title'])

/**
 * Startup reconciliation: whether each interrupted change's targets hold its value now. Only
 * session placement, archive, delete and title can be told; anything else answers "can't tell".
 */
export function answerOrganizationProbe(
  records: readonly OrganizationRecord[],
  stores: OrganizationStores,
  findSession: FindRelayedSession
): OrganizationProbeAnswer[] {
  return records.map((record) => {
    if (!PROBED_KINDS.has(record.kind) || record.targets.length === 0) {
      return { opId: record.opId, holds: null }
    }
    const targets = record.targets.map((target) => {
      if (target.sessionKey) {
        return target
      }
      const found = findSession({
        ...(target.paneKey ? { paneKey: target.paneKey } : {}),
        ...(target.tabId ? { tabId: target.tabId } : {}),
        ...(target.workflow ? { workflow: target.workflow } : {})
      })
      return found ? { ...target, sessionKey: found.key } : target
    })
    const intended =
      record.kind === 'move' ? intendedPlacement(record.value, stores) : { ok: true, id: null }
    if (!intended.ok || targets.some((target) => !target.sessionKey)) {
      return { opId: record.opId, holds: null }
    }
    const value = record.kind === 'move' ? intended.id : record.value
    const now = targets.map((target) => readOrganizationValue(record.kind, target, stores))
    const holds = now.every(
      (read) => read.known && JSON.stringify(read.value) === JSON.stringify(value)
    )
    return {
      opId: record.opId,
      holds,
      ...(holds
        ? { targets, value, after: now.map((read) => (read as { value: unknown }).value) }
        : {})
    }
  })
}
