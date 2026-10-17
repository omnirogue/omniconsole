import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: startOwnerConversationLedger reads the profile's host values; tests hand it their own host.
const hostValues = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../session-organization/host-organization-instance', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sessionOrganizationValuesFor: () => hostValues.current
}))
import { SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY } from '../../shared/protocol-version'
import { toRemoteRuntimePtyId } from '../../shared/remote-runtime-pty-id'
import {
  sessionConversationIdentity,
  type SessionConversationLedgerWindowPublication
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
import type { OwnerConversationInventorySource } from './main-conversation-inventory'
import {
  publishMainConversationLedger,
  startOwnerConversationLedger
} from './main-conversation-ledger'
import { OwnerInventorySignal } from './owner-inventory-signal'

const FOLDER = '00000000-0000-4000-8000-0000000000f1'
const digest = (id: string) =>
  sessionConversationIdentity({
    worktreeId: WORKTREE,
    agent: 'claude',
    providerSession: { key: 'session_id', id }
  })

let dir: string
let opened: OpenedHost
let stop: (() => void) | null = null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'main-conversation-ledger-'))
  opened = openTestHost(dir, hostTestClock(Date.now()))
})

afterEach(async () => {
  stop?.()
  stop = null
  await opened.host.flush()
  rmSync(dir, { recursive: true, force: true })
})

/** owner-ledger.json as the store kept the window's last publication (F17). */
function ownerLedger(publication: Partial<SessionConversationLedgerWindowPublication>): string {
  const path = join(dir, 'owner-ledger.json')
  const full: SessionConversationLedgerWindowPublication = {
    rendererGeneration: 'gen-1',
    listedAt: Date.now() - 60_000,
    coverage: [{ worktreeId: WORKTREE, complete: true }],
    omitted: { unknownHost: 0, unverified: 0 },
    folders: [],
    projects: [],
    recordsByWorktree: {},
    ...publication
  }
  writeFileSync(path, JSON.stringify({ v: 1, publication: full }))
  return path
}

function start(
  source: ReturnType<typeof inventorySource>,
  ownerLedgerPath: string | null,
  readInventory: () => OwnerConversationInventorySource | null = () => source
) {
  const store = new SessionConversationLedgerStore({ ownerLedgerPath })
  const signal = new OwnerInventorySignal()
  stop = publishMainConversationLedger({
    store,
    readInventory,
    values: opened.view,
    onInventoryChanged: (listener) => signal.subscribe(listener)
  })
  return { store, signal, records: () => store.snapshot().recordsByWorktree[WORKTREE] ?? [] }
}

/** Everything a client that negotiated the ledger is streamed from now on (step 4's stream). */
function streamOf(store: SessionConversationLedgerStore): unknown[] {
  const streamed: unknown[] = []
  const emit = withSessionConversationLedgerStream(
    {
      runtime: {
        getSessionConversationLedgerStore: () => store
      } as unknown as RpcContext['runtime'],
      clientCapabilities: [SESSION_TABS_CONVERSATION_LEDGER_RUNTIME_CAPABILITY]
    },
    (event) => streamed.push(event)
  )
  emit({ type: 'snapshots', snapshots: [] })
  return streamed
}

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

const archive = (key: string) =>
  opened.host.apply({
    kind: 'archive',
    targets: [{ sessionKey: key }],
    value: true,
    executor: HOST_PERSON
  })

