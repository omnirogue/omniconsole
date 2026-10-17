/**
 * Organization changes the app makes (transfers, finishes, automatic archive) and launch filing,
 * through the change path: prepared first and refused when that record cannot be written. Each
 * runs the specific store action it replaces, so receipts, proofs and archive origins still hold.
 */

import type {
  ORGANIZATION_WIRE_APP_FEATURES,
  OrganizationExecutor,
  OrganizationTarget
} from '../../../shared/session-organization-change'
import { launchFilingReason } from '../../../shared/session-organization-change'
import {
  applyOrganizationChange,
  applyPersonOrganizationChange,
  type OrganizationChangeDeps,
  type OrganizationChangeRequest
} from './session-organization-change'
import type { OrganizationStoreAction, OrganizationStores } from './session-organization-values'
import { isSessionSaved, type SessionFinishAction } from './session-folders'

// Why the wire list: the window may never record a change as the steward's.
type AppFeature = (typeof ORGANIZATION_WIRE_APP_FEATURES)[number]

export const appExecutor = (feature: AppFeature): OrganizationExecutor => ({ kind: 'app', feature })

/** One store action as a recorded change: the request plus the action that makes it. */
export type StoreActionChange = { request: OrganizationChangeRequest; act: OrganizationStoreAction }

function refusal(stores: OrganizationStores, done: boolean, fallback: string): string | null {
  return done ? null : (stores.folders.getState().error ?? fallback)
}

/** A non-person change: true once applied with no store refusal. */
export async function applyRecordedChange(
  change: StoreActionChange,
  deps: OrganizationChangeDeps = {}
): Promise<{ ok: boolean; error?: string }> {
  const outcome = await applyOrganizationChange(change.request, { ...deps, act: change.act })
  if (outcome.status === 'applied' && !outcome.error) {
    return { ok: true }
  }
  return { ok: false, error: outcome.error }
}

/** A person's change through a specific store action: applied now, recorded after. */
export function applyPersonStoreChange(
  change: StoreActionChange,
  deps: OrganizationChangeDeps = {}
): boolean {
  const { outcome } = applyPersonOrganizationChange(change.request, { ...deps, act: change.act })
  return outcome.status === 'applied' && !outcome.error
}

/** A conversation started from a folder's "+" filed there once its row has an identity. */
export function launchFilingChange(
  sessionKey: string,
  folderId: string,
  tabId?: string
): StoreActionChange {
  return {
    request: {
      kind: 'move',
      targets: [{ sessionKey, ...(tabId ? { tabId } : {}) }],
      value: folderId,
      executor: { kind: 'launch', source: 'session-launch' },
      reason: launchFilingReason()
    },
    act: (_change, stores) =>
      refusal(
        stores,
        stores.folders.getState().moveSessions([sessionKey], folderId),
        'Could not file the conversation.'
      )
  }
}

/** A handoff's target filed together with its durable receipt. */
export function transferFilingChange(
  sessionKey: string,
  folderId: string | null,
  operationId: string,
  expiresAt = Number.POSITIVE_INFINITY
): StoreActionChange {
  return {
    request: {
      kind: 'move',
      targets: [{ sessionKey }],
      value: folderId,
      executor: appExecutor('transfer'),
      evidence: `transfer ${operationId}`
    },
    // Why the expiry here: preparing the record took time main may no longer wait.
    act: (_change, stores) =>
      Date.now() < expiresAt &&
      stores.folders.getState().moveSessionDurably(sessionKey, folderId, operationId)
        ? null
        : 'The target placement could not be saved durably.'
  }
}

/** A handoff's sources archived together with the committed transfer receipt. */
export function transferArchiveChange(
  targets: OrganizationTarget[],
  operationId: string,
  commit: () => boolean,
  reason?: string
): StoreActionChange {
  const keys = targets.map((target) => target.sessionKey!).filter(Boolean)
  return {
    request: {
      kind: 'archive',
      targets,
      value: true,
      executor: appExecutor('transfer'),
      evidence: `transfer ${operationId}`,
      ...(reason?.trim() ? { reason: reason.trim().slice(0, 1000) } : {})
    },
    act: (_change, stores) => {
      stores.view.getState().archiveTransfer(keys, operationId, commit)
      return null
    }
  }
}

/** A completed session archived with its proof receipt. */
export function autoArchiveChange(sessionKey: string, proof: string): StoreActionChange {
  return {
    request: {
      kind: 'archive',
      targets: [{ sessionKey }],
      value: true,
      executor: appExecutor('auto-archive')
    },
    act: (_change, stores) =>
      stores.view.getState().archiveVerified(sessionKey, proof)
        ? null
        : 'The completed session could not be archived with its receipt.'
  }
}

/** An automatically archived session that resumed work comes back. */
export function resumeUnarchiveChange(sessionKey: string): StoreActionChange {
  return {
    request: {
      kind: 'unarchive',
      targets: [{ sessionKey }],
      value: false,
      executor: appExecutor('auto-archive')
    },
    act: (_change, stores) => {
      stores.view.getState().setArchived([sessionKey], false, 'resume')
      return null
    }
  }
}

/** A finished session saved into a Saved folder (`saved-sessions` for the root). */
export function finishSaveChange(
  sessionKey: string,
  folderId: string,
  executor: OrganizationExecutor
): StoreActionChange {
  return {
    request: { kind: 'save', targets: [{ sessionKey }], value: folderId, executor },
    act: (_change, stores) =>
      refusal(
        stores,
        stores.folders.getState().saveSession(sessionKey, folderId),
        'Could not save this session.'
      )
  }
}

/**
 * "Keep it for me" on a finished session: a saved one leaves Saved (a recorded move); one that
 * is not saved only notes the finish choice, which is no organization change.
 */
export function finishKeepChange(
  sessionKey: string,
  choice: SessionFinishAction,
  executor: OrganizationExecutor,
  stores: OrganizationStores
): StoreActionChange | null {
  if (!isSessionSaved(stores.folders.getState().metadata, sessionKey)) {
    return null
  }
  return {
    request: { kind: 'move', targets: [{ sessionKey }], value: null, executor },
    act: (_change, current) =>
      refusal(
        current,
        current.folders.getState().finishForMe(sessionKey, choice),
        'Could not save the finish choice.'
      )
  }
}

/** Notes "kept for me" on a session that is not saved: no placement changes. */
export function noteKeptForMe(
  sessionKey: string,
  choice: SessionFinishAction,
  stores: OrganizationStores
): boolean {
  return stores.folders.getState().finishForMe(sessionKey, choice)
}
