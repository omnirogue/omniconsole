// Why: presence-based driver state for the mobile-presence lock. Mirrors
// the runtime's `currentDriver` map. Keyed by ptyId. Updated by an IPC
// listener (onTerminalDriverChanged) wired from main.
//
// While `getDriverForPty(ptyId).kind === 'mobile'` the renderer:
//   - drops xterm.onData (input lock)
//   - drops xterm.onResize (resize lock)
//   - mounts the lock banner with the "Take back" affordance
//
// See docs/mobile-presence-lock.md.

import type { RuntimeTerminalDriverState } from '../../../../shared/runtime-types'

export type DriverState = RuntimeTerminalDriverState

const driverByPtyId = new Map<string, DriverState>()
// Why: a person who just let go of a PTY (phone locked, desktop "Take back" ended) still counts
// as having touched it for a while; the live seat alone forgets them the moment they release.
const releasedAtByPtyId = new Map<string, number>()
// Why an hour: readers look back ten minutes (archive sleep's G2); this bounds the map without
// cutting that window short.
const RELEASE_MEMORY_MS = 60 * 60 * 1000

function stampRelease(ptyId: string): void {
  const now = Date.now()
  for (const [id, at] of releasedAtByPtyId) {
    if (now - at > RELEASE_MEMORY_MS) {
      releasedAtByPtyId.delete(id)
    }
  }
  releasedAtByPtyId.set(ptyId, now)
}

type DriverChangeEvent = {
  ptyId: string
  driver: DriverState
}
type DriverChangeListener = (event: DriverChangeEvent) => void
const changeListeners = new Set<DriverChangeListener>()

export function onDriverChange(listener: DriverChangeListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notifyChange(event: DriverChangeEvent): void {
  for (const listener of changeListeners) {
    listener(event)
  }
}

export function setDriverForPty(ptyId: string, driver: DriverState): void {
  if (driver.kind === 'idle') {
    if (driverByPtyId.delete(ptyId)) {
      stampRelease(ptyId)
    }
  } else {
    driverByPtyId.set(ptyId, driver)
  }
  notifyChange({ ptyId, driver })
}

export function replaceDriverPtyId(replacedPtyId: string, ptyId: string): void {
  // Why: a recent release belongs to the pane, not the rotated handle.
  const releasedAt = releasedAtByPtyId.get(replacedPtyId)
  if (releasedAt !== undefined) {
    releasedAtByPtyId.delete(replacedPtyId)
    releasedAtByPtyId.set(ptyId, Math.max(releasedAtByPtyId.get(ptyId) ?? 0, releasedAt))
  }
  const replaced = driverByPtyId.get(replacedPtyId)
  if (!replaced) {
    return
  }
  // Why: keep the presence lock conservative across handle rotation while
  // removing the obsolete key that repeated reconnects would otherwise retain.
  if (!driverByPtyId.has(ptyId)) {
    setDriverForPty(ptyId, replaced)
  }
  driverByPtyId.delete(replacedPtyId)
  notifyChange({ ptyId: replacedPtyId, driver: { kind: 'idle' } })
}

export function getDriverForPty(ptyId: string): DriverState {
  return driverByPtyId.get(ptyId) ?? { kind: 'idle' }
}

/** When a person last let go of this PTY's driver seat; undefined when none did recently. */
export function getDriverReleasedAtForPty(ptyId: string): number | undefined {
  return releasedAtByPtyId.get(ptyId)
}

export function getAllDrivers(): Map<string, DriverState> {
  return new Map(driverByPtyId)
}

export function isPtyLocked(ptyId: string): boolean {
  return driverByPtyId.get(ptyId)?.kind === 'mobile'
}

export function hydrateDrivers(drivers: { ptyId: string; driver: DriverState }[]): void {
  const wasDriven = [...driverByPtyId.keys()]
  const affectedPtyIds = new Set(wasDriven)
  driverByPtyId.clear()

  for (const { ptyId, driver } of drivers) {
    affectedPtyIds.add(ptyId)
    if (driver.kind !== 'idle') {
      driverByPtyId.set(ptyId, driver)
    }
  }
  for (const ptyId of wasDriven) {
    if (!driverByPtyId.has(ptyId)) {
      stampRelease(ptyId)
    }
  }

  // Why: startup hydration can arrive after TerminalPane has mounted. Notify
  // all affected PTYs so the pane-local overlay cannot miss an active lock.
  for (const ptyId of affectedPtyIds) {
    notifyChange({ ptyId, driver: getDriverForPty(ptyId) })
  }
}
