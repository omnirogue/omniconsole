import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import {
  parseWebTerminalSurfaceTabId,
  toOwnerQualifiedWebTerminalSurfaceTabId,
  toWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner'
import { getCatalogRuntimeOwnerEnvironmentId } from '@/lib/session-inventory-workspace-provenance'
import {
  resolveMirrorEnvironmentRetirement,
  type MirrorEnvironmentCatalogState
} from './web-session-mirror-environments'

/**
 * Which paired environment a mirrored terminal row belongs to, from the evidence the row itself
 * carries: an owner-qualified id, remote PTY ids and the unified tab's stamped execution host.
 * `unknown` has no evidence (pre-stamp legacy rows); `ambiguous` has conflicting evidence and is
 * a legacy alias no frame may claim and no action may target.
 */
export type MirroredTerminalRowOwner =
  | { kind: 'owned'; environmentId: string }
  | { kind: 'unknown' }
  | { kind: 'ambiguous' }

export type MirroredTerminalOwnerEvidenceState = {
  terminalLayoutsByTabId: Readonly<Record<string, TerminalLayoutSnapshot | undefined>>
  ptyIdsByTabId: Readonly<Record<string, readonly string[] | undefined>>
  unifiedTabsByWorktree: Readonly<Record<string, readonly Tab[] | undefined>>
}

type MirroredTerminalRowsState = MirroredTerminalOwnerEvidenceState & {
  tabsByWorktree: Readonly<Record<string, readonly TerminalTab[] | undefined>>
}

export function resolveMirroredTerminalRowOwner(
  tab: Pick<TerminalTab, 'id' | 'ptyId'>,
  evidence: {
    layout?: Pick<TerminalLayoutSnapshot, 'ptyIdsByLeafId'>
    ptyIds?: readonly string[]
    unifiedTab?: Pick<Tab, 'executionHostId'>
  }
): MirroredTerminalRowOwner {
  const owners = new Set<string>()
  const qualified = parseWebTerminalSurfaceTabId(tab.id)?.environmentId
  if (qualified) {
    // Why: the qualified id was minted for exactly one owner; nothing outranks it.
    return { kind: 'owned', environmentId: qualified }
  }
  const ptyIds = [
    tab.ptyId,
    ...Object.values(evidence.layout?.ptyIdsByLeafId ?? {}),
    ...(evidence.ptyIds ?? [])
  ]
  for (const ptyId of ptyIds) {
    const environmentId = ptyId ? parseRemoteRuntimePtyId(ptyId)?.environmentId : null
    if (environmentId) {
      owners.add(environmentId)
    }
  }
  const host = parseExecutionHostId(evidence.unifiedTab?.executionHostId)
  if (host?.kind === 'runtime') {
    owners.add(host.environmentId)
  }
  if (owners.size === 0) {
    return { kind: 'unknown' }
  }
  return owners.size === 1
    ? { kind: 'owned', environmentId: [...owners][0]! }
    : { kind: 'ambiguous' }
}

/** Builds the worktree's owner lookup once per frame (unified tabs are indexed by entity). */
export function createMirroredTerminalOwnerResolver(
  state: MirroredTerminalOwnerEvidenceState,
  worktreeId: string
): (tab: Pick<TerminalTab, 'id' | 'ptyId'>) => MirroredTerminalRowOwner {
  const unifiedByTerminalId = new Map<string, Tab>()
  for (const unified of state.unifiedTabsByWorktree[worktreeId] ?? []) {
    if (unified.contentType === 'terminal' && !unifiedByTerminalId.has(unified.entityId)) {
      unifiedByTerminalId.set(unified.entityId, unified)
    }
  }
  return (tab) =>
    resolveMirroredTerminalRowOwner(tab, {
      layout: state.terminalLayoutsByTabId[tab.id],
      ptyIds: state.ptyIdsByTabId[tab.id],
      unifiedTab: unifiedByTerminalId.get(tab.id)
    })
}

/**
 * The owner of a row holding `localTabId` in another workspace. Layouts, bindings and agent
 * status are keyed by client tab id across all workspaces, so a second owner's identical host id
 * collides there too. Every mirror row stores a layout, so a miss is answered without a scan.
 */
export function createElsewhereMirroredTerminalOwnerLookup(
  state: MirroredTerminalRowsState,
  worktreeId: string
): (localTabId: string) => MirroredTerminalRowOwner | null {
  return (localTabId) => {
    if (
      state.terminalLayoutsByTabId[localTabId] === undefined &&
      state.ptyIdsByTabId[localTabId] === undefined
    ) {
      return null
    }
    for (const [otherWorktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
      const tab =
        otherWorktreeId === worktreeId ? undefined : tabs?.find((row) => row.id === localTabId)
      if (tab) {
        return createMirroredTerminalOwnerResolver(state, otherWorktreeId)(tab)
      }
    }
    return null
  }
}

/**
 * The client-local row id for environment `environmentId`'s host tab.
 *
 * Why keep legacy ids instead of renaming every mirror: the legacy id stays the identity of the
 * owner whose evidence already proves it, so persisted organization, archive, layout, status and
 * pending-intent keys keep resolving across the upgrade with no rename to migrate or get wrong.
 * Only a second owner publishing an identical host id — in this workspace or, through the global
 * client-id maps, another one — gets an owner-qualified id; once persisted, ids are stable whatever
 * order frames arrive in. RPCs always send the original host id (toHostSessionTabId).
 */
export function createMirroredTerminalLocalIdResolver(args: {
  environmentId: string
  existingById: ReadonlyMap<string, Pick<TerminalTab, 'id' | 'ptyId'>>
  ownerOf: (tab: Pick<TerminalTab, 'id' | 'ptyId'>) => MirroredTerminalRowOwner
  /** Owners whose rows this environment may take over (retired: removed or same host). */
  isClaimableOwner?: (ownerEnvironmentId: string) => boolean
  elsewhereOwnerOf?: (localTabId: string) => MirroredTerminalRowOwner | null
}): (hostTabId: string) => string {
  const cache = new Map<string, string>()
  const ownedHere = (owner: MirroredTerminalRowOwner): boolean =>
    owner.kind === 'owned' &&
    (owner.environmentId === args.environmentId ||
      args.isClaimableOwner?.(owner.environmentId) === true)
  return (hostTabId) => {
    const cached = cache.get(hostTabId)
    if (cached !== undefined) {
      return cached
    }
    const qualified = toOwnerQualifiedWebTerminalSurfaceTabId(args.environmentId, hostTabId)
    const legacy = toWebTerminalSurfaceTabId(hostTabId)
    const legacyRow = args.existingById.get(legacy)
    let localId = legacy
    if (args.existingById.has(qualified)) {
      localId = qualified
    } else if (legacyRow) {
      const owner = args.ownerOf(legacyRow)
      localId = owner.kind === 'unknown' || ownedHere(owner) ? legacy : qualified
    } else {
      // Why: an unproven row elsewhere still shares the global maps, so only this owner keeps it.
      const elsewhere = args.elsewhereOwnerOf?.(legacy) ?? null
      localId = elsewhere === null || ownedHere(elsewhere) ? legacy : qualified
    }
    cache.set(hostTabId, localId)
    return localId
  }
}

/**
 * The client id the receiver gives (or will give) `environmentId`'s host tab in `worktreeId`.
 * Create, split-focus and launch helpers use it so a colliding second owner's new tab is found
 * under its owner-qualified id, exactly as the next frame will place it.
 */
export function resolveWebTerminalSurfaceTabIdForHost(
  // Why partial: callers hand over whatever store snapshot they hold; a missing map is no row.
  state: Partial<MirroredTerminalRowsState> & MirrorEnvironmentCatalogState,
  environmentId: string | null | undefined,
  worktreeId: string,
  hostTabId: string
): string {
  if (!environmentId) {
    return toWebTerminalSurfaceTabId(hostTabId)
  }
  const rows: MirroredTerminalRowsState = {
    tabsByWorktree: state.tabsByWorktree ?? {},
    terminalLayoutsByTabId: state.terminalLayoutsByTabId ?? {},
    ptyIdsByTabId: state.ptyIdsByTabId ?? {},
    unifiedTabsByWorktree: state.unifiedTabsByWorktree ?? {}
  }
  const retirement = resolveMirrorEnvironmentRetirement(state)
  return createMirroredTerminalLocalIdResolver({
    environmentId,
    existingById: new Map((rows.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab])),
    ownerOf: createMirroredTerminalOwnerResolver(rows, worktreeId),
    isClaimableOwner: (owner) => retirement.isRetiredFor(owner, environmentId),
    elsewhereOwnerOf: createElsewhereMirroredTerminalOwnerLookup(rows, worktreeId)
  })(hostTabId)
}

/**
 * Where an action on a mirrored terminal row must go. A row with a proven owner is addressed to
 * that owner even when its workspace resolves elsewhere; an ambiguous legacy alias is refused so
 * no close or activation lands on a guessed computer. Other rows keep the caller's routing.
 */
export function resolveMirroredTerminalActionEnvironmentId(
  // Why optional: callers pass whatever store slice they hold; a missing map is no evidence.
  state: Partial<MirroredTerminalOwnerEvidenceState> & {
    tabsByWorktree?: Readonly<Record<string, readonly TerminalTab[] | undefined>>
  },
  worktreeId: string,
  localTabId: string,
  fallbackEnvironmentId: string | null
): { kind: 'route'; environmentId: string | null } | { kind: 'refuse' } {
  const tab = parseWebTerminalSurfaceTabId(localTabId)
    ? state.tabsByWorktree?.[worktreeId]?.find((candidate) => candidate.id === localTabId)
    : undefined
  if (!tab) {
    return { kind: 'route', environmentId: fallbackEnvironmentId }
  }
  const owner = createMirroredTerminalOwnerResolver(
    {
      terminalLayoutsByTabId: state.terminalLayoutsByTabId ?? {},
      ptyIdsByTabId: state.ptyIdsByTabId ?? {},
      unifiedTabsByWorktree: state.unifiedTabsByWorktree ?? {}
    },
    worktreeId
  )(tab)
  if (owner.kind === 'ambiguous') {
    return { kind: 'refuse' }
  }
  return {
    kind: 'route',
    environmentId: owner.kind === 'owned' ? owner.environmentId : fallbackEnvironmentId
  }
}

/**
 * The paired environment the saved catalog credits with `worktreeId` exclusively, if any. Why
 * catalog only: the host a window has open is navigation; reading it made a workspace two
 * computers publish look exclusively owned by whichever copy was open.
 */
export function getWebSessionWorkspaceOwnerEnvironmentId(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): string | null {
  return getCatalogRuntimeOwnerEnvironmentId(state, worktreeId)
}

const ignoredForeignOwnerFramesByEnvironment = new Map<string, number>()

/**
 * Whether a frame from `environmentId` for `worktreeId` is an echo: the saved catalog credits the
 * workspace to a different paired computer, or a live newer pairing of the same host supersedes
 * this environment. A new pairing of the owner's own host (proven by a shared runtime id) is the
 * owner, not an echo. Pure: decide counts it, and parked frames are re-checked with it.
 */
export function isWebSessionTabsFrameFromForeignOwner(
  state: WorktreeRuntimeOwnerState & MirrorEnvironmentCatalogState,
  worktreeId: string,
  environmentId: string
): boolean {
  const retirement = resolveMirrorEnvironmentRetirement(state)
  if (retirement.supersededBy(environmentId) !== null) {
    return true
  }
  const owner = getWebSessionWorkspaceOwnerEnvironmentId(state, worktreeId)
  return (
    owner !== null &&
    owner !== environmentId &&
    !retirement.isSameHost(owner, environmentId) &&
    !retirement.isRetiredFor(owner, environmentId)
  )
}

/** As isWebSessionTabsFrameFromForeignOwner, counting the ignored frame for the frame log. */
export function isForeignOwnerWebSessionTabsFrame(
  state: WorktreeRuntimeOwnerState & MirrorEnvironmentCatalogState,
  worktreeId: string,
  environmentId: string
): boolean {
  if (!isWebSessionTabsFrameFromForeignOwner(state, worktreeId, environmentId)) {
    return false
  }
  ignoredForeignOwnerFramesByEnvironment.set(
    environmentId,
    (ignoredForeignOwnerFramesByEnvironment.get(environmentId) ?? 0) + 1
  )
  return true
}

export function getIgnoredForeignOwnerWebSessionTabsFrameCounts(): ReadonlyMap<string, number> {
  return new Map(ignoredForeignOwnerFramesByEnvironment)
}

export function resetIgnoredForeignOwnerWebSessionTabsFrameCountsForTests(): void {
  ignoredForeignOwnerFramesByEnvironment.clear()
}
