import { makePaneKey } from '../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { isLocalDaemonPtyId } from './idle-auto-close/idle-auto-close-decision'
import {
  clearBindingStorageForTests,
  finiteStamp,
  forgetStoredBindingReadForTests,
  setBindingStorageForTests,
  takeStoredBinding,
  writeStoredBindings,
  type BindingStorage,
  type StoredBinding
} from './agent-hibernation-pane-age-storage'

export { PTY_BINDING_AGE_STORAGE_KEY } from './agent-hibernation-pane-age-storage'

/**
 * inputAt / revealAt: a person's last keystroke into the pane, last reveal of its tab.
 * identity: which lifetime of the daemon session this is (its incarnation, else its pid), once a
 * daemon listing named it; `identityRead` once a listing was tried for it.
 * carried: the previous run's first-seen stamp, used only once a listing proves the same lifetime.
 */
type PtyBinding = {
  ptyId: string
  firstSeenAt: number
  lastSeenAt: number
  inputAt: number
  revealAt: number
  identity?: string
  identityRead?: true
  carried?: { firstSeenAt: number; identity?: string }
}

/** One live daemon session as `pty.management.listSessions` reports it. */
export type DaemonSessionIdentity = {
  sessionId: string
  incarnationId?: string | null
  pid?: number | null
}

/** The window's in-memory touch stamps, which an app restart erases. */
export type HibernationPaneTouches = {
  inputAtByPaneKey: Record<string, number | undefined>
  revealAtByTabId: Record<string, number | undefined>
  /** Panes put to sleep: their PTY is gone, and a draft with it (the window drops their input). */
  sleptPaneKeys?: ReadonlySet<string>
}

const ptyBindingByPaneKey = new Map<string, PtyBinding>()
const boundaryResolvedAtByPaneKey = new Map<string, number>()

/** The binding as storage keeps it; an unproven carried stamp is kept for the next run's proof. */
function toStoredBinding(binding: PtyBinding): StoredBinding {
  // Why the carried stamp while unproven: a quit before the proof must not lose it; the next run
  // still has to prove the same lifetime before it counts.
  const identity = binding.carried ? binding.carried.identity : binding.identity
  return {
    ptyId: binding.ptyId,
    firstSeenAt: binding.carried?.firstSeenAt ?? binding.firstSeenAt,
    ...(binding.inputAt ? { inputAt: binding.inputAt } : {}),
    ...(binding.revealAt ? { revealAt: binding.revealAt } : {}),
    ...(identity ? { identity } : {})
  }
}

function saveBindings(): void {
  writeStoredBindings(
    [...ptyBindingByPaneKey].map(([paneKey, binding]) => [paneKey, toStoredBinding(binding)])
  )
}

/**
 * The binding for a pane seen for the first time in this run. Why the stored stamps: the daemon
 * keeps PTYs alive across app restarts, so a pane still bound to the same daemon PTY has been idle
 * all along — restarting its clock on every relaunch is why idle agents never aged out. Its last
 * keystroke and reveal come back at once: they only keep a pane (a typed draft, G2), so they are
 * safe either way. Its first-seen stamp waits for proof (`applyDaemonSessionIdentities`): a cold
 * restore after a reboot or a daemon exit reuses the same PTY id for a freshly spawned process,
 * and reusing the old stamp then slept the agent the restore had just resumed. Until a listing
 * proves the same lifetime, and for a different PTY id, the window starts fresh.
 */
function bindingOnFirstSight(paneKey: string, ptyId: string, now: number): PtyBinding {
  const stored = takeStoredBinding(paneKey)
  const reused = stored && stored.ptyId === ptyId && stored.firstSeenAt <= now ? stored : null
  return {
    ptyId,
    firstSeenAt: now,
    lastSeenAt: now,
    inputAt: reused?.inputAt ?? 0,
    revealAt: reused?.revealAt ?? 0,
    ...(reused
      ? {
          carried: {
            firstSeenAt: reused.firstSeenAt,
            ...(reused.identity ? { identity: reused.identity } : {})
          }
        }
      : {})
  }
}

/** Raises a binding's touch stamps to the window's current ones; true when one moved. */
function absorbTouches(
  binding: PtyBinding,
  paneKey: string,
  touches: HibernationPaneTouches | undefined
): boolean {
  if (!touches) {
    return false
  }
  if (touches.sleptPaneKeys?.has(paneKey)) {
    const changed = binding.inputAt !== 0 || binding.revealAt !== 0
    binding.inputAt = 0
    binding.revealAt = 0
    return changed
  }
  const inputAt = Math.max(binding.inputAt, finiteStamp(touches.inputAtByPaneKey[paneKey]))
  const tabId = paneKey.slice(0, paneKey.indexOf(':'))
  const revealAt = Math.max(binding.revealAt, finiteStamp(touches.revealAtByTabId[tabId]))
  if (inputAt === binding.inputAt && revealAt === binding.revealAt) {
    return false
  }
  binding.inputAt = inputAt
  binding.revealAt = revealAt
  return true
}

