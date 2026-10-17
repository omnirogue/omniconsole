/**
 * CLI and launch organization changes: main mints the opId, records `prepared`, relays the op to
 * the window with the optional `change` field, and records `applied` or `failed` from its answer.
 */

import { randomUUID } from 'node:crypto'
import {
  SESSION_FOLDERS_NO_WINDOW_ERROR,
  type SessionFolderMutationResult,
  type SessionFolderOp,
  type SessionFolderRelayRequest
} from '../../shared/session-folder-cli'
import type { SessionManageActor } from '../../shared/session-manage-types'
import {
  ORGANIZATION_NO_WINDOW,
  type OrganizationChange,
  type OrganizationExecutor,
  type OrganizationRelayedChange,
  type OrganizationRelayedOutcome,
  type OrganizationTarget,
  type OrganizationTitleOrigin
} from '../../shared/session-organization-change'
import {
  organizationKindForFolderOp,
  requestedTargetsForFolderOp,
  requestedValueForFolderOp
} from '../../shared/session-organization-folder-ops'
import type { SessionActionRecord } from '../session-manage/session-actions-log'
import {
  actorOfExecutor,
  admitUnattendedOrganization,
  recheckUnattendedOrganization
} from '../session-manage/session-manage-unattended-admission'
import type { OrganizationChangeLedger } from './organization-change-ledger'
import { relayPutBack } from './organization-put-back'
import type { OrganizationAudit } from './organization-trail'

export type OrganizationRelay = (request: SessionFolderRelayRequest) => Promise<unknown>

export const ORGANIZATION_MOVE_NEEDS_REASON =
  'Moving a session or folder needs --reason "<why>": the reason is recorded with the move so the person can see why it happened. Nothing changed.'

export const ORGANIZATION_CHANGE_NEEDS_REASON =
  'Tagging, hiding, unhiding or snoozing a session needs --reason "<why>": the reason is recorded with the change so the person can see why it happened. Nothing changed.'

const REQUEST_MAX_CHARS = 4000

const MOVE_KINDS: ReadonlySet<OrganizationChange['kind']> = new Set(['move', 'folder.move'])
const REASONED_KINDS: ReadonlySet<OrganizationChange['kind']> = new Set([
  'tag',
  'untag',
  'hide',
  'unhide',
  'snooze'
])

export type RelayedOrganizationMutation = {
  op: SessionFolderOp
  executor: OrganizationExecutor
  opId?: string
  reason?: string
  request?: string
  origin?: OrganizationTitleOrigin
  expectedRevision?: string
  /** What made it safe to do unattended (a steward run's Tier 2 reading). */
  evidence?: string
  /** The audit actor as `auditActor` names it; a launch claim keeps who made it here. */
  actor?: OrganizationAudit['actor']
  /** Read synchronously after the prepared record, right before the relay; a reason fails it. */
  beforeRelay?: () => string | null
}

export type RelayedOrganizationResult = SessionFolderMutationResult & {
  opId: string
  auditError?: string
}

export function executorForActor(actor: SessionManageActor): OrganizationExecutor {
  switch (actor.kind) {
    case 'pane':
      return { kind: 'pane', paneKey: actor.paneKey, title: actor.title }
    case 'steward':
      return { kind: 'app', feature: 'steward' }
    case 'cli':
      return { kind: 'cli' }
    case 'remote':
      // Why these: another computer's person is the person; its agents and CLI hold no local pane.
      return actor.unattended
        ? { kind: 'app', feature: 'steward' }
        : actor.requester === 'person'
          ? { kind: 'person', via: 'sidebar' }
          : { kind: 'cli' }
  }
}

/**
 * An agent or CLI move, tag, hide or snooze must say why, once per change however many targets
 * it has; launch filing carries its own reason; a dry run is exempt.
 */
