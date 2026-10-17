/**
 * Revision-bound ownership in the window (docs/reference/session-organization-change-path.md):
 * the revision check every non-person change passes, the mirror hearing every applied change,
 * main's copy read back at start, 1a batch filings seeded, and ownership following a pane's key.
 */

import { translate } from '@/i18n/i18n'
import { useSessionBatchOrigins } from '@/store/session-batch-origins'
import { useSessionFolders } from '@/store/session-folders'
import {
  useSessionOrganizationOwnership,
  type OwnershipMirror
} from '@/store/session-organization-ownership'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import {
  isPersonExecutor,
  organizationTargetKey,
  ownershipFieldOf,
  type OrganizationChange,
  type OrganizationKeyState,
  type OrganizationTarget
} from '../../../shared/session-organization-change'
import {
  isEmptyOrganizationKeyState,
  ownedRevisionRefusal,
  sameOwnedValue,
  SESSION_ORGANIZATION_OWNERSHIP_RPC,
  type OwnershipKeyMove,
  type OwnershipSeed
} from '../../../shared/session-organization-ownership'
import type { SessionBatchOrigins } from './session-batch-origins'
import { setOrganizationAppliedListener } from './session-organization-applied'
import { setOrganizationRevisionCheck, type OrganizationRpc } from './session-organization-change'
import {
  createOrganizationOwnershipOutbox,
  localOrganizationRpc
} from './session-organization-ownership-outbox'
import { readOrganizationValue, type OrganizationStores } from './session-organization-values'
import { getSessionFolderId, type SessionFolderMetadata } from './session-folders'

const STORES: OrganizationStores = { folders: useSessionFolders, view: useSessionSidebarView }

const mirror = () => useSessionOrganizationOwnership.getState()

export const organizationOwnershipOutbox = createOrganizationOwnershipOutbox(
  localOrganizationRpc,
  (keys) => mirror().adopt(keys, false)
)

function fieldName(field: 'placement' | 'title'): string {
  return field === 'placement'
    ? translate('sessionOwnership.field.placement', 'folder')
    : translate('sessionOwnership.field.title', 'title')
}

/**
 * The window's revision check for a change that names the revision it expects: a person is never
 * refused; for an owned field (placement, title) the target must still be owned at exactly that
 * revision and still hold what that change left. Main checks the other fields before recording.
 */
export function checkOwnedRevision(
  target: OrganizationTarget,
  expectedRevision: string,
  change: OrganizationChange,
  deps: { stateFor?: (key: string) => OrganizationKeyState; stores?: OrganizationStores } = {}
): string | null {
  const field = ownershipFieldOf(change.kind)
  if (isPersonExecutor(change.executor) || !field) {
    return null
  }
  const key = organizationTargetKey(target)
  if (!key) {
    return translate(
      'sessionOwnership.noTarget',
      'A target of this change has no session to check its revision against. Nothing changed.'
    )
  }
  const state = (deps.stateFor ?? mirror().stateFor)(key)
  const params = { field: fieldName(field), expected: expectedRevision }
  const refusal = ownedRevisionRefusal(state, field, expectedRevision)
  if (refusal?.reason === 'yours') {
    return translate(
      'sessionOwnership.yours',
      "This session's {{field}} is the person's now ({{why}}), so it is not changed without them. Nothing changed.",
      { ...params, why: refusal.why }
    )
  }
  if (refusal?.reason === 'not-owned') {
    return translate(
      'sessionOwnership.notOwned',
      "No agent change still holds this session's {{field}}, so it counts as the person's. Nothing changed.",
      params
    )
  }
  if (refusal) {
    return translate(
      'sessionOwnership.changedSince',
      "This session's {{field}} changed since revision {{expected}} (it is at {{current}}). Nothing changed.",
      { ...params, current: refusal.current }
    )
  }
  const live = readOrganizationValue(change.kind, target, deps.stores ?? STORES)
  if (live.known && !sameOwnedValue(live.value, state.ownership[field]!.value)) {
    return translate(
      'sessionOwnership.drifted',
      "This session's {{field}} was changed by something that recorded no change since revision {{expected}}. Nothing changed.",
      params
    )
  }
  return null
}