/**
 * Floors the hibernation idle clock at the age of a pane's current PTY binding.
 *
 * Why: `dropHibernatedAgentStatusPane` never notifies main, and main's
 * `lastStatusByPaneKey` is persisted — so a woken pane replays an ancient
 * `stateStartedAt` and is instantly past the idle window. A wake spawns a fresh PTY,
 * so binding age restores the grace `updatedAt` used to provide by accident. An app
 * restart does not: the daemon PTY survives it, so a pane still bound to the same PTY
 * lifetime keeps its stored first-seen time (PTY_BINDING_AGE_STORAGE_KEY) once a daemon listing
 * proves that lifetime (`applyDaemonSessionIdentities`); a cold restore under the same id does not.
 */
export function observeHibernationPtyBindings(args: {
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  now: number
  idleMs: number
  touches?: HibernationPaneTouches
}): void {
  const liveTabIds = new Set<string>()
  for (const tabs of Object.values(args.tabsByWorktree)) {
    for (const tab of tabs) {
      liveTabIds.add(tab.id)
    }
  }
  const seenPaneKeys = new Set<string>()
  let changed = false
  for (const tabId of liveTabIds) {
    const ptyIdsByLeafId = args.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId
    for (const [leafId, ptyId] of Object.entries(ptyIdsByLeafId ?? {})) {
      if (!ptyId) {
        continue
      }
      let paneKey: string
      try {
        paneKey = makePaneKey(tabId, leafId)
      } catch {
        continue
      }
      seenPaneKeys.add(paneKey)
      let binding = ptyBindingByPaneKey.get(paneKey)
      if (binding && binding.ptyId === ptyId) {
        binding.lastSeenAt = args.now
      } else {
        binding = binding
          ? { ptyId, firstSeenAt: args.now, lastSeenAt: args.now, inputAt: 0, revealAt: 0 }
          : bindingOnFirstSight(paneKey, ptyId, args.now)
        ptyBindingByPaneKey.set(paneKey, binding)
        changed = true
      }
      changed = absorbTouches(binding, paneKey, args.touches) || changed
    }
  }
  // Why: a transient layout gap already makes the planner fail closed, so dropping
  // the binding there would hand the same PTY a fresh idle window on reappearance.
  // Retain unseen entries; expire only on authoritative tab removal or by age.
  for (const [paneKey, binding] of ptyBindingByPaneKey) {
    if (seenPaneKeys.has(paneKey)) {
      continue
    }
    const tabId = paneKey.slice(0, paneKey.indexOf(':'))
    if (!liveTabIds.has(tabId) || args.now - binding.lastSeenAt > args.idleMs) {
      ptyBindingByPaneKey.delete(paneKey)
      changed = true
    }
  }
  for (const paneKey of boundaryResolvedAtByPaneKey.keys()) {
    const tabId = paneKey.slice(0, paneKey.indexOf(':'))
    // Why: closed split panes mint fresh leaf ids when reopened. Once their
    // retained binding expires, keeping the boundary stamp would leak one map
    // entry per closed pane for the renderer's lifetime.
    if (!liveTabIds.has(tabId) || !ptyBindingByPaneKey.has(paneKey)) {
      boundaryResolvedAtByPaneKey.delete(paneKey)
    }
  }
  if (changed) {
    saveBindings()
  }
}

/** The lifetime a daemon listing names: its incarnation, else its pid (an older daemon). */
function sessionIdentity(session: DaemonSessionIdentity): string | null {
  if (typeof session.incarnationId === 'string' && session.incarnationId) {
    return `incarnation:${session.incarnationId}`
  }
  return typeof session.pid === 'number' && session.pid > 0 ? `pid:${session.pid}` : null
}

/** True while some local binding awaits a daemon listing (a carried stamp, or no identity yet). */
export function needsDaemonSessionIdentities(): boolean {
  for (const binding of ptyBindingByPaneKey.values()) {
    if (binding.identityRead) {
      continue
    }
    if (binding.carried || isLocalDaemonPtyId(binding.ptyId)) {
      return true
    }
  }
  return false
}

