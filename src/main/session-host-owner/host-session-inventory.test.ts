import { statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { testHostRoot, type TestHostRoot } from '../session-host/session-host-test-fixture'
import { observeSession } from '../session-manage/session-manage-observe'
import { observeSources, sidebarRow } from '../session-manage/session-manage-test-fixtures'
import type { HostOrganizationEntry } from '../../shared/session-organization-host'
import { HostSessionInventory } from './host-session-inventory'
import { mainConversationInventory } from './main-conversation-inventory'
import {
  inventorySource,
  LEAF_A,
  LEAF_B,
  leafLayout,
  providerKey,
  sleepingRecord,
  terminalTab,
  workspaceSession,
  WORKTREE
} from './main-conversation-inventory-test-fixture'
import { withMainInventoryRows } from './main-inventory-sidebar-rows'

let root: TestHostRoot
beforeEach(() => {
  root = testHostRoot()
})
afterEach(() => {
  root.dispose()
})

function inventory(rows: () => Promise<ReturnType<typeof sidebarRow>[]>) {
  return new HostSessionInventory({
    readWindowRows: rows,
    observe: (row) => observeSession(row, observeSources({ resolvePane: () => null })),
    cacheFile: join(root.root, 'rows.json')
  })
}

describe('the host’s own sessions with and without a window', () => {
  it('lists only sessions this computer runs, and remembers them for when no window answers', async () => {
    const local = sidebarRow()
    const ssh = sidebarRow({ rowKey: 'ssh-row', paneKey: 'tab-2:leaf-1', hostId: 'ssh:box' })
    const withWindow = inventory(async () => [local, ssh])
    expect((await withWindow.rows()).rows).toEqual([local])
    await withWindow.flush()
    const restarted = inventory(async () => {
      throw new Error('No window is attached.')
    })
    expect(await restarted.rows()).toEqual({ rows: [local], from: 'remembered' })
  })

  it('observes a remembered row live: a pane nothing here resolves is unverifiable, not exited', async () => {
    const remembered = inventory(async () => {
      throw new Error('No window is attached.')
    })
    const withWindow = inventory(async () => [sidebarRow()])
    await withWindow.rows()
    await withWindow.flush()
    const [session] = await remembered.list()
    expect(session?.entry.verdict).toBe('unverifiable')
  })

  it('says when the window last listed its rows, from the remembered file after a restart', async () => {
    const local = sidebarRow()
    const withWindow = inventory(async () => [local])
    const before = Date.now()
    await withWindow.rows()
    const listed = withWindow.lastListed()
    expect(listed.rows).toEqual([local])
    expect(listed.listedAt).toBeGreaterThanOrEqual(before)
    await withWindow.flush()

    const restarted = inventory(async () => {
      throw new Error('No window is attached.')
    })
    expect(restarted.lastListed()).toEqual({
      rows: [local],
      listedAt: statSync(join(root.root, 'rows.json')).mtimeMs
    })
  })

  it('knows no listing time when nothing was ever remembered', () => {
    expect(inventory(async () => []).lastListed()).toEqual({ rows: [], listedAt: null })
  })
})

describe('the windowless inventory main builds from its own store (session parity, B3)', () => {
  const recordPane = `tab-gone:${LEAF_A}`
  const deletedPane = `tab-old:${LEAF_B}`
  const source = inventorySource(
    workspaceSession({
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        [recordPane]: sleepingRecord(recordPane, 's-1'),
        [deletedPane]: sleepingRecord(deletedPane, 's-2')
      }
    })
  )
  const held: Record<string, HostOrganizationEntry> = {
    [providerKey('s-2')]: { values: { deleted: true }, revisions: {} }
  }
  function cold(rows: () => Promise<ReturnType<typeof sidebarRow>[]>) {
    return new HostSessionInventory({
      readWindowRows: rows,
      observe: (row) => observeSession(row, observeSources({ resolvePane: () => null })),
      cacheFile: join(root.root, 'rows.json'),
      headlessRows: (remembered) =>
        withMainInventoryRows(remembered, mainConversationInventory(source), {
          entry: (key) => held[key]
        })
    })
  }
  const noWindow = async (): Promise<ReturnType<typeof sidebarRow>[]> => {
    throw new Error('No window is attached.')
  }

  it('lists a persisted record with nothing remembered, so its pane resolves; a deleted one stays out', async () => {
    const { rows, from } = await cold(noWindow).rows()
    expect(from).toBe('remembered')
    expect(rows).toEqual([
      expect.objectContaining({
        viewKey: providerKey('s-1'),
        paneKey: recordPane,
        tabId: null,
        hostId: 'local',
        worktreeId: WORKTREE,
        providerSessionId: 's-1',
        resumable: true
      })
    ])
    const found = await cold(noWindow).rowFor({
      worktreeId: WORKTREE,
      paneKey: recordPane,
      kind: 'pty'
    })
    expect(found?.providerSessionId).toBe('s-1')
  })

  it('keeps a remembered row exactly as the window listed it, never twice', async () => {
    const listed = sidebarRow({ worktreeId: WORKTREE, paneKey: recordPane, title: 'As listed' })
    const withWindow = cold(async () => [listed])
    await withWindow.rows()
    await withWindow.flush()
    expect((await cold(noWindow).rows()).rows).toEqual([listed])
  })

  it('rebinds a remembered row to the tab a headless resume opened for its conversation', async () => {
    const resumedPane = `tab-new:${LEAF_B}`
    const resumed = new HostSessionInventory({
      readWindowRows: noWindow,
      observe: (row) => observeSession(row, observeSources({ resolvePane: () => null })),
      cacheFile: join(root.root, 'rows.json'),
      headlessRows: (remembered) =>
        withMainInventoryRows(
          remembered,
          mainConversationInventory(
            inventorySource(
              workspaceSession({
                tabsByWorktree: { [WORKTREE]: [terminalTab('tab-new')] },
                terminalLayoutsByTabId: { 'tab-new': leafLayout(LEAF_B) },
                sleepingAgentSessionsByPaneKey: {
                  [resumedPane]: sleepingRecord(resumedPane, 's-1')
                }
              })
            )
          ),
          { entry: () => undefined }
        )
    })
    const listed = sidebarRow({
      worktreeId: WORKTREE,
      viewKey: providerKey('s-1'),
      paneKey: recordPane,
      tabId: null,
      title: 'As listed'
    })
    const withWindow = cold(async () => [listed])
    await withWindow.rows()
    await withWindow.flush()
    expect((await resumed.rows()).rows).toEqual([
      {
        ...listed,
        rowKey: JSON.stringify(['local', WORKTREE, resumedPane]),
        paneKey: resumedPane,
        tabId: 'tab-new',
        resumable: true
      }
    ])
  })
})
