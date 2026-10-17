// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import { emptySessionSidebarView } from '@/lib/session-sidebar-view'
import type { SessionSidebarGroup as GroupModel } from '@/lib/session-sidebar-tree'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { conversationViewKey } from '@/lib/conversation-view'
import {
  selectOnScreenSessionLeafId,
  selectOnScreenSessionTabId
} from '@/lib/sidebar-session-on-screen'
import { addSessionTestTab } from '@/lib/sidebar-session-test-fixtures'
import { onScreenTestWorkspace, unified, WT } from '@/lib/sidebar-session-on-screen-test-fixtures'
import { useSessionFolders } from '@/store/session-folders'
import { useSessionSidebarView } from '@/store/session-sidebar-view'
import { SessionSidebarGroup } from './SessionSidebarGroup'

vi.mock('@/components/next-step/add-next/AddNextPanels', () => ({
  AddNextPanels: () => <div role="menu">Legacy recipient menu</div>
}))

type Workspace = ReturnType<typeof onScreenTestWorkspace>

function renderWorkspace(state: Workspace, selectedKeys?: ReadonlySet<string>) {
  const group: GroupModel = {
    key: 'folder:one',
    kind: 'folder',
    label: 'Website',
    rows: buildSidebarSessions(state).map((session) => ({
      session,
      folderId: null,
      attention: null,
      state: null,
      waitingUntil: null
    })),
    collapsed: false,
    hidden: false,
    attentionCount: 0,
    canReorder: false,
    canHide: false
  }
  render(
    <TooltipProvider>
      <SessionSidebarGroup
        group={group}
        folders={[]}
        activeTabId={selectOnScreenSessionTabId(state)}
        activeLeafId={selectOnScreenSessionLeafId(state)}
        activeWorktreeId={state.activeWorktreeId ?? null}
        queuedRowKeys={new Set<string>()}
        selectedKeys={selectedKeys}
        onToggle={vi.fn()}
        onHide={vi.fn()}
        onMoveGroup={vi.fn()}
        onRenameFolder={vi.fn()}
        onDeleteFolder={vi.fn()}
        onOpen={vi.fn()}
        onMoveSessionKey={vi.fn()}
        onCancelQueue={vi.fn()}
      />
    </TooltipProvider>
  )
}

/** The tab ids of the rows marked current, in list order. */
function currentRows(state: Workspace): (string | null)[] {
  const byRowKey = new Map(buildSidebarSessions(state).map((row) => [row.rowKey, row.tabId]))
  return [...document.querySelectorAll<HTMLElement>('[data-session-row][data-current]')].map(
    (row) => byRowKey.get(row.dataset.sessionRow ?? '') ?? null
  )
}

beforeEach(() => {
  useSessionSidebarView.setState({
    view: emptySessionSidebarView(),
    archived: [],
    loaded: true,
    showHidden: false
  })
  useSessionFolders.setState({ metadata: emptySessionFolderMetadata(), loaded: true, error: null })
})

afterEach(cleanup)

describe('the row on the main screen is current', () => {
  it('marks a structured agent-session tab and not the stale last terminal', () => {
    const state = onScreenTestWorkspace('chat-1')
    renderWorkspace(state)
    expect(currentRows(state)).toEqual(['chat-1'])
  })

  it('marks the terminal row whose tab is in front', () => {
    const state = onScreenTestWorkspace('unified-b')
    renderWorkspace(state)
    expect(currentRows(state)).toEqual(['tab-b'])
  })

  it('moves to a newly launched tab and off the previous terminal', () => {
    const state = onScreenTestWorkspace('unified-a')
    const tab = addSessionTestTab(state, 'tab-new')
    tab.conversationLaunchPending = true
    state.unifiedTabsByWorktree[WT] = [
      ...state.unifiedTabsByWorktree[WT],
      unified('unified-new', 'tab-new', 'terminal')
    ]
    state.groupsByWorktree = {
      [WT]: [{ ...state.groupsByWorktree![WT][0], activeTabId: 'unified-new' }]
    }
    renderWorkspace(state)
    expect(currentRows(state)).toEqual(['tab-new'])
  })

  it('gives the current row its own accent bar and weight, over selection', () => {
    const state = onScreenTestWorkspace('unified-b')
    const keys = buildSidebarSessions(state).map(conversationViewKey)
    renderWorkspace(state, new Set(keys))
    const row = document.querySelector<HTMLElement>('[data-session-row][data-current]')!
    const classes = row.className.split(' ')
    expect(row.dataset.selected).toBeDefined()
    expect(classes).toContain('font-medium')
    expect(classes).toContain('shadow-[inset_2px_0_0_0_var(--worktree-sidebar-accent-foreground)]')
    expect(classes).toContain('bg-worktree-sidebar-accent')
    expect(classes).not.toContain('bg-worktree-sidebar-accent/60')
    const other = document.querySelector<HTMLElement>('[data-session-row]:not([data-current])')!
    expect(other.className).not.toContain('font-medium')
  })
})
