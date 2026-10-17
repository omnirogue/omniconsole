/**
 * Which paired environment ids no longer stand for a live owner of their mirrored rows.
 *
 * Why: re-pairing a computer can mint a new environment id while rows mirrored under the old id
 * persist; owner buckets would then show both copies. An old id is retired only on proof — it
 * left the saved environment list, or a newer saved environment is positively the same host (the
 * same runtime id, from its pairing record or its live status). Nothing is re-attributed on a
 * guess, and retiring a mirror only retracts visibility; it never stops a process.
 */

export type MirrorEnvironmentCatalogState = {
  runtimeEnvironments?: readonly {
    id: string
    runtimeId?: string | null
    createdAt?: number
    pairingRevision?: number
  }[]
  runtimeEnvironmentCatalogHydrated?: boolean
  runtimeStatusByEnvironmentId?: ReadonlyMap<string, { status: { runtimeId?: string } | null }>
  removedRuntimeEnvironmentIds?: ReadonlySet<string>
}

export type MirrorEnvironmentRetirement = {
  /** The saved environment positively identified as the same host that supersedes this one. */
  supersededBy: (environmentId: string) => string | null
  /** Both ids are positively the same host (shared runtime id). */
  isSameHost: (environmentId: string, otherEnvironmentId: string) => boolean
  /** Rows owned by `ownerEnvironmentId` may be retracted or claimed by `environmentId`'s frame. */
  isRetiredFor: (ownerEnvironmentId: string, environmentId: string) => boolean
}

const NONE: MirrorEnvironmentRetirement = {
  supersededBy: () => null,
  isSameHost: () => false,
  isRetiredFor: () => false
}

type SavedEnvironment = NonNullable<MirrorEnvironmentCatalogState['runtimeEnvironments']>[number]

function pairingOrder(environment: { createdAt?: number; pairingRevision?: number }): number {
  return environment.pairingRevision ?? environment.createdAt ?? 0
}

export function resolveMirrorEnvironmentRetirement(
  state: MirrorEnvironmentCatalogState
): MirrorEnvironmentRetirement {
  const environments = state.runtimeEnvironments ?? []
  const removed = state.removedRuntimeEnvironmentIds
  const hydrated = state.runtimeEnvironmentCatalogHydrated === true
  if (environments.length === 0 && !hydrated && (removed?.size ?? 0) === 0) {
    return NONE
  }
  const savedIds = new Set(environments.map((environment) => environment.id))
  const isLive = (environment: SavedEnvironment): boolean =>
    Boolean(state.runtimeStatusByEnvironmentId?.get(environment.id)?.status)
  // Why: a connected entry outranks a newer one that cannot be reached, so frames from the
  // pairing that actually answers are never dropped in favour of one that does not.
  const outranks = (candidate: SavedEnvironment, current: SavedEnvironment): boolean =>
    isLive(candidate) !== isLive(current)
      ? isLive(candidate)
      : pairingOrder(candidate) !== pairingOrder(current)
        ? pairingOrder(candidate) > pairingOrder(current)
        : candidate.id > current.id
  // Why: two saved environments sharing a runtime id reach the same host process.
  const canonicalByRuntimeId = new Map<string, SavedEnvironment>()
  const runtimeIdsByEnvironment = new Map<string, string[]>()
  for (const environment of environments) {
    const liveRuntimeId = state.runtimeStatusByEnvironmentId?.get(environment.id)?.status?.runtimeId
    const runtimeIds = [environment.runtimeId, liveRuntimeId].filter(
      (runtimeId): runtimeId is string => typeof runtimeId === 'string' && runtimeId.length > 0
    )
    runtimeIdsByEnvironment.set(environment.id, runtimeIds)
    for (const runtimeId of runtimeIds) {
      const current = canonicalByRuntimeId.get(runtimeId)
      if (!current || outranks(environment, current)) {
        canonicalByRuntimeId.set(runtimeId, environment)
      }
    }
  }
  const supersededBy = (environmentId: string): string | null => {
    for (const runtimeId of runtimeIdsByEnvironment.get(environmentId) ?? []) {
      const canonical = canonicalByRuntimeId.get(runtimeId)
      if (canonical && canonical.id !== environmentId) {
        return canonical.id
      }
    }
    return null
  }
  const isSameHost = (environmentId: string, otherEnvironmentId: string): boolean => {
    const other = new Set(runtimeIdsByEnvironment.get(otherEnvironmentId) ?? [])
    return (runtimeIdsByEnvironment.get(environmentId) ?? []).some((runtimeId) =>
      other.has(runtimeId)
    )
  }
  const isRemoved = (environmentId: string): boolean =>
    removed?.has(environmentId) === true || (hydrated && !savedIds.has(environmentId))
  return {
    supersededBy,
    isSameHost,
    isRetiredFor: (ownerEnvironmentId, environmentId) =>
      ownerEnvironmentId !== environmentId &&
      (isRemoved(ownerEnvironmentId) || supersededBy(ownerEnvironmentId) === environmentId)
  }
}
