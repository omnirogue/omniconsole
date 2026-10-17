import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { SidebarSessionSource } from './sidebar-sessions'
import type { OnScreenSessionSource } from './sidebar-session-on-screen'
import {
  addSessionTestTab,
  SESSION_TEST_WORKTREE,
  sessionTestSource
} from './sidebar-session-test-fixtures'

export const WT = SESSION_TEST_WORKTREE
export const SECOND_LEAF = '00000000-0000-4000-8000-000000000002'

export function unified(id: string, entityId: string, contentType: Tab['contentType']): Tab {
  return {
    id,
    entityId,
    groupId: 'group-1',
    worktreeId: WT,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

/** Two terminal tabs and a structured chat, all in one group; `front` is the group's active tab. */
export function onScreenTestWorkspace(front: string): SidebarSessionSource & OnScreenSessionSource {
  const source = sessionTestSource()
  addSessionTestTab(source, 'tab-a')
  addSessionTestTab(source, 'tab-b')
  source.unifiedTabsByWorktree[WT] = [
    unified('unified-a', 'tab-a', 'terminal'),
    unified('unified-b', 'tab-b', 'terminal'),
    { ...unified('chat-1', 'agent-entity-1', 'agent-session'), agentSessionAgent: 'claude' },
    unified('/repo/readme.md', '/repo/readme.md', 'editor')
  ]
  const group: TabGroup = {
    id: 'group-1',
    worktreeId: WT,
    activeTabId: front,
    tabOrder: ['unified-a', 'unified-b', 'chat-1', '/repo/readme.md']
  }
  return {
    ...source,
    activeView: 'terminal',
    activeWorktreeId: WT,
    // Why stale on purpose: the store's terminal-only id keeps pointing at the last terminal.
    activeTabId: 'tab-a',
    activeTabType: 'terminal',
    groupsByWorktree: { [WT]: [group] },
    activeGroupIdByWorktree: { [WT]: 'group-1' }
  }
}
