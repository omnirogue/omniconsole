import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import {
  sessionConversationIdentity,
  type RuntimeSessionConversationLedger,
  type RuntimeSessionConversationLedgerDelta,
  type RuntimeSessionConversationRecord,
  type RuntimeSessionConversationRemoval
} from '../../shared/session-conversation-ledger'
import type { OrganizationChange } from '../../shared/session-organization-change'
import type { RpcContext } from '../runtime/rpc/core'
import { withSessionConversationLedgerStream } from '../runtime/rpc/methods/session-conversation-ledger'
import { SessionConversationLedgerStore } from '../runtime/session-conversation-ledger-store'
import {
  HOST_PERSON,
  hostTestClock,
  openTestHost,
  type OpenedHost
} from '../session-organization/host-organization-test-host'
import { publishConversationLedgerRemovals } from './conversation-ledger-removals'
import {
  inventorySource,
  LEAF_A,
  LEAF_B,
  LEAF_C,
  leafLayout,
  providerKey,
  sleepingRecord,
  terminalTab,
  workspaceSession,
  WORKTREE
} from './main-conversation-inventory-test-fixture'
import { mainConversationLedger, publishMainConversationLedger } from './main-conversation-ledger'
import { mainConversationInventory } from './main-conversation-inventory'
import { OwnerInventorySignal } from './owner-inventory-signal'

// One owner snapshot never lists and tombstones the same conversation (session parity,
// integration of steps 1c–4): the durable deletes (host organization), step 3's tombstone provider
// and main-authored ledger, the store, and step 4's negotiated stream, on one fixture — a deleted
// tab-less record, a deleted conversation whose tab is open again, and a kept record.

const digest = (id: string) =>
  sessionConversationIdentity({
    worktreeId: WORKTREE,
    agent: 'claude',
    providerSession: { key: 'session_id', id }
  })
const RECORD_PANE = `tab-gone:${LEAF_A}`
const REOPENED_PANE = `tab-5:${LEAF_B}`
const KEPT_PANE = `tab-kept:${LEAF_C}`

let dir: string
let opened: OpenedHost
const stops: (() => void)[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conversation-ledger-consistency-'))
  opened = openTestHost(dir, hostTestClock(Date.now()))
})

afterEach(async () => {
  stops.splice(0).forEach((stop) => stop())
  await opened.host.flush()
  rmSync(dir, { recursive: true, force: true })
})

async function windowDeletes(opId: string, key: string, deleted: boolean) {
  const change: OrganizationChange = {
    opId,
    kind: 'delete',
    targets: [{ sessionKey: key }],
    value: deleted,
    executor: HOST_PERSON
  }
  await opened.ledger.settle({ phase: 'applied', change, before: [!deleted], after: [deleted] })
}

/** The persisted LOCAL partition: tab-5 open again, its record and two tab-less records. */
function fixture() {
  return inventorySource(
    workspaceSession({
      tabsByWorktree: { [WORKTREE]: [terminalTab('tab-5')] },
      terminalLayoutsByTabId: { 'tab-5': leafLayout(LEAF_B) },
      sleepingAgentSessionsByPaneKey: {
        [RECORD_PANE]: sleepingRecord(RECORD_PANE, 's-4'),
        [REOPENED_PANE]: sleepingRecord(REOPENED_PANE, 's-5'),
        [KEPT_PANE]: sleepingRecord(KEPT_PANE, 's-6')
      }
    })
  )
}

/** Why written out, not the store's helper: it checks the store's rule independently. */
function names(
  record: RuntimeSessionConversationRecord,
  removal: RuntimeSessionConversationRemoval
): boolean {
  return Boolean(
    (removal.conversation && removal.conversation === record.conversation) ||
    (removal.paneIdentity && removal.paneIdentity === record.paneIdentity)
  )
}

/** The listed records a tombstone beside them also names, per workspace. */
function listedAndTombstoned(
  recordsByWorktree: Record<string, RuntimeSessionConversationRecord[]>,
  removals: readonly RuntimeSessionConversationRemoval[]
): string[] {
  return Object.entries(recordsByWorktree).flatMap(([worktreeId, records]) =>
    records
      .filter(
        (record) =>
          record.listed &&
          removals.some((removal) => removal.worktreeId === worktreeId && names(record, removal))
      )
      .map((record) => record.conversation ?? record.paneIdentity ?? '')
  )
}

const conversations = (removals: readonly RuntimeSessionConversationRemoval[] = []) =>
  removals.map((removal) => removal.conversation).sort()

/** A stream event: the `snapshots` inventory (with the set), a whole set, or a delta. */
type Emitted = { type: string; conversationLedger?: RuntimeSessionConversationLedger } & Partial<
  RuntimeSessionConversationLedger & RuntimeSessionConversationLedgerDelta
>

