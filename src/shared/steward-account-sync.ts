/**
 * One pass of steward (`t`) account sync (docs/reference/session-host-control.md): this
 * computer's outbox goes into its own `t` documents only (never another computer's, never a
 * folder or session document), and every other computer's `t` entries plus the account's synced
 * folder stamps come back as revocations. A document a newer version wrote is never merged or
 * overwritten; entries of kinds this build does not know ride along untouched. Main binds it to
 * omnios; tests run it beside released clients.
 */

import { collectRemote, type Stamped } from './account-sync-session-docs'
import {
  accountSyncValueSize,
  ACCOUNT_SYNC_VALUE_MAX_BYTES,
  type AccountSyncReadResult,
  type AccountSyncWriteArgs,
  type AccountSyncWriteResult
} from './account-sync-types'
import { canonicalJson } from './decision-contracts/decision-calibration-summary'
import {
  boundSessionHostSyncHistory,
  layoutSessionHostSyncDocs,
  mergeSessionHostSyncDocs,
  parseSessionHostSyncDoc,
  parseSessionHostSyncDocKey,
  SESSION_HOST_SYNC_MAX_DOCS,
  sessionHostSyncDocKey,
  sessionHostSyncDocValue,
  type SessionHostSyncDoc,
  type SessionHostSyncEntry
} from './session-host-sync-doc'
import type { HostSyncIngest } from './session-organization-host-sync'

/** This computer's steward-sync identity for one account: its device id and document count. */
export type StewardSyncState = { device: string; docs: number }

/** Queued entries by id; `seq` tells a later update of the same id from the one that was read. */
export type StewardSyncOutbox = {
  pending: () => { id: string; seq: number; entry: unknown }[]
  ack: (delivered: readonly { id: string; seq: number }[]) => void
}

export type StewardSyncDeps = {
  read: () => Promise<AccountSyncReadResult>
  write: (args: AccountSyncWriteArgs) => Promise<AccountSyncWriteResult>
  outbox: StewardSyncOutbox
  state: {
    load: (user: string) => StewardSyncState | null
    save: (user: string, state: StewardSyncState) => void
  }
  newDevice: () => string
  /** Other computers' entries and folder stamps, for revocations. */
  ingest: (input: HostSyncIngest) => Promise<unknown>
}

export type StewardSyncPass =
  | { status: 'unavailable'; message: string }
  /** This computer's own `t` documents were written by a newer version: nothing published. */
  | { status: 'held-by-newer'; received: number }
  | { status: 'synced'; published: number; written: number; received: number; tooLarge: boolean }

const EMPTY = (): SessionHostSyncDoc => ({ entries: {}, opaque: {} })

function nextPowerOfTwo(value: number): number {
  let count = 1
  while (count < value && count < SESSION_HOST_SYNC_MAX_DOCS) {
    count *= 2
  }
  return count
}

function entriesOf(doc: SessionHostSyncDoc): SessionHostSyncEntry[] {
  return Object.values(doc.entries)
}

/** The account's winning folder per session digest, across every computer's session documents. */
function placementsOf(prefs: Record<string, unknown>): Map<string, Stamped<string | null>> {
  const { all } = collectRemote(prefs, '')
  const placements = new Map<string, Stamped<string | null>>()
  for (const [digest, session] of Object.entries(all.sessions)) {
    if (session.f) {
      placements.set(digest, session.f)
    }
  }
  return placements
}

export function createStewardSync(deps: StewardSyncDeps) {
  let chain: Promise<unknown> = Promise.resolve()

  async function pass(): Promise<StewardSyncPass> {
    const remote = await deps.read()
    if (!remote.ok) {
      return { status: 'unavailable', message: remote.message }
    }
    const state = deps.state.load(remote.user) ?? { device: deps.newDevice(), docs: 1 }
    const own = new Map<number, unknown>()
    let newer = false
    let theirs = EMPTY()
    for (const [key, value] of Object.entries(remote.prefs)) {
      const parsed = parseSessionHostSyncDocKey(key)
      if (!parsed) {
        continue
      }
      const read = parseSessionHostSyncDoc(value)
      if (parsed.device === state.device) {
        own.set(parsed.index, value)
        newer ||= read.status === 'newer'
      } else if (read.status === 'read') {
        theirs = mergeSessionHostSyncDocs(theirs, read.doc)
      }
    }
    const received = Object.keys(theirs.entries).length
    await deps.ingest({ entries: entriesOf(theirs), placements: placementsOf(remote.prefs) })
    if (newer) {
      deps.state.save(remote.user, state)
      return { status: 'held-by-newer', received }
    }
    let mine = EMPTY()
    for (const value of own.values()) {
      const read = parseSessionHostSyncDoc(value)
      if (read.status === 'read') {
        mine = mergeSessionHostSyncDocs(mine, read.doc)
      }
    }
    const pending = deps.outbox.pending()
    for (const item of pending) {
      const read = parseSessionHostSyncDoc({ v: 1, e: { [item.id]: item.entry } })
      if (read.status === 'read') {
        mine = mergeSessionHostSyncDocs(mine, read.doc)
      }
    }
    // Why never fewer documents: a smaller count would leave stale entries in the higher ones.
    const from = Math.max(state.docs, nextPowerOfTwo(Math.max(0, ...own.keys()) + 1))
    const docs = layoutSessionHostSyncDocs(boundSessionHostSyncHistory(mine), from)
    let written = 0
    let landed = true
    let tooLarge = false
    for (const [index, doc] of docs.entries()) {
      const value = sessionHostSyncDocValue(doc)
      const stored = own.get(index)
      if (stored !== undefined && canonicalJson(stored) === canonicalJson(value)) {
        continue
      }
      if (accountSyncValueSize(value) > ACCOUNT_SYNC_VALUE_MAX_BYTES) {
        tooLarge = true
        landed = false
        continue
      }
      const key = sessionHostSyncDocKey(state.device, index)
      const result = await deps.write({ key, value, expectedUser: remote.user })
      if (!result.ok) {
        landed = false
        if (result.accountChanged) {
          break
        }
        continue
      }
      written += 1
    }
    deps.state.save(remote.user, { device: state.device, docs: docs.length })
    if (landed) {
      deps.outbox.ack(pending)
    }
    return {
      status: 'synced',
      published: landed ? pending.length : 0,
      written,
      received,
      tooLarge
    }
  }

  return {
    /** One pass after any running one; a failure waits for the next pass. */
    run(): Promise<StewardSyncPass> {
      const next = chain.then(pass)
      chain = next.catch(() => {})
      return next
    }
  }
}
