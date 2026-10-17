import { describe, expect, it, vi } from 'vitest'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-session-contracts'
import {
  LEAF_A,
  leafLayout,
  sleepingRecord,
  terminalTab,
  workspaceSession,
  WORKTREE as LEDGER_WORKTREE
} from '../session-host-owner/main-conversation-inventory-test-fixture'
import { publishMainConversationLedger } from '../session-host-owner/main-conversation-ledger'
import { OrcaRuntimeService } from './omni-runtime'

const WORKTREE = 'repo::/worktree'
const NOT_ARCHIVED = { archived: false, byHand: false }
const ARCHIVED = { archived: true, byHand: true }

function runtimeWithPublishedTab(windowId: number): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
  if (windowId !== HEADLESS_RUNTIME_WINDOW_ID) {
    runtime.attachWindow(windowId)
  }
  runtime.syncWindowGraph(windowId, {
    tabs: [],
    leaves: [],
    mobileSessionTabs: [
      {
        worktree: WORKTREE,
        publicationEpoch: 'epoch',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [
          {
            type: 'terminal' as const,
            id: 'tab-1::leaf-1',
            parentTabId: 'tab-1',
            leafId: 'leaf-1',
            title: 'Claude',
            sessionArchive: NOT_ARCHIVED,
            isActive: false
          }
        ]
      }
    ]
  })
  return runtime
}

async function published(runtime: OrcaRuntimeService) {
  const [snapshot] = (await runtime.listAllMobileSessionTabsInventory()).snapshots
  const [tab] = snapshot?.tabs ?? []
  return {
    version: snapshot?.snapshotVersion,
    sessionArchive: tab?.type === 'terminal' ? tab.sessionArchive : undefined
  }
}

describe('archive placement a windowless owner publishes', () => {
  it('is what the session sits in now, republished after an archive, not what the window last sent', async () => {
    const runtime = runtimeWithPublishedTab(HEADLESS_RUNTIME_WINDOW_ID)
    let placement = NOT_ARCHIVED
    runtime.setHeadlessSessionArchiveReader((paneKey) =>
      paneKey === 'tab-1:leaf-1' ? placement : undefined
    )
    const before = await published(runtime)
    expect(before.sessionArchive).toEqual(NOT_ARCHIVED)

    const changed = vi.fn()
    const stop = runtime.onMobileSessionTabsChanged(changed)
    placement = ARCHIVED
    runtime.republishHeadlessSessionArchive()
    stop()

    const after = await published(runtime)
    expect(after.sessionArchive).toEqual(ARCHIVED)
    expect(after.version).toBeGreaterThan(before.version ?? 0)
    expect(changed).toHaveBeenCalled()
  })

  it('stays what an open window publishes', async () => {
    const runtime = runtimeWithPublishedTab(1)
    runtime.setHeadlessSessionArchiveReader(() => ARCHIVED)
    runtime.republishHeadlessSessionArchive()
    expect((await published(runtime)).sessionArchive).toEqual(NOT_ARCHIVED)
  })
})

describe('the conversation ledger a windowless owner publishes (session parity, step 3)', () => {
  it('is main-authored from the persisted LOCAL partition, and rebuilt when a PTY exits', () => {
    const pane = `tab-gone:${LEAF_A}`
    const local = workspaceSession({
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [pane]: sleepingRecord(pane, 's-1') }
    })
    // Why another partition holding the same record: only the local slice is this owner's.
    const ssh = workspaceSession({
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [pane]: sleepingRecord(pane, 's-ssh') }
    })
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getRepo: () => undefined,
      getWorktreeMeta: () => undefined,
      getWorkspaceSession: (hostId?: string | null) => (hostId === 'local' ? local : ssh)
    } as never)
    const store = runtime.getSessionConversationLedgerStore()
    const readInventory = vi.fn(() => runtime.readOwnerConversationInventory())
    const stop = publishMainConversationLedger({
      store,
      readInventory,
      values: { keys: () => [], entry: () => undefined, onChange: () => () => {} },
      onInventoryChanged: (listener) => runtime.onOwnerConversationInventoryChanged(listener)
    })
    expect(store.isWindowCurrent()).toBe(false)
    expect(store.snapshot()).toMatchObject({
      source: 'main',
      coverage: [{ worktreeId: LEDGER_WORKTREE, complete: true }]
    })
    expect(store.snapshot().recordsByWorktree[LEDGER_WORKTREE]).toEqual([
      expect.objectContaining({
        surface: 'record',
        rest: 'asleep',
        providerSession: { key: 'session_id', id: 's-1' }
      })
    ])

    const heard = vi.fn()
    const unsubscribe = runtime.onOwnerConversationInventoryChanged(heard)
    runtime.onPtyExit('pty-exited', 0)
    expect(heard).toHaveBeenCalledTimes(1)
    unsubscribe()
    stop()
  })

  // F16: the controller inventory refresh flips `connected` with no store write or exit event.
  it('is rebuilt when a controller listing finds a PTY gone, and not when nothing moved', async () => {
    const local = workspaceSession({
      tabsByWorktree: { [LEDGER_WORKTREE]: [terminalTab('tab-1')] },
      terminalLayoutsByTabId: { 'tab-1': leafLayout(LEAF_A, 'pty-1') },
      sleepingAgentSessionsByPaneKey: {}
    })
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getRepo: () => undefined,
      getWorktreeMeta: () => undefined,
      getWorkspaceSession: () => local
    } as never)
    const alive = new Set(['pty-1'])
    runtime.setPtyController({
      listProcesses: vi.fn(async () => []),
      hasPty: (ptyId: string) => alive.has(ptyId)
    } as never)
    const internals = runtime as unknown as {
      recordPtyWorktree(ptyId: string, worktreeId: string, state: { connected: boolean }): unknown
      refreshPtyWorktreeRecordsWithControllerInventory(worktrees: unknown[]): Promise<unknown>
    }
    internals.recordPtyWorktree('pty-1', LEDGER_WORKTREE, { connected: true })
    const store = runtime.getSessionConversationLedgerStore()
    const stop = publishMainConversationLedger({
      store,
      readInventory: () => runtime.readOwnerConversationInventory(),
      values: { keys: () => [], entry: () => undefined, onChange: () => () => {} },
      onInventoryChanged: (listener) => runtime.onOwnerConversationInventoryChanged(listener)
    })
    const rest = () => store.snapshot().recordsByWorktree[LEDGER_WORKTREE]?.[0]?.rest
    expect(rest()).toBe('live')
    const heard = vi.fn()
    const unsubscribe = runtime.onOwnerConversationInventoryChanged(heard)

    await internals.refreshPtyWorktreeRecordsWithControllerInventory([])
    const settled = heard.mock.calls.length
    await internals.refreshPtyWorktreeRecordsWithControllerInventory([])
    expect(heard).toHaveBeenCalledTimes(settled)
    // The PTY is gone from the provider with no exit event (provider restart).
    alive.clear()
    await internals.refreshPtyWorktreeRecordsWithControllerInventory([])
    expect(heard).toHaveBeenCalledTimes(settled + 1)
    await vi.waitFor(() => expect(rest()).toBe('dormant'))
    unsubscribe()
    stop()
  })
})