/** Installs the check and the mirror's ear on every applied change; returns the uninstall. */
export function installSessionOrganizationOwnership(): () => void {
  setOrganizationRevisionCheck((target, expected, change) =>
    checkOwnedRevision(target, expected, change)
  )
  setOrganizationAppliedListener((record) => mirror().applyRecord(record))
  return () => {
    setOrganizationRevisionCheck(null)
    setOrganizationAppliedListener(null)
  }
}

function isoOrNull(ms: number): string | null {
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

/** 1a batch filings whose session still sits in its batch folder; everything else is the person's. */
export function batchLaunchSeeds(
  origins: SessionBatchOrigins,
  metadata: SessionFolderMetadata
): OwnershipSeed[] {
  const batchFolders = new Map<string, Set<string>>()
  for (const folder of Object.values(origins.folders)) {
    batchFolders.set(
      folder.batchId,
      (batchFolders.get(folder.batchId) ?? new Set()).add(folder.folderId)
    )
  }
  return Object.entries(origins.sessions).flatMap(([key, origin]) => {
    const folderId = getSessionFolderId(metadata, key)
    const at = isoOrNull(origin.at)
    return folderId && at && batchFolders.get(origin.batchId)?.has(folderId)
      ? [{ key, value: folderId, batchId: origin.batchId, at }]
      : []
  })
}

async function seedFromBatchOrigins(rpc: OrganizationRpc): Promise<void> {
  const folders = useSessionFolders.getState()
  const origins = useSessionBatchOrigins.getState()
  if (!folders.loaded) {
    return
  }
  if (origins.scope === null) {
    origins.load()
  }
  // Why only keys the mirror knows nothing of: main refuses the rest anyway (it holds history too).
  const seeds = batchLaunchSeeds(useSessionBatchOrigins.getState().data, folders.metadata).filter(
    (seed) => isEmptyOrganizationKeyState(mirror().stateFor(seed.key))
  )
  if (seeds.length === 0) {
    return
  }
  const answer = await rpc<{ keys?: OwnershipMirror }>(SESSION_ORGANIZATION_OWNERSHIP_RPC.seed, {
    seeds: seeds.slice(0, 1000)
  })
  mirror().adopt(answer?.keys ?? {}, false)
}

/** Reads main's copy (authoritative) into the mirror, then seeds 1a batch filings once. */
export async function refreshSessionOrganizationOwnership(
  rpc: OrganizationRpc = localOrganizationRpc
): Promise<void> {
  try {
    const answer = await rpc<{ keys?: OwnershipMirror }>(
      SESSION_ORGANIZATION_OWNERSHIP_RPC.snapshot,
      {}
    )
    organizationOwnershipOutbox.stamps(mirror().adopt(answer?.keys ?? {}, true))
    await seedFromBatchOrigins(rpc)
  } catch (error) {
    // Why keep going: the mirror as saved still answers, and anything it lacks counts as yours.
    console.warn('[session-organization] reading ownership from main failed', error)
  }
}

const sentMoves = new Set<string>()

/** Ownership and history follow a pane's key to its provider key (see key migration). */
export const sessionOrganizationOwnershipMigration = {
  migrate: (moves: readonly OwnershipKeyMove[]): void => {
    for (const move of moves) {
      mirror().migrateKey(move.from, move.to, move.placementFrom)
    }
    // Why once per pair: history for the pane key lives only in main, and a repeat is a no-op there.
    const fresh = moves.filter((move) => !sentMoves.has(`${move.from}\0${move.to}`))
    for (const move of fresh) {
      sentMoves.add(`${move.from}\0${move.to}`)
    }
    if (fresh.length > 0) {
      organizationOwnershipOutbox.migrations(fresh)
    }
  },
  /** Forgets which pairs were sent, so a test starts like a fresh window. */
  forgetSent: (): void => {
    sentMoves.clear()
  }
}