export function organizationChangeReasonRefusal(
  change: Pick<OrganizationChange, 'kind' | 'executor' | 'reason'>,
  dryRun: boolean
): string | null {
  const agent = change.executor.kind === 'pane' || change.executor.kind === 'cli'
  if (!agent || dryRun || change.reason?.trim()) {
    return null
  }
  return MOVE_KINDS.has(change.kind)
    ? ORGANIZATION_MOVE_NEEDS_REASON
    : REASONED_KINDS.has(change.kind)
      ? ORGANIZATION_CHANGE_NEEDS_REASON
      : null
}

/** The same rule for one `omni session move` / `omni folder move` op. */
export function organizationReasonRefusal(
  op: SessionFolderOp,
  executor: OrganizationExecutor,
  reason: string | undefined,
  dryRun: boolean
): string | null {
  return organizationChangeReasonRefusal(
    { kind: organizationKindForFolderOp(op), executor, ...(reason ? { reason } : {}) },
    dryRun
  )
}

function isSessionOp(op: SessionFolderOp): boolean {
  return op.kind === 'moveSession' || op.kind === 'archiveSession' || op.kind === 'deleteSession'
}

/** The single-target shape the audit log has always used for folder commands. */
function legacyTarget(
  op: SessionFolderOp,
  result?: SessionFolderMutationResult
): SessionActionRecord['target'] {
  if (op.kind === 'moveSession' || op.kind === 'archiveSession' || op.kind === 'deleteSession') {
    return { paneKey: op.paneKey ?? null, tabId: op.tabId ?? null }
  }
  const folder = 'folder' in op ? op.folder : (result?.folder?.path ?? op.name)
  return { folder }
}

/** What an older window's answer still says about the targets. */
function answeredTargets(
  op: SessionFolderOp,
  requested: OrganizationTarget[],
  result: SessionFolderMutationResult
): OrganizationTarget[] {
  if (isSessionOp(op)) {
    return requested.map((target) =>
      result.sessionKey ? { ...target, sessionKey: result.sessionKey } : target
    )
  }
  return result.folder ? [{ folderId: result.folder.id }] : requested
}

export async function relayOrganizationMutation(
  ledger: Pick<OrganizationChangeLedger, 'prepare' | 'settle'>,
  relay: OrganizationRelay,
  input: RelayedOrganizationMutation
): Promise<RelayedOrganizationResult> {
  const { op, executor } = input
  const opId = input.opId ?? randomUUID()
  const request = input.request?.trim().slice(0, REQUEST_MAX_CHARS)
  const relayed: OrganizationRelayedChange = {
    opId,
    executor,
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(request ? { request } : {}),
    ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {})
  }
  const change: OrganizationChange = {
    ...relayed,
    kind: organizationKindForFolderOp(op),
    targets: requestedTargetsForFolderOp(op),
    value: requestedValueForFolderOp(op)
  }
  const actor = input.actor ? { actor: input.actor } : {}
  await ledger.prepare(change, { audit: { ...actor, target: legacyTarget(op) } })
  let result: SessionFolderMutationResult
  try {
    const late = input.beforeRelay?.() ?? null
    if (late) {
      throw new Error(late)
    }
    result = (await relay({ kind: 'mutate', op, change: relayed })) as SessionFolderMutationResult
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await ledger.settle({
      phase: 'failed',
      change,
      error: message === SESSION_FOLDERS_NO_WINDOW_ERROR ? ORGANIZATION_NO_WINDOW : message,
      audit: { summary: message }
    })
    throw error
  }
  const { organization, ...answer } = result
  // Why: without the window's outcome it applied as it always did, with no revision check.
  const outcome = organization?.opId === opId ? organization : undefined
  const settled = await ledger.settle({
    phase: 'applied',
    change: outcome
      ? { ...change, targets: outcome.targets, value: outcome.value }
      : { ...change, targets: answeredTargets(op, change.targets, result) },
    ...(outcome?.before ? { before: outcome.before } : {}),
    ...(outcome?.after ? { after: outcome.after } : {}),
    ...(outcome ? {} : { revisionUnchecked: true as const }),
    audit: {
      summary: result.summary,
      target: legacyTarget(op, result),
      ...(result.before !== undefined ? { before: result.before } : {}),
      ...(result.after !== undefined ? { after: result.after } : {})
    }
  })
  return { ...answer, opId, ...(settled.auditError ? { auditError: settled.auditError } : {}) }
}