describe('one owner snapshot never lists and tombstones the same conversation', () => {
  it('holds the reopened conversation’s tombstone back, and step 4’s deltas carry each tombstone once it shows', async () => {
    await windowDeletes('del-record', providerKey('s-4'), true)
    await windowDeletes('del-reopened', providerKey('s-5'), true)
    const source = fixture()
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    const signal = new OwnerInventorySignal()
    // As startOwnerConversationLedger starts them: tombstones, then the windowless set.
    stops.push(publishConversationLedgerRemovals(store, opened.view))
    stops.push(
      publishMainConversationLedger({
        store,
        readInventory: () => source,
        values: opened.view,
        onInventoryChanged: (listener) => signal.subscribe(listener)
      })
    )
    const emitted: Emitted[] = []
    const emit = withSessionConversationLedgerStream(
      {
        runtime: {
          getSessionConversationLedgerStore: () => store
        } as unknown as RpcContext['runtime'],
        clientCapabilities: [SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY]
      },
      (result) => emitted.push(result as Emitted)
    )
    emit({ type: 'snapshots', snapshots: [] })

    const first = emitted[0]!.conversationLedger!
    expect(emitted[0]!.type).toBe('snapshots')
    expect(first.source).toBe('main')
    expect(first.recordsByWorktree[WORKTREE]?.map((record) => record.conversation).sort()).toEqual(
      [digest('s-5'), digest('s-6')].sort()
    )
    expect(conversations(first.removals)).toEqual([digest('s-4')])
    expect(listedAndTombstoned(first.recordsByWorktree, first.removals)).toEqual([])

    // A new delete: the provider hears it before the coalesced set drops the row, so the tombstone
    // shows with the row's removal, in one delta.
    await windowDeletes('del-kept', providerKey('s-6'), true)
    await vi.waitFor(() => expect(conversations(emitted.at(-1)?.removals)).toEqual([digest('s-6')]))
    const kept = emitted.at(-1)!
    expect(kept).toMatchObject({ type: 'conversationLedger', baseRevision: first.revision })
    expect(kept.changedByWorktree?.[WORKTREE]?.map((record) => record.conversation)).toEqual([
      digest('s-5')
    ])

    // The reopened tab closes: the conversation is tab-less and deleted, so its tombstone shows,
    // as new to the delta against the revision that held it back.
    source.session.tabsByWorktree = { [WORKTREE]: [] }
    signal.notify()
    await vi.waitFor(() => expect(conversations(emitted.at(-1)?.removals)).toEqual([digest('s-5')]))
    expect(emitted.at(-1)).toMatchObject({
      type: 'conversationLedger',
      changedByWorktree: { [WORKTREE]: [] }
    })
    expect(conversations(store.snapshot().removals)).toEqual(
      [digest('s-4'), digest('s-5'), digest('s-6')].sort()
    )

    // Opened once more: listed again, so the tombstone is withdrawn, which only a whole set can say.
    source.session.tabsByWorktree = { [WORKTREE]: [terminalTab('tab-5')] }
    signal.notify()
    await vi.waitFor(() =>
      expect(emitted.at(-1)?.recordsByWorktree?.[WORKTREE]?.[0]?.conversation).toBe(digest('s-5'))
    )
    const reopened = emitted.at(-1)!
    expect(reopened).not.toHaveProperty('baseRevision')
    expect(conversations(reopened.removals)).toEqual([digest('s-4'), digest('s-6')].sort())

    // No event this stream delivered listed and tombstoned one conversation.
    for (const event of emitted.slice(1)) {
      const records = event.changedByWorktree ?? event.recordsByWorktree ?? {}
      expect(listedAndTombstoned(records, event.removals ?? [])).toEqual([])
    }
  })

  it('holds it back from a window set listing the reopened conversation, and shows it once the window drops it', async () => {
    await windowDeletes('del-record', providerKey('s-4'), true)
    await windowDeletes('del-reopened', providerKey('s-5'), true)
    const source = fixture()
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: null })
    stops.push(publishConversationLedgerRemovals(store, opened.view))
    const windowSet = () => ({
      rendererGeneration: 'renderer-1',
      ...mainConversationLedger({
        inventory: mainConversationInventory(source),
        lastWindow: null,
        values: opened.view
      })
    })

    store.publishWindow(windowSet())
    const shown = store.snapshot()
    expect(shown.source).toBe('window')
    expect(conversations(shown.removals)).toEqual([digest('s-4')])
    expect(listedAndTombstoned(shown.recordsByWorktree, shown.removals)).toEqual([])

    source.session.tabsByWorktree = { [WORKTREE]: [] }
    store.publishWindow(windowSet())
    expect(conversations(store.removalsSince(shown.revision))).toEqual([digest('s-5')])
    expect(
      listedAndTombstoned(store.snapshot().recordsByWorktree, store.snapshot().removals)
    ).toEqual([])
  })
})
