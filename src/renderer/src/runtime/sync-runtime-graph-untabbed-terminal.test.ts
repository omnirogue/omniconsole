import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import { makeState } from './sync-runtime-graph-test-harness'
import type { AppState } from '../store/types'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'

const FOLDER = 'folder:studio-folder'
const LEAF = '11111111-1111-4111-8111-111111111111'

function terminal(id: string, ptyId: string | null): TerminalTab {
  return {
    id,
    worktreeId: FOLDER,
    ptyId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function unified(entityId: string): Tab {
  return {
    id: entityId,
    entityId,
    groupId: 'group-1',
    worktreeId: FOLDER,
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  } as Tab
}

function withLayouts(...ids: string[]): AppState['terminalLayoutsByTabId'] {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      { root: { type: 'leaf', leafId: LEAF }, activeLeafId: LEAF, expandedLeafId: null }
    ])
  ) as AppState['terminalLayoutsByTabId']
}

describe('terminals this host keeps without a tab-strip entry', () => {
  it('publishes them and places them in a group so a paired computer can mirror them', () => {
    const mirror = toWebTerminalSurfaceTabId('macbook-tab')
    const state = makeState({
      folderWorkspaces: [{ id: 'studio-folder' }] as unknown as AppState['folderWorkspaces'],
      tabsByWorktree: {
        [FOLDER]: [
          terminal('tabbed', 'daemon-pty-1'),
          terminal('untabbed-live', 'daemon-pty-2'),
          terminal('untabbed-dormant', null),
          terminal(mirror, 'remote:macbook@@handle-1')
        ]
      },
      terminalLayoutsByTabId: withLayouts('tabbed', 'untabbed-live', 'untabbed-dormant', mirror),
      groupsByWorktree: {
        [FOLDER]: [{ id: 'group-1', activeTabId: 'tabbed', tabOrder: ['tabbed'] }]
      } as unknown as AppState['groupsByWorktree'],
      activeGroupIdByWorktree: { [FOLDER]: 'group-1' },
      unifiedTabsByWorktree: { [FOLDER]: [unified('tabbed')] }
    })

    const snapshot = buildMobileSessionTabSnapshots(state).find((s) => s.worktree === FOLDER)

    // Why: before the fix only 'tabbed' was published, and the paired computer read the live
    // 'untabbed-live' PTY as missing from the frame and dropped every update for the folder.
    expect(
      snapshot?.tabs.map((tab) => (tab.type === 'terminal' ? tab.parentTabId : tab.id))
    ).toEqual(['tabbed', 'untabbed-live', 'untabbed-dormant'])
    expect(snapshot?.tabGroups).toEqual([
      {
        id: 'group-1',
        activeTabId: 'tabbed',
        tabOrder: ['tabbed', 'untabbed-live', 'untabbed-dormant'],
        recentTabIds: []
      }
    ])
  })
})