/**
 * Names each binding's daemon lifetime from one listing (null: the listing failed), and keeps a
 * carried first-seen stamp only when the listing shows the same lifetime the previous run saw.
 * Anything else — no listing, the session missing, another incarnation or pid, an unnamed earlier
 * lifetime, a PTY outside this daemon — leaves the fresh window. A binding asks for one listing;
 * one still unnamed after it (its PTY not listed yet) is named by whichever listing comes next.
 */
export function applyDaemonSessionIdentities(
  sessions: readonly DaemonSessionIdentity[] | null
): void {
  const identityById = new Map<string, string | null>()
  for (const session of sessions ?? []) {
    identityById.set(session.sessionId, sessionIdentity(session))
  }
  let changed = false
  for (const binding of ptyBindingByPaneKey.values()) {
    if (binding.identityRead && binding.identity) {
      continue
    }
    binding.identityRead = true
    const identity = isLocalDaemonPtyId(binding.ptyId)
      ? (identityById.get(binding.ptyId) ?? null)
      : null
    if (binding.carried) {
      if (identity && binding.carried.identity === identity) {
        binding.firstSeenAt = Math.min(binding.firstSeenAt, binding.carried.firstSeenAt)
      }
      delete binding.carried
      changed = true
    }
    if (identity && binding.identity !== identity) {
      binding.identity = identity
      changed = true
    }
  }
  if (changed) {
    saveBindings()
  }
}

/** Saves the window's touch stamps now (the window is going away), for the bindings it holds. */
export function persistHibernationPaneTouches(touches: HibernationPaneTouches): void {
  let changed = false
  for (const [paneKey, binding] of ptyBindingByPaneKey) {
    changed = absorbTouches(binding, paneKey, touches) || changed
  }
  if (changed) {
    saveBindings()
  }
}

/** One pane's carried stamps: its last keystroke, and its tab's last reveal. */
export function getHibernationPaneTouch(paneKey: string): { inputAt: number; revealAt: number } {
  const binding = ptyBindingByPaneKey.get(paneKey)
  return { inputAt: binding?.inputAt ?? 0, revealAt: binding?.revealAt ?? 0 }
}

/** The touch stamps the bindings carry, the previous run's included (G2 and the draft guard). */
export function getHibernationPaneTouchStamps(): {
  inputAtByPaneKey: Record<string, number>
  revealAtByTabId: Record<string, number>
} {
  const inputAtByPaneKey: Record<string, number> = {}
  const revealAtByTabId: Record<string, number> = {}
  for (const [paneKey, binding] of ptyBindingByPaneKey) {
    if (binding.inputAt) {
      inputAtByPaneKey[paneKey] = binding.inputAt
    }
    const tabId = paneKey.slice(0, paneKey.indexOf(':'))
    if (binding.revealAt > (revealAtByTabId[tabId] ?? 0)) {
      revealAtByTabId[tabId] = binding.revealAt
    }
  }
  return { inputAtByPaneKey, revealAtByTabId }
}

export function getHibernationPtyBindingFirstSeenAtByPaneKey(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [paneKey, binding] of ptyBindingByPaneKey) {
    out[paneKey] = binding.firstSeenAt
  }
  return out
}

/**
 * Stamped synchronously by the status store when a session-boundary `done` turns
 * into a real completion. Sampling this on the 60s coordinator tick would miss a
 * boundary written and cleared between two samples, leaving the pane on its
 * ancient anchor.
 */
export function recordHibernationBoundaryResolved(paneKey: string, now: number): void {
  if (paneKey) {
    boundaryResolvedAtByPaneKey.set(paneKey, now)
  }
}

export function getHibernationBoundaryResolvedAtByPaneKey(): Record<string, number> {
  return Object.fromEntries(boundaryResolvedAtByPaneKey)
}

export function forgetHibernationPaneAge(paneKey: string): void {
  ptyBindingByPaneKey.delete(paneKey)
  boundaryResolvedAtByPaneKey.delete(paneKey)
}

/** What an app restart does to this module: memory is gone, storage stays. */
export function simulateHibernationPaneAgeRestartForTests(): void {
  ptyBindingByPaneKey.clear()
  boundaryResolvedAtByPaneKey.clear()
  forgetStoredBindingReadForTests()
}

export function setHibernationPaneAgeStorageForTests(storage: BindingStorage | null): void {
  setBindingStorageForTests(storage)
}

export function resetHibernationPaneAgeForTests(): void {
  clearBindingStorageForTests()
  simulateHibernationPaneAgeRestartForTests()
  setBindingStorageForTests(undefined)
}
