// A receiver's captures of a paired owner's conversations, as the owner's conversation ledger
// speaks for them (session parity, step 7). A capture is this computer's hibernation record of a
// conversation another computer runs: the record of a mirror pane (`web-terminal-…`), or one the
// activation sweep re-keyed onto a client-minted tab (a plain UUID, C4). It matches the ledger by
// the digest of its full local claim key, by its provider session, or by the owner pane it names
// (F14, F15, F21); one matching several records is ambiguous and is kept, never acted on.

import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { getProviderSessionClaimKey } from '../../../shared/provider-session-claim-key'
import {
  sessionConversationIdentityFromClaimKey,
  sessionConversationPaneIdentity,
  sessionConversationRemovalKey,
  type RuntimeSessionConversationRecord,
  type RuntimeSessionConversationRemoval
} from '../../../shared/session-conversation-ledger'
import { isTerminalLeafId, parsePaneKey } from '../../../shared/stable-pane-id'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  isWebTerminalSurfaceTabId,
  parseWebTerminalSurfaceTabId
} from '../../../shared/terminal-surface-id'
import { isStructuredAgentSyntheticSleepingRecord } from '@/lib/structured-agent-synthetic-sleeping-record'

function captureTabId(record: SleepingAgentSessionRecord): string | null {
  return record.tabId ?? parsePaneKey(record.paneKey)?.tabId ?? null
}

/** F21: the digest of the capture's full local claim key, as the owner computes its own. */
export function captureConversationIdentity(record: SleepingAgentSessionRecord): string {
  return sessionConversationIdentityFromClaimKey(getProviderSessionClaimKey(record))
}

/**
 * The owner pane a mirror-pane capture names, as the owner's `paneIdentity` (`pane:<tab>:<leaf>`);
 * null for a client-minted id, which never named an owner pane.
 */
export function captureOwnerPaneIdentity(record: SleepingAgentSessionRecord): string | null {
  const tabId = captureTabId(record)
  const surface = tabId ? parseWebTerminalSurfaceTabId(tabId) : null
  if (!surface) {
    return null
  }
  // Why both shapes: a legacy per-surface mirror id carries the owner's `tab::leaf` itself.
  const separator = surface.hostTabId.indexOf(HOST_TERMINAL_SURFACE_SEPARATOR)
  const [ownerTabId, leafId] =
    separator === -1
      ? [surface.hostTabId, parsePaneKey(record.paneKey)?.leafId]
      : [
          surface.hostTabId.slice(0, separator),
          surface.hostTabId.slice(separator + HOST_TERMINAL_SURFACE_SEPARATOR.length)
        ]
  return ownerTabId && !ownerTabId.includes(':') && leafId && isTerminalLeafId(leafId)
    ? sessionConversationPaneIdentity(`${ownerTabId}:${leafId}`)
    : null
}

/**
 * Whether `record` is this computer's capture of a conversation `environmentId` runs: no SSH
 * connection, and owner evidence — a mirror id naming that owner (or, unqualified, a workspace the
 * saved catalog credits to it alone), or a client-minted id in a workspace credited to it alone.
 */
export function isConversationCaptureOf(
  record: SleepingAgentSessionRecord,
  environmentId: string,
  catalogOwnerEnvironmentId: string | null
): boolean {
  const tabId = captureTabId(record)
  if (!tabId || record.connectionId || isStructuredAgentSyntheticSleepingRecord(record)) {
    return false
  }
  const owner = isWebTerminalSurfaceTabId(tabId)
    ? (parseWebTerminalSurfaceTabId(tabId)?.environmentId ?? catalogOwnerEnvironmentId)
    : catalogOwnerEnvironmentId
  return owner === environmentId
}

/**
 * The owner's records that speak for a capture: same digest, same provider session (an ambiguous
 * Pi/Prime capture matches several and stays), or a provider-less record of the owner pane it
 * names (that pane may still run it: unknown keeps). `listed: false` records count: the owner
 * holds that conversation without listing it (G1).
 */
export function ledgerRecordsVouchingForCapture(
  records: readonly RuntimeSessionConversationRecord[],
  capture: SleepingAgentSessionRecord
): RuntimeSessionConversationRecord[] {
  const digest = captureConversationIdentity(capture)
  const pane = captureOwnerPaneIdentity(capture)
  const { key, id } = capture.providerSession
  return records.filter(
    (record) =>
      record.conversation === digest ||
      (record.providerSession?.key === key && record.providerSession.id === id) ||
      // Why provider-less only: that pane naming another session says this one is not there.
      (pane !== null &&
        record.paneIdentity === pane &&
        !record.conversation &&
        !record.providerSession)
  )
}

/**
 * Whether the capture's digest cannot be the owner's: a Pi or Prime Agent conversation's claim
 * key carries its transcript path, and a capture recorded without one digests differently from
 * every owner record of that session.
 */
export function captureDigestInexact(capture: SleepingAgentSessionRecord): boolean {
  return (
    (capture.agent === 'pi' || capture.agent === 'prime-agent') &&
    !capture.providerSession.transcriptPath
  )
}

/**
 * The owner's records that SPEAK for a capture (step 7, F1/F14): its exact digest, or the
 * provider-less record of the owner pane it names (that pane may still run it). A record matching
 * by provider session only — another Pi/Prime transcript of the same session — speaks for it only
 * when the capture's own digest cannot be exact, or when more than one such record matches
 * (ambiguous: kept, never merged); otherwise the owner's exact word on this digest — a tombstone,
 * or its absence from a complete list — decides, and the sibling says nothing.
 */
export function ledgerRecordsSpeakingForCapture(
  records: readonly RuntimeSessionConversationRecord[],
  capture: SleepingAgentSessionRecord
): RuntimeSessionConversationRecord[] {
  const digest = captureConversationIdentity(capture)
  const vouchers = ledgerRecordsVouchingForCapture(records, capture)
  const exact = vouchers.filter(
    (record) => record.conversation === digest || (!record.conversation && !record.providerSession)
  )
  const siblings = vouchers.filter((record) => !exact.includes(record))
  return captureDigestInexact(capture) || siblings.length > 1 ? vouchers : exact
}

/** The removal keys (`sessionConversationRemovalKey`) a capture answers to: digest and pane. */
export function captureRemovalKeys(capture: SleepingAgentSessionRecord): string[] {
  const { worktreeId } = capture
  const pane = captureOwnerPaneIdentity(capture)
  return [
    sessionConversationRemovalKey({
      conversation: captureConversationIdentity(capture),
      worktreeId
    }),
    ...(pane ? [sessionConversationRemovalKey({ paneIdentity: pane, worktreeId })] : [])
  ]
}

/** The removal keys of an owner's tombstones in one workspace. */
export function workspaceRemovalKeys(
  removals: readonly RuntimeSessionConversationRemoval[],
  worktreeId: string
): Set<string> {
  return new Set(
    removals
      .filter((removal) => removal.worktreeId === worktreeId)
      .map(sessionConversationRemovalKey)
      .filter(Boolean)
  )
}
