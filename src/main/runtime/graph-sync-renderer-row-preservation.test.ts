import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './omni-runtime'

const FOLDER_ID = 'inventory-folder'
const FOLDER = `folder:${FOLDER_ID}`
const WORKTREE = 'repo::/tmp/inventory-worktree'

function createHarness(worktree: string) {
  let session: WorkspaceSessionState = { ...getDefaultWorkspaceSession() }
  const folder: FolderWorkspace = {
    id: FOLDER_ID,
    projectGroupId: 'project',
    name: 'Inventory folder',
    folderPath: '/tmp/inventory-folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  const repo = {
    id: 'repo',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 1
  }
  const runtime = new OrcaRuntimeService({
    getRepo: () => repo,
    getRepos: () => [repo],
    getFolderWorkspaces: () => [folder],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    getSettings: () => ({ workspaceDir: '/tmp/workspaces' }),
    getWorkspaceSession: () => session,
    setWorkspaceSession: (next: WorkspaceSessionState) => {
      session = next
    }
  } as never)
  runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
  runtime.attachWindow(1)
  const internals = runtime as unknown as {
    mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
    sessionTabsInventoryPublicationEpoch: number | null
    sessionTabsInventoryWaiters: Set<() => void>
  }
  const persistTerminal = (id: string, ptyId: string) => {
    session = {
      ...session,
      tabsByWorktree: {
        [worktree]: [
          {
            id,
            ptyId,
            worktreeId: worktree,
            title: id,
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    }
  }
  const sync = (snapshots: RuntimeMobileSessionTabsSnapshot[], unchanged?: string[]) =>
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: snapshots,
      ...(unchanged ? { unchangedMobileSessionWorktrees: unchanged } : {})
    })
  return { runtime, internals, persistTerminal, sync }
}

function terminal(leafId: string, ptyId?: string): RuntimeMobileSessionSnapshotTab {
  return {
    type: 'terminal',
    id: `tab::${leafId}`,
    parentTabId: 'tab',
    leafId,
    title: leafId,
    isActive: false,
    ...(ptyId ? { ptyId } : {})
  }
}

function snapshot(
  worktree: string,
  tabs: RuntimeMobileSessionSnapshotTab[]
): RuntimeMobileSessionTabsSnapshot {
  return {
    worktree,
    publicationEpoch: 'renderer:row-preservation',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs
  }
}

afterEach(() => vi.useRealTimers())

describe('renderer rows survive runtime-only graph hydration', () => {
  it.each([FOLDER, WORKTREE])(
    'does not resync indefinitely after aliases merge in %s',
    async (worktree) => {
      vi.useFakeTimers()
      const { runtime, internals, persistTerminal, sync } = createHarness(worktree)
      const published = snapshot(worktree, [
        terminal('leaf-a', 'serve-pty-shared'),
        terminal('leaf-b', 'serve-pty-shared'),
        terminal('leaf-c', 'serve-pty-shared')
      ])
      sync([published])
      // Runtime-only hydration occurs after the renderer starts withholding this revision.
      persistTerminal('tab', 'serve-pty-shared')
      const withheld = sync([], [worktree])
      const resend = sync([published], [])
      const withheldAgain = sync([], [worktree])

      expect([
        withheld.mobileSessionResyncWorktrees,
        resend.mobileSessionResyncWorktrees,
        withheldAgain.mobileSessionResyncWorktrees
      ]).toEqual([undefined, undefined, undefined])
      expect(internals.mobileSessionTabsByWorktree.get(worktree)?.tabs).toEqual(published.tabs)
      await expect(runtime.listAllMobileSessionTabsInventory()).resolves.toMatchObject({
        authoritative: true,
        snapshots: [{ worktree, tabs: expect.any(Array) }]
      })
    }
  )

  it('keeps distinct pending splits, browser pages and documents when adding a runtime terminal', () => {
    const { internals, persistTerminal, sync } = createHarness(FOLDER)
    const published = snapshot(FOLDER, [
      terminal('pending-a'),
      terminal('pending-b'),
      {
        type: 'browser',
        id: 'browser-a',
        browserWorkspaceId: 'browser-workspace-a',
        browserPageId: 'page-a',
        title: 'A',
        url: 'https://example.test/a',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: false
      },
      {
        type: 'browser',
        id: 'browser-b',
        browserWorkspaceId: 'browser-workspace-b',
        browserPageId: 'page-b',
        title: 'B',
        url: 'https://example.test/b',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: false
      },
      {
        type: 'file',
        id: 'file-a',
        title: 'A',
        filePath: '/tmp/a.txt',
        relativePath: 'a.txt',
        language: 'text',
        isDirty: false,
        isActive: false
      },
      {
        type: 'file',
        id: 'file-b',
        title: 'B',
        filePath: '/tmp/b.txt',
        relativePath: 'b.txt',
        language: 'text',
        isDirty: false,
        isActive: false
      }
    ])
    sync([published])
    persistTerminal('runtime-tab', 'serve-pty-runtime')

    expect(sync([], [FOLDER]).mobileSessionResyncWorktrees).toBeUndefined()
    expect(internals.mobileSessionTabsByWorktree.get(FOLDER)?.tabs).toEqual([
      ...published.tabs,
      expect.objectContaining({ parentTabId: 'runtime-tab' })
    ])
  })

  it('holds global publication for an actual missing renderer row until its revision is resent', async () => {
    vi.useFakeTimers()
    const { runtime, internals, sync } = createHarness(FOLDER)
    const published = snapshot(FOLDER, [terminal('pending-a'), terminal('pending-b')])
    sync([published])
    const stored = internals.mobileSessionTabsByWorktree.get(FOLDER)!
    internals.mobileSessionTabsByWorktree.set(FOLDER, { ...stored, tabs: stored.tabs.slice(0, 1) })
    expect(sync([], [FOLDER]).mobileSessionResyncWorktrees).toEqual([FOLDER])
    expect(internals.sessionTabsInventoryPublicationEpoch).toBeNull()
    let settled = false
    const pending = runtime.listAllMobileSessionTabsInventory().then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(internals.sessionTabsInventoryWaiters.size).toBe(1))
    expect(settled).toBe(false)

    sync([published])
    await expect(pending).resolves.toMatchObject({ authoritative: true })
    expect(internals.mobileSessionTabsByWorktree.get(FOLDER)?.tabs).toEqual(published.tabs)
  })
})
