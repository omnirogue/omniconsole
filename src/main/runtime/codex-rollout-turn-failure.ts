// Why the rollout: a Codex turn that dies on a usage wall fires no Stop hook (codex-rs breaks the
// turn loop before stop hooks run) and its Error event is never persisted. The one durable trace is
// the turn's own `task_complete`, which carries the terminal `error` the TUI showed.
import { isProviderUsageLimitText } from '../../shared/provider-usage-limit-text'
import { createProviderTranscriptTailReader } from './provider-transcript-tail'

export type CodexRolloutTurnFailure = {
  failedAt: number
  reason: string
  /** Codex itself classified the error as an exhausted plan, not a transient 429. */
  usageLimit: boolean
}

/** The failed turn's `task_complete` is the last record Codex writes for it. */

type RolloutRecord = {
  timestamp?: unknown
  type?: unknown
  payload?: {
    type?: unknown
    role?: unknown
    error?: { message?: unknown; codex_error_info?: unknown } | null
  }
}

/**
 * The failure that ended the rollout's latest turn, when nothing has started since. Null for a
 * successful, aborted or still-running turn, an unreadable file, or a rollout from a Codex build
 * that does not record turn errors.
 */
export function parseCodexRolloutTurnFailure(content: string): CodexRolloutTurnFailure | null {
  // An unfinished final record may be the next turn starting.
  if (!content.endsWith('\n')) {
    return null
  }
  const lines = content.split('\n')
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim()
    if (!line) {
      continue
    }
    let record: RolloutRecord
    try {
      record = JSON.parse(line) as RolloutRecord
    } catch {
      // A tail read can start mid-line; nothing before it is this turn's boundary.
      return null
    }
    const payload = record.payload
    if (record.type === 'response_item' && payload?.type === 'message' && payload.role === 'user') {
      return null
    }
    if (record.type !== 'event_msg') {
      continue
    }
    if (payload?.type === 'task_started' || payload?.type === 'turn_aborted') {
      return null
    }
    if (payload?.type !== 'task_complete') {
      continue
    }
    const message = typeof payload.error?.message === 'string' ? payload.error.message.trim() : ''
    const failedAt =
      typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    if (!message || !Number.isFinite(failedAt)) {
      return null
    }
    const info = payload.error?.codex_error_info
    return {
      failedAt,
      reason: message.replace(/\s+/g, ' ').slice(0, 1_000),
      usageLimit:
        info === 'usage_limit_exceeded' || (info == null && isProviderUsageLimitText(message))
    }
  }
  return null
}

/** Synchronous and cached by size/mtime: the host tick re-reads every Codex pane each pass. */
export const readCodexRolloutTurnFailure = createProviderTranscriptTailReader(
  parseCodexRolloutTurnFailure
)
