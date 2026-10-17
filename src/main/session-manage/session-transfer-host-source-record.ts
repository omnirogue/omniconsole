/**
 * What a transfer records about each source that runs under a session host: every request exactly
 * as sent (a continuation resends these and nothing else), its brief and checkpoint, and its
 * receipt. Also the canonical order sources are reserved in.
 */

import type { SessionHostOrigin } from '../../shared/session-host-authority'
import type { SessionHostRequest } from '../../shared/session-host-protocol'
import type { SessionTransferHostSourceReceipt } from '../../shared/session-transfer-types'
import type { SessionTransferMode, TransferSession } from './session-manage-transfer-contract'
import type {
  HostStepOptions,
  HostStepOutcome,
  SessionTransferHostPort
} from './session-transfer-host-port'
import type { SessionTransferRecordStore } from './session-transfer-record-files'

export type HostTransferSource = {
  port: SessionTransferHostPort
  conversationId: string
  title: string
  /** Set when it runs on this computer: its pane as this computer shows it (never evidence). */
  local?: TransferSession
}

export type TargetReceipt = { hostId: string; conversationId: string; operationId: string }

export type HostSourceEntry = {
  hostId: string
  label: string
  conversationId: string
  title: string
  reserve?: SessionHostRequest
  /** True once admitted; false once its host definitely refused; unset while unknown. */
  reserved?: boolean
  prepare?: SessionHostRequest
  brief?: string
  checkpoint?: string
  settle?: SessionHostRequest
  /** An abandon sent after an accepted settle was refused (the source moved on since its brief). */
  release?: SessionHostRequest
  receipt?: SessionTransferHostSourceReceipt
}

export type SessionTransferHostRecord = {
  v: 1
  transfer: string
  mode: SessionTransferMode
  target: { hostId: string; conversationId?: string }
  decided?: 'accepted' | 'abandoned'
  targetReceipt?: TargetReceipt
  sources: HostSourceEntry[]
  updatedAt: number
}

export type HostTransferDeps = {
  records: SessionTransferRecordStore<SessionTransferHostRecord>
  mintOperationId(): string
  now(): number
  step: HostStepOptions
  origin: SessionHostOrigin
}

export const UNANSWERED = new Set(['unreachable', 'running'])

export function refusalOf(outcome: HostStepOutcome): string {
  if (outcome.kind === 'recorded' || outcome.kind === 'running') {
    const result = outcome.operation.result as { failure?: unknown } | undefined
    return (
      outcome.operation.refusal?.message ??
      (typeof result?.failure === 'string' ? result.failure : `it ended ${outcome.operation.state}`)
    )
  }
  return outcome.refusal.message
}

/** Canonical order: by host, then conversation, so two transfers contend in the same order. */
export function canonicalHostOrder(
  a: { hostId: string; conversationId: string },
  b: typeof a
): number {
  return a.hostId === b.hostId
    ? a.conversationId.localeCompare(b.conversationId)
    : a.hostId.localeCompare(b.hostId)
}
