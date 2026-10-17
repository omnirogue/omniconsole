import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { PtySpawnResult } from '../../../providers/types'
import { AGENT_LAUNCH_CANCELLED_ERROR } from '../../../pty/agent-launch-admission'

export type PaneSpawnReservation = {
  promise: Promise<PaneSpawnReservationResult>
  resolve: (result: PaneSpawnReservationResult) => void
  reject: (error: unknown) => void
}
export type PaneSpawnReservationResult = {
  id: string
  launchConfig?: SleepingAgentLaunchConfig
  stablePaneOwner?: {
    handle: string
    tabId: string
    leafId: string
  }
} & Partial<PtySpawnResult>

// Why: identical pane coordinates on different worktrees or hosts are independent owners.
export const paneSpawnReservationsByOwnerKey = new Map<string, PaneSpawnReservation>()
export type PendingRuntimePaneCreate = {
  count: number
  promise: Promise<void>
  resolve: () => void
}
export const pendingRuntimePaneCreatesByOwnerKey = new Map<string, PendingRuntimePaneCreate>()

export function reservePaneSpawn(paneKey: string): PaneSpawnReservation {
  let resolve!: (result: PaneSpawnReservationResult) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<PaneSpawnReservationResult>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  promise.catch(() => {})
  const reservation = { promise, resolve, reject }
  paneSpawnReservationsByOwnerKey.set(paneKey, reservation)
  return reservation
}

export function clearPaneSpawnReservation(
  paneKey: string,
  reservation: PaneSpawnReservation
): void {
  if (paneSpawnReservationsByOwnerKey.get(paneKey) === reservation) {
    paneSpawnReservationsByOwnerKey.delete(paneKey)
  }
}

export function makePaneSpawnReservationKey(
  worktreeId: string | undefined,
  connectionId: string | null | undefined,
  paneKey: string | null | undefined
): string | null {
  return paneKey ? JSON.stringify([connectionId ?? null, worktreeId ?? null, paneKey]) : null
}

export function claimRuntimePaneCreate(ownerKey: string): () => void {
  const existing = pendingRuntimePaneCreatesByOwnerKey.get(ownerKey)
  if (existing) {
    existing.count += 1
    return () => releaseRuntimePaneCreate(ownerKey, existing)
  }
  let resolve!: () => void
  const claim = {
    count: 1,
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve: () => resolve()
  }
  pendingRuntimePaneCreatesByOwnerKey.set(ownerKey, claim)
  return () => releaseRuntimePaneCreate(ownerKey, claim)
}

export function releaseRuntimePaneCreate(ownerKey: string, claim: PendingRuntimePaneCreate): void {
  if (pendingRuntimePaneCreatesByOwnerKey.get(ownerKey) !== claim) {
    return
  }
  claim.count -= 1
  if (claim.count > 0) {
    return
  }
  pendingRuntimePaneCreatesByOwnerKey.delete(ownerKey)
  claim.resolve()
}

/**
 * Waits for the spawn that already reserved this pane. Null when that spawn was an agent start
 * cancelled while it waited for an admission slot (its pane went away, for example a remount):
 * it never ran, so the waiter must go ahead with its own spawn rather than inherit the cancel.
 */
export async function awaitPaneSpawnUnlessCancelled(
  reservation: PaneSpawnReservation
): Promise<PaneSpawnReservationResult | null> {
  try {
    return await reservation.promise
  } catch (error) {
    if (error instanceof Error && error.message === AGENT_LAUNCH_CANCELLED_ERROR) {
      return null
    }
    throw error
  }
}

/** The reservation a waiter should wait on next: the pane's current one, unless it is the one
 *  that was just cancelled (a reject clears its map entry, so this only guards against a loop). */
export function nextPaneSpawnReservation(
  ownerKey: string,
  cancelled: PaneSpawnReservation
): PaneSpawnReservation | undefined {
  const next = paneSpawnReservationsByOwnerKey.get(ownerKey)
  return next === cancelled ? undefined : next
}

export function rejectPaneSpawnReservation(
  paneKey: string | null | undefined,
  reservation: PaneSpawnReservation | null | undefined,
  error: unknown
): void {
  if (!reservation) {
    return
  }
  reservation.reject(error)
  if (paneKey) {
    clearPaneSpawnReservation(paneKey, reservation)
  }
}

export function resolvePaneSpawnReservation<T extends PaneSpawnReservationResult>(
  paneKey: string | null | undefined,
  reservation: PaneSpawnReservation | null | undefined,
  response: T
): T {
  if (!reservation) {
    return response
  }
  reservation.resolve(response)
  if (paneKey) {
    clearPaneSpawnReservation(paneKey, reservation)
  }
  return response
}
