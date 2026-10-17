import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  isNativePeerInboxReceipt,
  type NativePeerInboxReceipt
} from '../../shared/native-peer-inbox-binding'

export type NativePeerInboxReplacement = {
  sessionId: string
  fence: number
  expected: NativePeerInboxReceipt | undefined
  next: NativePeerInboxReceipt
  now: number
}

export function replaceNativePeerInboxRecord(
  record: AgentSessionRecord,
  replacement: NativePeerInboxReplacement
): AgentSessionRecord {
  if (
    record.sessionId !== replacement.sessionId ||
    record.lease.runtimeFence !== replacement.fence ||
    record.lease.claimStatus !== 'live' ||
    record.lease.unreconciled ||
    record.lease.runtimeKind !== 'tui' ||
    record.lease.handoffStage !== null
  ) {
    throw new Error('peer_inbox_ownership_unverifiable')
  }
  if (JSON.stringify(record.peerInbox) !== JSON.stringify(replacement.expected)) {
    throw new Error('peer_inbox_binding_changed')
  }
  if (
    !isNativePeerInboxReceipt(replacement.next) ||
    replacement.next.binding.nativeSessionId !== record.sessionId ||
    replacement.next.binding.runtimeFence !== record.lease.runtimeFence
  ) {
    throw new Error('peer_inbox_binding_invalid')
  }
  const current = record.peerInbox
  if (
    current?.attempt &&
    !['completed', 'not-written'].includes(current.attempt.outcome) &&
    (JSON.stringify(replacement.next.binding) !== JSON.stringify(current.binding) ||
      replacement.next.attempt?.nonce !== current.attempt.nonce)
  ) {
    throw new Error('peer_inbox_submission_unresolved')
  }
  return { ...record, peerInbox: structuredClone(replacement.next), updatedAt: replacement.now }
}
