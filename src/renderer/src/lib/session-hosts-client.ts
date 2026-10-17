/**
 * The window's reading of the other computers that run its sessions: one shared poll of
 * `sessionHosts.status` for the Work card and Settings. Main answers at once and reads stale hosts
 * in the background, so a reading that says `refreshing` is asked again shortly, once.
 */

import { useSyncExternalStore } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  SESSION_HOSTS_RPC,
  type SessionHostsStatusResult
} from '../../../shared/session-hosts-status'

export const SESSION_HOSTS_POLL_MS = 60_000
const AFTER_REFRESH_MS = 8_000

let snapshot: SessionHostsStatusResult | null = null
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
let followUp: ReturnType<typeof setTimeout> | null = null
let pollers = 0

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function isHostsStatus(value: unknown): value is SessionHostsStatusResult {
  const status = value as Partial<SessionHostsStatusResult> | null
  return Boolean(status && Array.isArray(status.hosts) && Array.isArray(status.switches))
}

/** Reads the hosts now; an older main without the method leaves no reading. */
export function refreshSessionHostsStatus(): Promise<void> {
  // Why deferred: a synchronous throw (no runtime bridge yet) must land in the catch below.
  return Promise.resolve()
    .then(() =>
      callRuntimeRpc<SessionHostsStatusResult>({ kind: 'local' }, SESSION_HOSTS_RPC.status, {})
    )
    .then((status) => {
      snapshot = isHostsStatus(status) ? status : null
      emit()
      if (snapshot?.refreshing && pollers > 0 && !followUp) {
        followUp = setTimeout(() => {
          followUp = null
          void refreshSessionHostsStatus()
        }, AFTER_REFRESH_MS)
      }
    })
    .catch(() => {})
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  pollers += 1
  if (pollers === 1) {
    void refreshSessionHostsStatus()
    timer = setInterval(() => void refreshSessionHostsStatus(), SESSION_HOSTS_POLL_MS)
  }
  return () => {
    listeners.delete(listener)
    pollers -= 1
    if (pollers === 0) {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      if (followUp) {
        clearTimeout(followUp)
        followUp = null
      }
    }
  }
}

function listenOnly(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The last reading without starting a poll (a menu must not start background reads). */
export function useSessionHostsSnapshot(): SessionHostsStatusResult | null {
  return useSyncExternalStore(listenOnly, () => snapshot)
}

/** Holding it keeps the poll running; null until main answers (or on an older main). */
export function useSessionHostsStatus(): SessionHostsStatusResult | null {
  return useSyncExternalStore(subscribe, () => snapshot)
}