describe('the owner’s conversation ledger with no window (session parity, step 3)', () => {
  it('publishes the persisted store with the last window’s catalog and titles; a later archive flips it', async () => {
    const pane = `tab-1:${LEAF_A}`
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: { [WORKTREE]: [terminalTab('tab-1')] },
        terminalLayoutsByTabId: { 'tab-1': leafLayout(LEAF_A, 'pty-1') },
        sleepingAgentSessionsByPaneKey: { [pane]: sleepingRecord(pane, 's-1') }
      })
    )
    const path = ownerLedger({
      folders: [{ id: FOLDER, name: 'Ops' }],
      projects: [{ folderId: FOLDER }],
      recordsByWorktree: {
        [WORKTREE]: [
          {
            conversation: digest('s-1'),
            agent: 'claude',
            providerSession: { key: 'session_id', id: 's-1' },
            title: 'Plan the launch',
            titleSource: 'custom',
            surface: 'tab',
            paneKey: pane,
            tabId: 'tab-1',
            rest: 'live',
            archived: { archived: false },
            folderId: FOLDER,
            listed: true,
            updatedAt: 5
          }
        ]
      }
    })
    const { store, records } = start(source, path)
    const first = store.snapshot()
    expect(first).toMatchObject({
      source: 'main',
      folders: [{ id: FOLDER, name: 'Ops' }],
      projects: [{ folderId: FOLDER }],
      coverage: [{ worktreeId: WORKTREE, complete: true }]
    })
    expect(records()).toEqual([
      expect.objectContaining({
        conversation: digest('s-1'),
        title: 'Plan the launch',
        titleSource: 'custom',
        surface: 'tab',
        rest: 'asleep',
        archived: { archived: false },
        folderId: FOLDER
      })
    ])
    expect(JSON.stringify(first)).not.toContain('SENTINEL-PROMPT')

    await archive(providerKey('s-1'))
    await vi.waitFor(() => expect(records()[0]?.archived).toEqual({ archived: true }))
    expect(store.snapshot().revision).toBeGreaterThan(first.revision)
  })

  it('keeps the listed value over a host value stamped before that listing', async () => {
    await archive(providerKey('s-1'))
    const pane = `tab-gone:${LEAF_A}`
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        sleepingAgentSessionsByPaneKey: { [pane]: sleepingRecord(pane, 's-1') }
      })
    )
    const path = ownerLedger({
      listedAt: Date.now() + 60 * 60_000,
      recordsByWorktree: {
        [WORKTREE]: [
          {
            conversation: digest('s-1'),
            agent: 'claude',
            providerSession: { key: 'session_id', id: 's-1' },
            title: 'Refunds',
            titleSource: 'terminal',
            surface: 'record',
            paneKey: pane,
            rest: 'asleep',
            archived: { archived: false, byHand: true },
            listed: true,
            updatedAt: 5
          }
        ]
      }
    })
    const { records } = start(source, path)
    expect(records()[0]).toMatchObject({ archived: { archived: false, byHand: true } })
  })

  it('lists a record-only conversation asleep and a mapped but dead PTY dormant; an exit alone updates rest', async () => {
    const recordPane = `tab-gone:${LEAF_C}`
    const passivePane = `tab-old:${LEAF_C}`
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: { [WORKTREE]: [terminalTab('tab-1'), terminalTab('tab-2')] },
        terminalLayoutsByTabId: {
          'tab-1': leafLayout(LEAF_A, 'pty-1'),
          'tab-2': leafLayout(LEAF_B, 'pty-2')
        },
        sleepingAgentSessionsByPaneKey: {
          [recordPane]: sleepingRecord(recordPane, 's-3', { terminalTitle: 'Refund triage' }),
          [passivePane]: sleepingRecord(passivePane, 's-4', { origin: 'live', state: 'done' })
        }
      }),
      { connectedPtys: [{ ptyId: 'pty-2', paneKey: null }] }
    )
    const { store, signal, records } = start(source, null)
    const rest = (paneKey: string) => records().find((record) => record.paneKey === paneKey)
    expect(rest(`tab-1:${LEAF_A}`)).toMatchObject({ surface: 'tab', rest: 'dormant' })
    expect(rest(`tab-2:${LEAF_B}`)).toMatchObject({ surface: 'tab', rest: 'live' })
    expect(rest(recordPane)).toMatchObject({
      surface: 'record',
      rest: 'asleep',
      title: 'Refund triage',
      titleSource: 'terminal',
      listed: true
    })
    expect(rest(recordPane)?.tabId).toBeUndefined()
    expect(rest(passivePane)).toMatchObject({ surface: 'record', listed: false })

    // A windowless natural exit: no organization or sleep write, only the PTY gone.
    const before = store.snapshot().revision
    source.connectedPtys.splice(0)
    signal.notify()
    await vi.waitFor(() => expect(rest(`tab-2:${LEAF_B}`)?.rest).toBe('dormant'))
    expect(store.snapshot().revision).toBeGreaterThan(before)
  })

  it('leaves a deleted tab-less conversation out, keeps one whose tab is open again, and an undo brings it back', async () => {
    const recordPane = `tab-gone:${LEAF_A}`
    const tabPane = `tab-5:${LEAF_B}`
    await windowDeletes('del-record', providerKey('s-4'), true)
    await windowDeletes('del-reopened', providerKey('s-5'), true)
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: { [WORKTREE]: [terminalTab('tab-5')] },
        terminalLayoutsByTabId: { 'tab-5': leafLayout(LEAF_B) },
        sleepingAgentSessionsByPaneKey: {
          [recordPane]: sleepingRecord(recordPane, 's-4'),
          [tabPane]: sleepingRecord(tabPane, 's-5')
        }
      })
    )
    const { records } = start(source, null)
    expect(records().map((record) => record.conversation)).toEqual([digest('s-5')])

    await windowDeletes('undo-record', providerKey('s-4'), false)
    await vi.waitFor(() =>
      expect(records().map((record) => record.conversation)).toContain(digest('s-4'))
    )
  })

  it('lists a resumed conversation once, at its tab, not again for its old record', () => {
    const oldPane = `tab-gone:${LEAF_A}`
    const newPane = `tab-new:${LEAF_B}`
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: { [WORKTREE]: [terminalTab('tab-new')] },
        terminalLayoutsByTabId: { 'tab-new': leafLayout(LEAF_B, 'pty-new') },
        sleepingAgentSessionsByPaneKey: {
          [oldPane]: sleepingRecord(oldPane, 's-1'),
          [newPane]: sleepingRecord(newPane, 's-1', { origin: 'live' })
        }
      }),
      { connectedPtys: [{ ptyId: 'pty-new', paneKey: newPane }] }
    )
    const { store, records } = start(source, null)
    expect(records()).toEqual([
      expect.objectContaining({ conversation: digest('s-1'), surface: 'tab', rest: 'live' })
    ])
    expect(store.snapshot().coverage).toEqual([{ worktreeId: WORKTREE, complete: true }])
  })

  // Integration: the same record the window publishes for one conversation (step 2).
  it('names and marks a tab as the window does: record title first, a placeholder for its agent, interrupted only asleep', () => {
    const live = `tab-live:${LEAF_A}`
    const titled = `tab-titled:${LEAF_B}`
    const generated = `tab-generated:${LEAF_C}`
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: {
          [WORKTREE]: [
            terminalTab('tab-live', { title: 'Terminal 3' }),
            terminalTab('tab-titled'),
            terminalTab('tab-generated', { generatedTitle: 'Fix the login bug' })
          ]
        },
        terminalLayoutsByTabId: {
          'tab-live': leafLayout(LEAF_A, 'pty-live'),
          'tab-titled': leafLayout(LEAF_B),
          'tab-generated': leafLayout(LEAF_C)
        },
        sleepingAgentSessionsByPaneKey: {
          [live]: sleepingRecord(live, 's-live', { origin: 'live', interrupted: true }),
          [titled]: sleepingRecord(titled, 's-titled', {
            interrupted: true,
            terminalTitle: 'Refund triage'
          })
        }
      }),
      { connectedPtys: [{ ptyId: 'pty-live', paneKey: live }] }
    )
    const { records } = start(source, null)
    const byPane = (paneKey: string) => records().find((record) => record.paneKey === paneKey)
    // F2: the agent's name, never "(untitled)" text; a receiver renders that in its own language.
    expect(byPane(live)).toMatchObject({ rest: 'live', title: 'claude', titleSource: 'agent' })
    expect(byPane(live)).not.toHaveProperty('interrupted')
    expect(byPane(titled)).toMatchObject({
      rest: 'asleep',
      interrupted: true,
      title: 'Refund triage',
      titleSource: 'terminal'
    })
    // F2: a generated title (a prompt preview) crosses as #1081's sessionTitle carries it.
    expect(byPane(generated)).toMatchObject({
      title: 'Fix the login bug',
      titleSource: 'generated'
    })
  })

  it('quarantines a tab a paired runtime’s PTY backs: counted, its workspace incomplete', () => {
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: {
          [WORKTREE]: [
            terminalTab('tab-peer', { ptyId: toRemoteRuntimePtyId('term-1', 'env-studio') }),
            terminalTab('tab-own')
          ]
        },
        terminalLayoutsByTabId: {
          'tab-peer': leafLayout(LEAF_A),
          'tab-own': leafLayout(LEAF_B)
        },
        sleepingAgentSessionsByPaneKey: {}
      })
    )
    const { store, records } = start(source, null)
    expect(records().map((record) => record.tabId)).toEqual(['tab-own'])
    expect(store.snapshot()).toMatchObject({
      omitted: { unknownHost: 0, unverified: 1 },
      coverage: [{ worktreeId: WORKTREE, complete: false }]
    })
  })

  // F3/F7: one rule for both publishers (session-conversation-ledger-publication.test.ts pins the
  // window's side), so the owner's population does not depend on whether its window is open.
  it('quarantines every row of an unresolved workspace, even a tab a local PTY made owned', () => {
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: { [WORKTREE]: [terminalTab('tab-1')] },
        // The saved layout maps a local PTY left over from the last run.
        terminalLayoutsByTabId: { 'tab-1': leafLayout(LEAF_A, 'pty-old') },
        sleepingAgentSessionsByPaneKey: {}
      }),
      { provenance: () => ({ kind: 'unresolved' }) }
    )
    const { store, records } = start(source, null)
    expect(records()).toEqual([])
    expect(store.snapshot()).toMatchObject({
      omitted: { unknownHost: 0, unverified: 1 },
      coverage: [{ worktreeId: WORKTREE, complete: false }]
    })
  })

  it('leaves a direct-SSH record out, uncounted, and its workspace incomplete', () => {
    const local = `tab-1:${LEAF_A}`
    const ssh = `tab-2:${LEAF_B}`
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        sleepingAgentSessionsByPaneKey: {
          [local]: sleepingRecord(local, 's-local'),
          [ssh]: sleepingRecord(ssh, 's-ssh', { connectionId: 'conn-1' })
        }
      })
    )
    const { store, records } = start(source, null)
    expect(records().map((record) => record.conversation)).toEqual([digest('s-local')])
    expect(store.snapshot()).toMatchObject({
      omitted: { unknownHost: 0, unverified: 0 },
      coverage: [{ worktreeId: WORKTREE, complete: false }]
    })
  })

  it('with no owner-ledger.json, says nothing of archive or folder: unknown, not unarchived', () => {
    const pane = `tab-gone:${LEAF_A}`
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        sleepingAgentSessionsByPaneKey: { [pane]: sleepingRecord(pane, 's-1') }
      })
    )
    const { store, records } = start(source, join(dir, 'missing-owner-ledger.json'))
    expect(store.snapshot()).toMatchObject({ source: 'main', folders: [], projects: [] })
    const [record] = records()
    expect(record).toMatchObject({ title: 'claude', titleSource: 'agent', rest: 'asleep' })
    expect(record).not.toHaveProperty('archived')
    expect(record).not.toHaveProperty('folderId')
  })

  // It builds inline in app startup (startSessionHostOwner) and in timers and microtasks.
  it('reads a non-string host title as none, and a build that throws keeps the last set and logs', async () => {
    const pane = `tab-gone:${LEAF_A}`
    const damaged = { title: 1 } as unknown as { title: string }
    opened.view.importValue(providerKey('s-1'), 'title', damaged, new Date().toISOString())
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        sleepingAgentSessionsByPaneKey: {
          [pane]: sleepingRecord(pane, 's-1', { terminalTitle: 'Refunds' })
        }
      })
    )
    let broken = false
    const { store, signal, records } = start(source, null, () => {
      if (broken) {
        throw new Error('damaged store')
      }
      return source
    })
    expect(records()).toEqual([
      expect.objectContaining({ title: 'Refunds', titleSource: 'terminal' })
    ])

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const kept = store.snapshot()
      broken = true
      signal.notify()
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(
          '[session-host] building the main-authored conversation ledger failed',
          expect.objectContaining({ message: 'damaged store' })
        )
      )
      expect(store.snapshot()).toEqual(kept)
    } finally {
      warn.mockRestore()
    }
  })

  it('starts with no set and no throw when the very first build fails', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const source = inventorySource(
        workspaceSession({
          tabsByWorktree: {},
          terminalLayoutsByTabId: {},
          sleepingAgentSessionsByPaneKey: {}
        })
      )
      const { store } = start(source, null, () => {
        throw new Error('damaged store')
      })
      expect(store.snapshot()).toMatchObject({ revision: 0, recordsByWorktree: {} })
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('builds nothing while a window publishes, and shows the current store at once when it goes', async () => {
    const pane = `tab-1:${LEAF_A}`
    const closedPane = `tab-2:${LEAF_B}`
    const source = inventorySource(
      workspaceSession({
        tabsByWorktree: { [WORKTREE]: [terminalTab('tab-1'), terminalTab('tab-2')] },
        terminalLayoutsByTabId: {
          'tab-1': leafLayout(LEAF_A, 'pty-1'),
          'tab-2': leafLayout(LEAF_B)
        },
        sleepingAgentSessionsByPaneKey: {}
      })
    )
    const readInventory = vi.fn(() => source)
    const { store, signal, records } = start(source, null, readInventory)
    const byPane = (paneKey: string) => records().find((record) => record.paneKey === paneKey)
    expect(byPane(pane)?.rest).toBe('dormant')
    expect(byPane(closedPane)).toBeDefined()
    expect(readInventory).toHaveBeenCalledTimes(1)

    // The window publishes; the person then closes tab-2, which its next listing drops.
    store.publishWindow({
      rendererGeneration: 'gen-1',
      listedAt: Date.now(),
      coverage: [{ worktreeId: WORKTREE, complete: true }],
      omitted: { unknownHost: 0, unverified: 0 },
      folders: [],
      projects: [],
      recordsByWorktree: { [WORKTREE]: [byPane(pane)!] }
    })
    source.session.tabsByWorktree = { [WORKTREE]: [terminalTab('tab-1')] }
    source.connectedPtys.push({ ptyId: 'pty-1', paneKey: pane })
    signal.notify()
    // Past the coalescing delay: still no build while the window publishes.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(readInventory).toHaveBeenCalledTimes(1)
    expect(store.snapshot().source).toBe('window')

    const streamed = streamOf(store)
    store.markPublisherGone()
    await vi.waitFor(() => expect(byPane(pane)?.rest).toBe('live'))
    expect(readInventory).toHaveBeenCalledTimes(2)
    expect(store.snapshot().source).toBe('main')
    // Nothing streamed from the window going away to main's rebuild lists the closed conversation.
    expect(streamed.length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(streamed)).not.toContain(closedPane)
  })
})

