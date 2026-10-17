import {
  IDLE_AUTO_CLOSE_RPC,
  type HibernationAudit,
  type HibernationAuditAction,
  type HibernationEvidence
} from '../../../../shared/idle-auto-close-settings'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'

/** One `session-actions.jsonl` line, written by main as actor `hibernation`. */
export type HibernationLine = {
  action: HibernationAuditAction
  target: { paneKey?: string | null; tabId?: string | null; title?: string }
  summary: string
  audit: HibernationAudit
}

type HibernationLineSink = (records: HibernationLine[]) => Promise<unknown>

const defaultSink: HibernationLineSink = (records) =>
  callRuntimeRpc({ kind: 'local' }, IDLE_AUTO_CLOSE_RPC.record, { records })

let sink: HibernationLineSink = defaultSink
const recordedKeys = new Set<string>()
/** Bounds the de-duplication memory; a cleared key at worst writes one repeated shadow line. */
const MAX_RECORDED_KEYS = 5_000

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

function clipEvidence(evidence: HibernationEvidence): HibernationEvidence {
  const clipped: HibernationEvidence = {}
  for (const [key, value] of Object.entries(evidence).slice(0, 40)) {
    clipped[clip(key, 64)] = typeof value === 'string' ? clip(value, 512) : value
  }
  return clipped
}

function clipLine(line: HibernationLine): HibernationLine {
  return {
    action: line.action,
    target: {
      ...(line.target.paneKey !== undefined
        ? { paneKey: line.target.paneKey && clip(line.target.paneKey, 512) }
        : {}),
      ...(line.target.tabId !== undefined
        ? { tabId: line.target.tabId && clip(line.target.tabId, 512) }
        : {}),
      ...(line.target.title ? { title: clip(line.target.title, 200) } : {})
    },
    summary: clip(line.summary, 500),
    audit: { ...line.audit, evidence: clipEvidence(line.audit.evidence) }
  }
}

/**
 * Writes one decision line. With a `dedupeKey` (rule | target | facts | outcome) the same decision
 * is written once however many ticks repeat it, so a shadow run logs each would-do once.
 * Never throws: a lost audit line must not stop the rules, and main logs its own write errors.
 */
export function recordHibernationLine(
  line: HibernationLine,
  dedupeKey: string | null = null
): void {
  if (dedupeKey !== null) {
    if (recordedKeys.has(dedupeKey)) {
      return
    }
    if (recordedKeys.size >= MAX_RECORDED_KEYS) {
      recordedKeys.clear()
    }
    recordedKeys.add(dedupeKey)
  }
  let pending: Promise<unknown>
  try {
    pending = sink([clipLine(line)])
  } catch (error) {
    pending = Promise.reject(error)
  }
  void pending.catch((error: unknown) => {
    console.warn('[hibernation] could not write the session action line:', error)
  })
}

export function setHibernationLineSinkForTests(next: HibernationLineSink | null): void {
  sink = next ?? defaultSink
  recordedKeys.clear()
}
