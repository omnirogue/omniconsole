import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { sanitizeWorkspaceSessionTerminalRetirements } from '../runtime/mobile-session-terminal-persistence-retirement'
import { retireDeletedTerminalTab } from './session-deleted-tab-retirement'

const WORKTREE_ID = 'repo::/worktree'
const REPO_ID = 'repo'

function terminalRow(id: string, sortOrder: number, isPinned = false) {
  return {
    id,
    ptyId: `pty-${id}`,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1,
    ...(isPinned ? { isPinned } : {})
  }
}

function terminalLayout(id: string) {
  return {
    root: { type: 'leaf' as const, leafId: 'leaf' },
    activeLeafId: 'leaf',
    expandedLeafId: null,
    ptyIdsByLeafId: { leaf: `pty-${id}` }
  }
}

function unifiedEntry(id: string, sortOrder: number) {
  return {
    id,
    entityId: id,
    groupId: 'group',
    worktreeId: WORKTREE_ID,
    contentType: 'terminal' as const,
    label: id,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

function savedSession(
  options: { revision?: number; ghostPinned?: boolean } = {}
): WorkspaceSessionState {
  const revision = options.revision ?? 3
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [terminalRow('ghost', 0, options.ghostPinned), terminalRow('keep', 1)]
    },
    terminalLayoutsByTabId: { ghost: terminalLayout('ghost'), keep: terminalLayout('keep') },
    unifiedTabs: { [WORKTREE_ID]: [unifiedEntry('ghost', 0), unifiedEntry('keep', 1)] },
    tabGroups: {
      [WORKTREE_ID]: [
        { id: 'group', worktreeId: WORKTREE_ID, activeTabId: 'ghost', tabOrder: ['ghost', 'keep'] }
      ]
    },
    sleepingAgentSessionsByPaneKey: {
      'ghost:leaf': {
        paneKey: 'ghost:leaf',
        tabId: 'ghost',
        worktreeId: WORKTREE_ID,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'session-1' },
        prompt: 'Do work',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1
      }
    },
    ...(revision > 0 ? { terminalTopologyRevisionByRepoId: { [REPO_ID]: revision } } : {})
  } as WorkspaceSessionState
}

/** The renderer save after closing `ghost` in memory: the row is gone, the revision is not. */
function rendererWriteWithoutGhost(session: WorkspaceSessionState): WorkspaceSessionState {
  return {
    ...session,
    tabsByWorktree: { [WORKTREE_ID]: [terminalRow('keep', 1)] },
    terminalLayoutsByTabId: { keep: terminalLayout('keep') }
  }
}

function fakeStore(initial: WorkspaceSessionState) {
  let current = initial
  const setWorkspaceSession = vi.fn((next: WorkspaceSessionState) => {
    current = next
  })
  return {
    getWorkspaceSession: () => current,
    setWorkspaceSession,
    current: () => current
  }
}

function tabIds(session: WorkspaceSessionState): string[] {
  return (session.tabsByWorktree[WORKTREE_ID] ?? []).map((tab) => tab.id)
}

describe('retireDeletedTerminalTab', () => {
  it('pins the root cause: a renderer save cannot drop a row main owns', () => {
    const prior = savedSession()
    const afterWrite = sanitizeWorkspaceSessionTerminalRetirements(
      rendererWriteWithoutGhost(prior),
      prior
    )
    expect(tabIds(afterWrite)).toContain('ghost')
  })

  it('retires the saved row, its layout, unified entry and sleeping record', () => {
    const store = fakeStore(savedSession())

    expect(retireDeletedTerminalTab(store, 'ghost')).toBe(true)

    const saved = store.current()
    expect(store.setWorkspaceSession).toHaveBeenCalledTimes(1)
    expect(tabIds(saved)).toEqual(['keep'])
    expect(saved.terminalLayoutsByTabId.ghost).toBeUndefined()
    expect(saved.unifiedTabs?.[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['keep'])
    expect(saved.sleepingAgentSessionsByPaneKey?.['ghost:leaf']).toBeUndefined()
    expect(saved.terminalTopologyRevisionByRepoId?.[REPO_ID]).toBe(4)
  })

  it('keeps the row retired against a stale renderer write that still lists it', () => {
    const stale = savedSession()
    const store = fakeStore(stale)
    retireDeletedTerminalTab(store, 'ghost')

    const afterStaleWrite = sanitizeWorkspaceSessionTerminalRetirements(stale, store.current())
    expect(tabIds(afterStaleWrite)).toEqual(['keep'])
  })

  it('does nothing when the tab is already gone', () => {
    const store = fakeStore(savedSession())

    expect(retireDeletedTerminalTab(store, 'missing')).toBe(false)
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
  })

  it('leaves repos at revision 0 to the renderer save', () => {
    const store = fakeStore(savedSession({ revision: 0 }))

    expect(retireDeletedTerminalTab(store, 'ghost')).toBe(false)
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
  })

  it('refuses a pinned row', () => {
    const store = fakeStore(savedSession({ ghostPinned: true }))

    expect(retireDeletedTerminalTab(store, 'ghost')).toBe(false)
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
  })
})
