import { useSyncExternalStore } from 'react'
import type { RelaunchLiveCapture } from './codex-resume-relaunch-live-capture'

export type CodexResumeRelaunchPhase =
  | 'restarting'
  | 'verifying'
  | 'confirmed'
  | 'mismatch'
  | 'unverified'
  | 'failed'

/** The picker option the person actually chose. */
export type CodexResumeRelaunchSelectedOption = 'model' | 'effort'

export type CodexResumeRelaunchStatus = {
  phase: CodexResumeRelaunchPhase
  requested: { model: string; effort?: string }
  /** Why: `requested` also carries the effort a model pick keeps for the launch line;
   *  only the option picked here is persisted once the relaunch confirms. */
  selectedOption: CodexResumeRelaunchSelectedOption
  threadId: string
  previousPtyId: string
  newPtyId?: string
  observed?: { model: string; effort: string }
  error?: string
  startedAt: number
}

/**
 * Why a module store: the option surface is rebuilt on every PTY id flip and the
 * relaunch kills the PTY on purpose, so the in-flight record must outlive both
 * the surface and the composer that started it. Terminal phases persist until
 * the next `begin` or `clear`, so the pickers can show the last outcome.
 */
const statusByPaneKey = new Map<string, CodexResumeRelaunchStatus>()
const listeners = new Set<() => void>()
/** Why here and not in the hook: a remount mid-verification would otherwise drop
 *  the bytes already captured and start listening midstream, where a replayed
 *  transcript can quote a header. The capture belongs to the attempt, not the mount. */
const captureByPaneKey = new Map<string, RelaunchLiveCapture>()
const captureExpiryByPaneKey = new Map<string, ReturnType<typeof setTimeout>>()
export const CODEX_RELAUNCH_STALE_IN_FLIGHT_MS = 60_000

const TERMINAL_PHASES: ReadonlySet<CodexResumeRelaunchPhase> = new Set([
  'confirmed',
  'mismatch',
  'unverified',
  'failed'
])

export function disposeCodexResumeRelaunchCapture(paneKey: string): void {
  clearTimeout(captureExpiryByPaneKey.get(paneKey))
  captureExpiryByPaneKey.delete(paneKey)
  const capture = captureByPaneKey.get(paneKey)
  if (capture) {
    captureByPaneKey.delete(paneKey)
    capture.dispose()
  }
}

export function attachCodexResumeRelaunchCapture(
  paneKey: string,
  capture: RelaunchLiveCapture
): void {
  disposeCodexResumeRelaunchCapture(paneKey)
  captureByPaneKey.set(paneKey, capture)
  // A closed chat has no verifier tick to release delivery interest.
  const startedAt = statusByPaneKey.get(paneKey)?.startedAt ?? Date.now()
  captureExpiryByPaneKey.set(
    paneKey,
    setTimeout(
      () => {
        if (captureByPaneKey.get(paneKey) === capture) {
          disposeCodexResumeRelaunchCapture(paneKey)
        }
      },
      Math.max(0, CODEX_RELAUNCH_STALE_IN_FLIGHT_MS - (Date.now() - startedAt))
    )
  )
}

export function readCodexResumeRelaunchCapture(paneKey: string): RelaunchLiveCapture | null {
  return captureByPaneKey.get(paneKey) ?? null
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function beginCodexResumeRelaunch(paneKey: string, init: CodexResumeRelaunchStatus): void {
  disposeCodexResumeRelaunchCapture(paneKey)
  statusByPaneKey.set(paneKey, { ...init })
  notify()
}

export function advanceCodexResumeRelaunch(
  paneKey: string,
  patch: Partial<
    Omit<CodexResumeRelaunchStatus, 'requested' | 'selectedOption' | 'threadId' | 'startedAt'>
  >
): void {
  const current = statusByPaneKey.get(paneKey)
  if (!current) {
    return
  }
  statusByPaneKey.set(paneKey, { ...current, ...patch })
  if (patch.phase && TERMINAL_PHASES.has(patch.phase)) {
    disposeCodexResumeRelaunchCapture(paneKey)
  }
  notify()
}

export function clearCodexResumeRelaunch(paneKey: string): void {
  disposeCodexResumeRelaunchCapture(paneKey)
  if (statusByPaneKey.delete(paneKey)) {
    notify()
  }
}

export function readCodexResumeRelaunch(paneKey: string): CodexResumeRelaunchStatus | null {
  return statusByPaneKey.get(paneKey) ?? null
}

export function subscribeCodexResumeRelaunch(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isCodexResumeRelaunchStatusInFlight(
  status: Pick<CodexResumeRelaunchStatus, 'phase'> | null | undefined
): boolean {
  return status?.phase === 'restarting' || status?.phase === 'verifying'
}

export function isCodexResumeRelaunchInFlight(paneKey: string): boolean {
  return isCodexResumeRelaunchStatusInFlight(statusByPaneKey.get(paneKey))
}

export function useCodexResumeRelaunchStatus(paneKey: string): CodexResumeRelaunchStatus | null {
  return useSyncExternalStore(
    subscribeCodexResumeRelaunch,
    () => readCodexResumeRelaunch(paneKey),
    () => readCodexResumeRelaunch(paneKey)
  )
}

export function resetCodexResumeRelaunchForTests(): void {
  for (const paneKey of captureByPaneKey.keys()) {
    disposeCodexResumeRelaunchCapture(paneKey)
  }
  captureByPaneKey.clear()
  statusByPaneKey.clear()
  listeners.clear()
}
