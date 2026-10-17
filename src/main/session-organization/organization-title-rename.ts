/**
 * `omni session rename`: a title change recorded like every agent or CLI change. Main prepares
 * it (who, why, and whose words the title is), relays the rename with the change, and records
 * applied or failed from the window's answer.
 */

import { randomUUID } from 'node:crypto'
import { SESSION_FOLDERS_NO_WINDOW_ERROR } from '../../shared/session-folder-cli'
import type { SessionManageSidebarRow } from '../../shared/session-manage-relay'
import {
  ORGANIZATION_NO_WINDOW,
  type OrganizationChange,
  type OrganizationExecutor,
  type OrganizationRelayedChange,
  type OrganizationRelayedOutcome,
  type OrganizationTitleOrigin
} from '../../shared/session-organization-change'
import type { OrganizationChangeLedger } from './organization-change-ledger'
import type { OrganizationAudit } from './organization-trail'

const REQUEST_MAX_CHARS = 4000

export type RecordedTitleRename = {
  row: Pick<SessionManageSidebarRow, 'viewKey' | 'paneKey' | 'tabId' | 'title'>
  title: string
  executor: OrganizationExecutor
  origin?: OrganizationTitleOrigin
  reason?: string
  request?: string
  /** Refuse when the title changed since this revision. */
  expectedRevision?: string
  actor?: OrganizationAudit['actor']
}

type Applied = {
  summary: string
  before?: string
  after?: string
  organization?: OrganizationRelayedOutcome
}

/** The change a rename records: one target, the row's sidebar key, its pane and tab. */
export function titleRenameChange(input: RecordedTitleRename, opId: string): OrganizationChange {
  const request = input.request?.trim().slice(0, REQUEST_MAX_CHARS)
  return {
    opId,
    kind: 'title',
    targets: [
      {
        sessionKey: input.row.viewKey,
        ...(input.row.paneKey ? { paneKey: input.row.paneKey } : {}),
        ...(input.row.tabId ? { tabId: input.row.tabId } : {})
      }
    ],
    value: input.title.trim(),
    executor: input.executor,
    origin: input.origin ?? 'unknown',
    ...(input.reason ? { reason: input.reason } : {}),
    ...(request ? { request } : {}),
    ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {})
  }
}

export async function recordTitleRename<T extends Applied>(
  ledger: Pick<OrganizationChangeLedger, 'prepare' | 'settle'>,
  input: RecordedTitleRename,
  apply: (change: OrganizationRelayedChange) => Promise<T>
): Promise<T & { opId: string; auditError?: string }> {
  const change = titleRenameChange(input, randomUUID())
  const target = {
    paneKey: input.row.paneKey,
    tabId: input.row.tabId,
    title: input.row.title
  }
  const actor = input.actor ? { actor: input.actor } : {}
  await ledger.prepare(change, { audit: { ...actor, target } })
  const relayed: OrganizationRelayedChange = {
    opId: change.opId,
    executor: change.executor,
    ...(change.origin ? { origin: change.origin } : {}),
    ...(change.reason ? { reason: change.reason } : {}),
    ...(change.request ? { request: change.request } : {}),
    ...(change.expectedRevision ? { expectedRevision: change.expectedRevision } : {})
  }
  let result: T
  try {
    result = await apply(relayed)
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
  // Why: without the window's outcome an older window renamed it without the revision check.
  const outcome = result.organization?.opId === change.opId ? result.organization : undefined
  const settled = await ledger.settle({
    phase: 'applied',
    change: outcome ? { ...change, targets: outcome.targets, value: outcome.value } : change,
    ...(outcome?.before ? { before: outcome.before } : {}),
    ...(outcome?.after ? { after: outcome.after } : {}),
    ...(outcome ? {} : { revisionUnchecked: true as const }),
    audit: {
      summary: result.summary,
      target,
      ...(result.before !== undefined ? { before: result.before } : {}),
      ...(result.after !== undefined ? { after: result.after } : {})
    }
  })
  return {
    ...result,
    opId: change.opId,
    ...(settled.auditError ? { auditError: settled.auditError } : {})
  }
}
