/**
 * The owner's deletion tombstones for its conversation ledger (session parity, step 3; addendum
 * F4, F15, F21, F24). Each conversation the person deleted here — the durable `deleted` host
 * organization value, which an Undo clears — becomes one removal naming exactly one identity in its
 * workspace: the full-claim digest for a provider key, `pane:<paneKey>` for a provider-less pane
 * key, or the anchor tab of a workflow (whose row key is `[hostId, worktreeId, anchorTabId]`). The
 * store carries them on every set, window- or main-authored, so a peer that missed the delete still
 * removes the row. Only this owner's own `local` keys count: a mark on another computer's row is
 * this window's view of it, never that owner's deletion. The last 90 days are kept, newest first,
 * cut at the contract cap with `truncated` set; older deletions go along as `aged`, which the
 * store shows only once one held back by a listed record shows again (retention from then).
 */

import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import {
  SESSION_CONVERSATION_LEDGER_LIMITS,
  sessionConversationIdentityFromProviderKey,
  sessionConversationPaneIdentity,
  type RuntimeSessionConversationRemoval
} from '../../shared/session-conversation-ledger'
import type { SessionConversationLedgerStore } from '../runtime/session-conversation-ledger-store'
import { CONVERSATION_REMOVAL_RETENTION_MS } from '../runtime/session-conversation-ledger-store-removals'
import type { HostOrganizationValuesReader } from '../session-organization/host-organization-instance'

export { CONVERSATION_REMOVAL_RETENTION_MS }

/** Second elements that name a key's kind, not a workspace (session-folder-identity.ts). */
const KEY_KINDS: ReadonlySet<string> = new Set(['provider', 'pane', 'structured', 'routine'])

type RemovalIdentity = Omit<RuntimeSessionConversationRemoval, 'at'>

/** The one identity a sidebar key of this owner's names, or null (another host's, or no identity). */
export function conversationRemovalIdentity(key: string): RemovalIdentity | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(key)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed[0] !== LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const [, kind, first, second] = parsed as unknown[]
  if (kind === 'provider') {
    return sessionConversationIdentityFromProviderKey(key)
  }
  if (kind === 'pane') {
    return parsed.length === 4 && typeof first === 'string' && typeof second === 'string'
      ? { worktreeId: first, paneIdentity: sessionConversationPaneIdentity(second) }
      : null
  }
  // Why: a workflow row has no session key; its archive and delete key is its row key.
  return parsed.length === 3 &&
    typeof kind === 'string' &&
    !KEY_KINDS.has(kind) &&
    typeof first === 'string' &&
    kind.length > 0 &&
    first.length > 0
    ? { worktreeId: kind, workflowTabId: first }
    : null
}

/**
 * Every retained tombstone, newest first, and whether the cap cut any; `aged`: the deletions past
 * retention by their stamp, which the store keeps only while a listed record holds one back or
 * within retention of its showing again (session-conversation-ledger-store-removals.ts).
 */
export function conversationLedgerRemovals(
  values: Pick<HostOrganizationValuesReader, 'keys' | 'entry'>,
  nowMs: number
): {
  removals: RuntimeSessionConversationRemoval[]
  truncated: boolean
  aged: RuntimeSessionConversationRemoval[]
} {
  const removals: RuntimeSessionConversationRemoval[] = []
  const aged: RuntimeSessionConversationRemoval[] = []
  for (const key of values.keys()) {
    const entry = values.entry(key)
    const at = entry?.values.deleted === true ? Date.parse(entry.stamps?.deleted ?? '') : Number.NaN
    // Why a stamp is required: a tombstone acts without coverage, so it is exact or not sent.
    const identity = Number.isFinite(at) ? conversationRemovalIdentity(key) : null
    if (identity) {
      ;(at >= nowMs - CONVERSATION_REMOVAL_RETENTION_MS ? removals : aged).push({ ...identity, at })
    }
  }
  removals.sort((a, b) => b.at - a.at)
  const max = SESSION_CONVERSATION_LEDGER_LIMITS.removals
  return { removals: removals.slice(0, max), truncated: removals.length > max, aged }
}

/**
 * Keeps the store's tombstones in step with the host values: now, and after every change to them
 * (an applied delete or undo, the window's seeded marks, a pane key moving to its provider key),
 * coalesced to one read per tick. Window and main modes both get them from here.
 */
export function publishConversationLedgerRemovals(
  store: Pick<SessionConversationLedgerStore, 'setRemovals'>,
  values: HostOrganizationValuesReader,
  now: () => number = Date.now
): () => void {
  let stopped = false
  let queued = false
  const publish = (): void => {
    queued = false
    if (stopped) {
      return
    }
    // Why caught: it runs in app startup and in a microtask; a damaged value keeps the last list.
    try {
      const { removals, truncated, aged } = conversationLedgerRemovals(values, now())
      store.setRemovals(removals, truncated, aged)
    } catch (error) {
      console.warn('[session-host] reading the conversation ledger tombstones failed', error)
    }
  }
  publish()
  const stopHearing = values.onChange(() => {
    if (!queued) {
      queued = true
      queueMicrotask(publish)
    }
  })
  return () => {
    stopped = true
    stopHearing()
  }
}