describe('startOwnerConversationLedger', () => {
  // Its stop is awaited in the session-host-owner stop, which the quit barrier awaits.
  it('marks the owner publisher while it runs, and its stop writes the pending listing', async () => {
    hostValues.current = opened.view
    const path = join(dir, 'session-host', 'owner-ledger.json')
    const store = new SessionConversationLedgerStore({ ownerLedgerPath: path })
    const stopLedger = startOwnerConversationLedger(
      {
        getSessionConversationLedgerStore: () => store,
        readOwnerConversationInventory: () => null,
        onOwnerConversationInventoryChanged: () => () => {}
      },
      dir
    )
    expect(store.hasOwnerPublisher()).toBe(true)
    const listing: SessionConversationLedgerWindowPublication = {
      rendererGeneration: 'gen-1',
      listedAt: 7,
      coverage: [],
      omitted: { unknownHost: 0, unverified: 0 },
      folders: [{ id: FOLDER, name: 'Ops' }],
      projects: [],
      recordsByWorktree: {}
    }
    store.publishWindow(listing)
    // The write waits on its coalescing timer; a quit within it would lose the listing.
    expect(existsSync(path)).toBe(false)

    await stopLedger()
    expect(store.hasOwnerPublisher()).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1, publication: listing })
  })
})
