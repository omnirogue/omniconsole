import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  SESSION_PREP_RPC,
  type SessionPrepBatchState,
  type SessionPrepBatchView,
  type SessionPrepListResult
} from '../../../../shared/session-prep-types'
import { getSessionPrepEpoch, subscribeSessionPrepEpoch } from './session-prep-composer-state'

const POLL_MS = 1500
const KEEP_FINISHED_MS = 15_000
const TERMINAL: ReadonlySet<SessionPrepBatchState> = new Set(['done', 'cancelled', 'failed'])

function shouldKeepPolling(
  batches: SessionPrepBatchView[],
  terminalAt: Map<string, number>,
  now: number,
  epoch: number,
  epochStartedAt: number
): boolean {
  if (epoch > 0 && now - epochStartedAt < KEEP_FINISHED_MS) {
    return true
  }
  return batches.some((batch) => {
    if (!TERMINAL.has(batch.state)) {
      return true
    }
    const seen = terminalAt.get(batch.id) ?? now
    return now - seen < KEEP_FINISHED_MS
  })
}

function rememberTerminal(
  batches: SessionPrepBatchView[],
  terminalAt: Map<string, number>,
  now: number
): void {
  for (const batch of batches) {
    if (TERMINAL.has(batch.state) && !terminalAt.has(batch.id)) {
      terminalAt.set(batch.id, now)
    }
  }
}

export function visibleSessionPrepBatches(
  batches: SessionPrepBatchView[],
  terminalAt: Map<string, number>,
  now: number
): SessionPrepBatchView[] {
  return batches
    .filter((batch) => {
      if (batch.state === 'cancelled') {
        return false
      }
      if (batch.state === 'done') {
        const seen = terminalAt.get(batch.id)
        return seen == null || now - seen < KEEP_FINISHED_MS
      }
      return true
    })
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 2)
}

export function useSessionPrepStatus(paneKey: string): SessionPrepBatchView[] {
  const epoch = useSyncExternalStore(
    subscribeSessionPrepEpoch,
    () => getSessionPrepEpoch(paneKey),
    () => 0
  )
  const [batches, setBatches] = useState<SessionPrepBatchView[]>([])
  const [now, setNow] = useState(() => Date.now())
  const terminalAt = useRef(new Map<string, number>())

  useEffect(() => {
    let cancelled = false
    let interval: ReturnType<typeof setInterval> | undefined
    const epochStartedAt = Date.now()
    const poll = async (): Promise<void> => {
      try {
        const next = await callRuntimeRpc<SessionPrepListResult>(
          { kind: 'local' },
          SESSION_PREP_RPC.listForSource,
          { paneKey }
        )
        if (cancelled) {
          return
        }
        const list = Array.isArray(next?.batches) ? next.batches : []
        const t = Date.now()
        rememberTerminal(list, terminalAt.current, t)
        setBatches(list)
        setNow(t)
        if (!shouldKeepPolling(list, terminalAt.current, t, epoch, epochStartedAt) && interval) {
          clearInterval(interval)
          interval = undefined
        }
      } catch {
        // Keep the last successful snapshot.
      }
    }
    void poll()
    interval = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      if (interval) {
        clearInterval(interval)
      }
    }
  }, [paneKey, epoch])

  return visibleSessionPrepBatches(batches, terminalAt.current, now)
}