export type RelayedOrganizationChangeResult = {
  opId: string
  revision?: string
  outcome: OrganizationRelayedOutcome
  auditError?: string
}

export const ORGANIZATION_WINDOW_TOO_OLD =
  'The OmniConsole window cannot apply a change to many sessions at once yet. Nothing changed.'

/**
 * One change for many targets (a bulk command): one prepared record, one relay carrying the
 * whole change, and one applied record with each target's before and after. The steward (or an
 * automatic cleanup session) may only archive, each target passing Tier 2 first.
 */
export async function relayOrganizationChange(
  ledger: Pick<OrganizationChangeLedger, 'prepare' | 'settle'>,
  relay: OrganizationRelay,
  requested: OrganizationChange,
  audit: Pick<OrganizationAudit, 'actor' | 'summary'> = {}
): Promise<RelayedOrganizationChangeResult> {
  const refusal = organizationChangeReasonRefusal(requested, false)
  if (refusal) {
    throw new Error(refusal)
  }
  const acting = actorOfExecutor(requested.executor, audit.actor)
  const evidence = acting ? await admitUnattendedOrganization(acting, requested) : null
  const change = evidence && !requested.evidence ? { ...requested, evidence } : requested
  await ledger.prepare(change, { audit })
  let outcome: OrganizationRelayedOutcome | undefined
  try {
    outcome = (await relay({ kind: 'applyOrganizationChange', change })) as
      | OrganizationRelayedOutcome
      | undefined
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await ledger.settle({
      phase: 'failed',
      change,
      error: message === SESSION_FOLDERS_NO_WINDOW_ERROR ? ORGANIZATION_NO_WINDOW : message,
      audit: { summary: message }
    })
    throw error
  }
  // Why: an older window answers a request kind it does not know with nothing, changing nothing.
  if (outcome?.opId !== change.opId) {
    await ledger.settle({ phase: 'failed', change, error: ORGANIZATION_WINDOW_TOO_OLD })
    throw new Error(ORGANIZATION_WINDOW_TOO_OLD)
  }
  const settled = await ledger.settle({
    phase: 'applied',
    change: {
      ...change,
      targets: outcome.targets,
      value: outcome.value,
      ...(outcome.values ? { values: outcome.values } : {})
    },
    ...(outcome.before ? { before: outcome.before } : {}),
    ...(outcome.after ? { after: outcome.after } : {})
  })
  // Why after the window applied it: a prompt queued, held or delivered while the change was
  // in flight is invisible to the window, so main asks its own check again and puts the row back.
  const putBack =
    acting && evidence ? await recheckUnattendedOrganization(acting, requested, evidence) : null
  if (putBack) {
    const inverse = await relayPutBack(
      ledger,
      relay,
      change,
      outcome,
      putBack,
      settled.revision,
      ORGANIZATION_WINDOW_TOO_OLD
    )
    // Why two messages: the row is either back or still filed, and the note must say which.
    throw new Error(
      inverse.restored
        ? `Applied and put back: ${putBack}.`
        : `Applied, and could not be put back (${inverse.error}); it stays as applied although ${putBack}.`
    )
  }
  return {
    opId: change.opId,
    outcome,
    ...(settled.revision ? { revision: settled.revision } : {}),
    ...(settled.auditError ? { auditError: settled.auditError } : {})
  }
}

/** A relay whose every change is recorded with one executor and reason (launch filing). */
export function recordedFolderRelay(
  ledger: Pick<OrganizationChangeLedger, 'prepare' | 'settle'>,
  relay: OrganizationRelay,
  recorded: Pick<RelayedOrganizationMutation, 'executor' | 'reason' | 'request'>
): OrganizationRelay {
  return (request) =>
    request.kind === 'mutate' && request.dryRun !== true
      ? relayOrganizationMutation(ledger, relay, { op: request.op, ...recorded })
      : relay(request)
}
