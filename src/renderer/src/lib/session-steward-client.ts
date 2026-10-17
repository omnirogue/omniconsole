/**
 * The window's reading of this computer's session steward: one shared poll of
 * `sessionSteward.status` for every surface that shows it (the Work card, the sidebar's Stalled
 * rows), the result cards of what it archived, and when the person last looked at them. An older
 * host without the steward answers nothing, and nothing is shown.
 */

import { useMemo, useSyncExternalStore } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  SESSION_STEWARD_STATUS_RPC,
  STEWARD_FINISHED_SEEN_STORAGE_KEY,
  type SessionStewardFinishedResult,
  type SessionStewardStatus,
  type StewardResultCard
} from '../../../shared/session-steward-status'
import { personalViewStorageKey } from './personal-view-storage'

export const STEWARD_STATUS_POLL_MS = 60_000

let snapshot: SessionStewardStatus | null = null
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
const EMPTY_KEYS: ReadonlySet<string> = new Set()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function isStewardStatus(value: unknown): value is SessionStewardStatus {
  const status = value as Partial<SessionStewardStatus> | null
  return Boolean(
    status &&
    Array.isArray(status.stalled) &&
    Array.isArray(status.silent) &&
    Array.isArray(status.activity) &&
    typeof status.prompts?.today === 'number'
  )
}

/** Reads the steward now; a host without one leaves the last reading (none at first). */
export function refreshSessionStewardStatus(): Promise<void> {
  return callRuntimeRpc<SessionStewardStatus>(
    { kind: 'local' },
    SESSION_STEWARD_STATUS_RPC.status,
    {}
  )
    .then((status) => {
      // Why check: another host's answer is only shown when it has the shape this window reads.
      snapshot = isStewardStatus(status) ? status : null
      emit()
    })
    .catch(() => {})
}

let pollers = 0

/** Keeps the reading fresh while held; returns the release. */
export function pollSessionStewardStatus(): () => void {
  pollers += 1
  if (pollers === 1) {
    void refreshSessionStewardStatus()
    timer = setInterval(() => void refreshSessionStewardStatus(), STEWARD_STATUS_POLL_MS)
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    pollers -= 1
    if (pollers === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

function listen(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function subscribeAndPoll(listener: () => void): () => void {
  const stopListening = listen(listener)
  const stopPolling = pollSessionStewardStatus()
  return () => {
    stopListening()
    stopPolling()
  }
}

/** The Work card's reading: holding it keeps the poll running. */
export function useSessionStewardStatus(): SessionStewardStatus | null {
  return useSyncExternalStore(subscribeAndPoll, () => snapshot)
}

/**
 * The panes the steward lists as Stalled, for the sidebar to show beside Needs you. It only reads:
 * the app's own poll (`registerSessionStewardStatusPoll`) or the Work card keeps it fresh.
 */
export function useStewardStalledPaneKeys(): ReadonlySet<string> {
  const status = useSyncExternalStore(listen, () => snapshot)
  return useMemo(
    () =>
      status?.stalled.length ? new Set(status.stalled.map((entry) => entry.paneKey)) : EMPTY_KEYS,
    [status]
  )
}

/** For the app's lifetime (window IPC bridges). */
export function registerSessionStewardStatusPoll(unsubs: (() => void)[]): void {
  unsubs.push(pollSessionStewardStatus())
}

export async function readStewardFinished(since = 0): Promise<StewardResultCard[]> {
  try {
    const result = await callRuntimeRpc<SessionStewardFinishedResult>(
      { kind: 'local' },
      SESSION_STEWARD_STATUS_RPC.finished,
      { since }
    )
    return Array.isArray(result?.cards) ? result.cards : []
  } catch {
    return []
  }
}

/** When the person last marked Finished sessions as seen (epoch ms); 0 when never. */
export function readStewardFinishedSeenAt(
  storage: Pick<Storage, 'getItem'> = localStorage
): number {
  const raw = Number(storage.getItem(personalViewStorageKey(STEWARD_FINISHED_SEEN_STORAGE_KEY)))
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

export function markStewardFinishedSeen(
  at: number,
  storage: Pick<Storage, 'setItem'> = localStorage
): void {
  try {
    storage.setItem(personalViewStorageKey(STEWARD_FINISHED_SEEN_STORAGE_KEY), String(at))
  } catch {
    // Why ignore: a full store only means the same cards read as new again.
  }
}
