/**
 * `isTerminalPaneClosedHere` reads a pane closed only when nothing on this computer names it: the
 * pane graph is settled, no live tab or leaf holds it, and the saved workspace session a restart
 * restores from has no tab with its id. Every doubt reads open.
 */
import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { OrcaRuntimeService } from './omni-runtime'

const WORKTREE_ID = 'repo-1::/tmp/pane-closed'
const TAB_ID = 'tab-closed'
const LEAF_ID = '6f1c2a4e-8b3d-4c5e-9f7a-1b2c3d4e5f60'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

function harness(savedTab: boolean) {
  const session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: savedTab
      ? {
          [WORKTREE_ID]: [
            {
              id: TAB_ID,
              ptyId: null,
              worktreeId: WORKTREE_ID,
              title: 'Claude',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      : {}
  }
  const runtime = new OrcaRuntimeService({
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn(),
    getRepos: vi.fn(() => [
      {
        id: 'repo-1',
        path: '/tmp/pane-closed',
        displayName: 'pane-closed',
        badgeColor: '#000000',
        addedAt: 0
      }
    ]),
    getAllWorktreeMeta: vi.fn(() => ({})),
    getWorktreeMeta: vi.fn(() => undefined),
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: vi.fn(),
    getSettings: vi.fn(() => ({ workspaceDir: '/tmp/workspaces' })),
    getProjects: vi.fn(() => [])
  } as never)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    hasPty: () => false,
    listProcesses: vi.fn(async () => []),
    getForegroundProcess: async () => null
  } as never)
  return runtime
}

const openTab = {
  tabs: [
    { tabId: TAB_ID, worktreeId: WORKTREE_ID, title: null, activeLeafId: LEAF_ID, layout: null }
  ],
  leaves: [
    { tabId: TAB_ID, worktreeId: WORKTREE_ID, leafId: LEAF_ID, paneRuntimeId: 1, ptyId: null }
  ]
}

describe('isTerminalPaneClosedHere', () => {
  it('reads closed when the settled graph and the saved session both lack the tab', () => {
    const runtime = harness(false)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    expect(runtime.isTerminalPaneClosedHere(PANE_KEY, WORKTREE_ID)).toBe(true)
  })

  it('reads open before the pane graph has been published (panes not restored yet)', () => {
    const runtime = harness(false)
    expect(runtime.isTerminalPaneClosedHere(PANE_KEY, WORKTREE_ID)).toBe(false)
  })

  it('reads open while the live graph still has the tab, even with no PTY in it', () => {
    const runtime = harness(true)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, openTab as never)
    expect(runtime.isTerminalPaneClosedHere(PANE_KEY, WORKTREE_ID)).toBe(false)
  })

  it('reads open while the saved session still has the tab a restore would bring back', () => {
    const runtime = harness(true)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    expect(runtime.isTerminalPaneClosedHere(PANE_KEY, WORKTREE_ID)).toBe(false)
  })

  it('reads open for a pane key it cannot parse', () => {
    const runtime = harness(false)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    expect(runtime.isTerminalPaneClosedHere('not-a-pane', WORKTREE_ID)).toBe(false)
  })
})
