// Renderer half of the session frame log (session-count fix, step 0). Records are queued and sent
// to main in batches on a timer, so a frame decision never waits on IPC or disk; with the log off,
// `isSessionFrameLogEnabled()` is the only cost a call site pays.

import { useEffect } from 'react'
import type { SessionFrameLogRecord } from '../../../shared/session-frame-log'

const FLUSH_DELAY_MS = 500
const FLUSH_AT_RECORDS = 200
/** Why a cap: a stalled main must not grow the renderer heap without bound. */
const MAX_QUEUED_RECORDS = 2000

let enabled = false
let queue: SessionFrameLogRecord[] = []
let droppedSinceFlush = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<(enabled: boolean) => void>()

export function isSessionFrameLogEnabled(): boolean {
  return enabled
}

function flushSessionFrameLog(): void {
  flushTimer = null
  if (queue.length === 0 && droppedSinceFlush === 0) {
    return
  }
  const batch = queue
  queue = []
  if (droppedSinceFlush > 0) {
    batch.push({ kind: 'renderer.dropped', count: droppedSinceFlush, t: Date.now() })
    droppedSinceFlush = 0
  }
  try {
    window.api?.sessionFrameLog?.append(batch)
  } catch {
    /* a debug log must never break the frame path */
  }
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer !== null) {
    if (delayMs > 0) {
      return
    }
    clearTimeout(flushTimer)
  }
  flushTimer = setTimeout(flushSessionFrameLog, delayMs)
}

export function recordSessionFrameLog(record: SessionFrameLogRecord): void {
  if (!enabled) {
    return
  }
  if (queue.length >= MAX_QUEUED_RECORDS) {
    droppedSinceFlush += 1
    return
  }
  queue.push({ ...record, t: Date.now() })
  scheduleFlush(queue.length >= FLUSH_AT_RECORDS ? 0 : FLUSH_DELAY_MS)
}

export function setSessionFrameLogEnabled(next: boolean): void {
  if (next === enabled) {
    return
  }
  enabled = next
  if (!next) {
    queue = []
    droppedSinceFlush = 0
    if (flushTimer !== null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }
  for (const listener of listeners) {
    listener(next)
  }
}

export function onSessionFrameLogEnabledChanged(listener: (enabled: boolean) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Reads the flag once, then follows main's flips; the web client has no frame log and stays off. */
export function useSessionFrameLogBridge(): void {
  useEffect(() => {
    const api = window.api?.sessionFrameLog
    if (!api) {
      return
    }
    let disposed = false
    const unsubscribe = api.onStateChanged((state) => setSessionFrameLogEnabled(state.enabled))
    void api
      .getState()
      .then((state) => {
        if (!disposed) {
          setSessionFrameLogEnabled(state.enabled)
        }
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [])
}

export function _flushSessionFrameLogForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
  }
  flushSessionFrameLog()
}

export function _resetSessionFrameLogForTests(): void {
  enabled = false
  queue = []
  droppedSinceFlush = 0
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  listeners.clear()
}
