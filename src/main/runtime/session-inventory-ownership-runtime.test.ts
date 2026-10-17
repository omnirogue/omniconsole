import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-session-contracts'
import type { Tab } from '../../shared/tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './omni-runtime'

const WORKTREE_ID = 'repo::/worktree'

function sessionWithTab(options: {
  ptyId: string | null
  executionHostId?: Tab['executionHostId']
}): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: 'tab',
          ptyId: options.ptyId,
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    unifiedTabs: options.executionHostId
      ? {
          [WORKTREE_ID]: [
            {
              id: 'tab',
              entityId: 'tab',
              groupId: 'group',
              worktreeId: WORKTREE_ID,
              executionHostId: options.executionHostId,
              contentType: 'terminal',
              label: 'Terminal',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      : {}
  }
}

function rendererSnapshot(worktree = WORKTREE_ID): RuntimeMobileSessionTabsSnapshot {
  const terminal = (parentTabId: string, ptyId: string | null) => ({
    type: 'terminal' as const,
    id: `${parentTabId}::leaf`,
    parentTabId,
    leafId: 'leaf',
    title: parentTabId,
    ...(ptyId ? { ptyId } : {}),
    isActive: false
  })
  return {
    worktree,
    publicationEpoch: 'renderer:current',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: 'peer-tab::leaf',
    activeTabType: 'terminal',
    tabGroups: [{ id: 'group', activeTabId: 'peer-tab', tabOrder: ['own-tab', 'peer-tab'] }],
    tabs: [
      terminal('own-tab', 'local-pty'),
      terminal('peer-tab', 'remote:studio@@handle'),
      terminal('web-terminal-host-tab', null)
    ]
  }
}

function parentIds(tabs: readonly { type: string }[]): string[] {
  return tabs.map((tab) => (tab as { parentTabId?: string }).parentTabId ?? '')
}

describe('runtime session inventory ownership', () => {
  it('does not promote a saved mirror stamped with a paired host into owned inventory (F1)', async () => {
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => sessionWithTab({ ptyId: null, executionHostId: 'runtime:peer' })
    } as never)
    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toEqual([])
  })

  it.each([
    ['legacy metadata', { ptyId: null }],
    ['an explicit local host', { ptyId: 'pty-1', executionHostId: 'local' as const }],
    ['a direct-SSH binding', { ptyId: 'ssh:ssh-1@@shell', executionHostId: 'ssh:ssh-1' as const }]
  ])('keeps a persisted terminal with %s (positive control)', async (_label, options) => {
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => sessionWithTab(options)
    } as never)
    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toHaveLength(1)
  })

  it.each([
    [null, 0],
    ['pty-1', 1]
  ])(
    'publishes only positively local terminals when repo records conflict (PTY %s)',
    async (ptyId, expected) => {
      const repos = [
        { id: 'repo', executionHostId: 'local', path: '/repo' },
        { id: 'repo', executionHostId: 'runtime:peer', path: '/repo' }
      ]
      const runtime = new OrcaRuntimeService({
        getWorkspaceSession: () => sessionWithTab({ ptyId }),
        getRepo: () => repos[0],
        getRepos: () => repos
      } as never)
      expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toHaveLength(expected)
    }
  )

  it('keeps a quarantined headless row in its own inventory without republishing it', async () => {
    const repos = [
      { id: 'repo', executionHostId: 'local', path: '/repo' },
      { id: 'repo', executionHostId: 'runtime:peer', path: '/repo' }
    ]
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => sessionWithTab({ ptyId: null }),
      getRepo: () => repos[0],
      getRepos: () => repos
    } as never)

    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toEqual([])
    // Why: like the desktop, the unverifiable row stays here (can't-verify), never dropped.
    const stored = (
      runtime as unknown as {
        mobileSessionTabsByWorktree: Map<string, { tabs: { parentTabId?: string }[] }>
      }
    ).mobileSessionTabsByWorktree.get(WORKTREE_ID)
    expect(stored?.tabs.map((tab) => tab.parentTabId)).toEqual(['tab'])
  })

  it('reads a host recorded on the worktree before the repo-level host list, as the desktop does', async () => {
    const repos = [
      { id: 'repo', executionHostId: 'local', path: '/repo' },
      { id: 'repo', executionHostId: 'runtime:peer', path: '/repo' }
    ]
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => sessionWithTab({ ptyId: null }),
      getRepo: () => repos[0],
      getRepos: () => repos,
      getWorktreeMeta: () => ({ hostId: 'local' })
    } as never)

    expect((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs).toHaveLength(1)
  })

  it('answers list, listAll and subscriptions with only owned surfaces', async () => {
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({ listProcesses: vi.fn(async () => []) } as never)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [rendererSnapshot()] })
    const frames: { tabs: { type: string }[]; activeTabId: string | null }[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => frames.push(snapshot))

    const [listed] = await runtime.listAllMobileSessionTabs()
    expect(parentIds(listed!.tabs)).toEqual(['own-tab'])
    expect(listed!.activeTabId).toBeNull()
    expect(listed!.tabGroups?.[0]?.tabOrder).toEqual(['own-tab'])
    expect(parentIds((await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).tabs)).toEqual([
      'own-tab'
    ])

    runtime.notifyMobileSessionTabsChanged(WORKTREE_ID)
    expect(frames.length).toBeGreaterThan(0)
    expect(frames.every((frame) => parentIds(frame.tabs).join() === 'own-tab')).toBe(true)
    unsubscribe()
  })

  it("publishes nothing for a paired runtime's workspace on any path", async () => {
    const repo = { id: 'repo', executionHostId: 'runtime:peer', path: '/repo' }
    const runtime = new OrcaRuntimeService({
      getWorkspaceSession: () => getDefaultWorkspaceSession(),
      getRepo: () => repo,
      getRepos: () => [repo]
    } as never)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [], mobileSessionTabs: [rendererSnapshot()] })
    const listener = vi.fn()
    const unsubscribe = runtime.onMobileSessionTabsChanged(listener)

    expect(await runtime.listAllMobileSessionTabs()).toEqual([])
    expect(await runtime.listMobileSessionTabs(`id:${WORKTREE_ID}`)).toEqual(
      expect.objectContaining({ publicationEpoch: 'none', snapshotVersion: 0, tabs: [] })
    )
    runtime.notifyMobileSessionTabsChanged(WORKTREE_ID)
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})
