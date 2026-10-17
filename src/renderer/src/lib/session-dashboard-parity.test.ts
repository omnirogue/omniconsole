import { expect, it } from 'vitest'
import { buildDashboardSnapshot } from '@/components/dashboard/build-dashboard-snapshot'
import { buildAgentPaneSnapshot } from '@/components/attention/agent-pane-snapshot'
import {
  ATTENTION_FIXTURE_NOW as now,
  ATTENTION_FIXTURE_PANE_A as paneKey,
  attentionFixtureEntry,
  attentionFixtureInputs
} from '@/components/attention/attention-test-fixtures'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import { emptySessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'
import type { SidebarSession } from './sidebar-sessions'
const session: SidebarSession = {
  rowKey: 'row',
  sessionKey: 'session',
  worktreeId: 'w1',
  hostId: 'local',
  tabId: 'tab-a',
  paneKey,
  kind: 'terminal',
  label: 'Shared runtime',
  workspaceLabel: 'Repo',
  agent: 'codex',
  unavailable: false,
  folderKeyMigration: null
}
it.each([
  ['working', 'working', 'workspace'],
  ['waiting', 'attention', 'attention'],
  ['blocked', 'attention', 'attention'],
  ['done', 'done', 'completed']
] as const)(
  'projects %s from the same dashboard snapshot into the sidebar',
  (state, bucket, group) => {
    const inputs = attentionFixtureInputs({
      agentStatusByPaneKey: {
        [paneKey]: attentionFixtureEntry(paneKey, 'tab-a', 'w1', {
          state,
          updatedAt: now,
          stateStartedAt: now - 1000
        })
      }
    })
    const dashboard = buildDashboardSnapshot(inputs, now)
    const snapshot = buildAgentPaneSnapshot(inputs, now)
    expect(dashboard.cards.find((card) => card.paneKey === paneKey)?.bucket).toBe(bucket)
    expect(snapshot.cardsByPaneKey.get(paneKey)?.bucket).toBe(bucket)
    const tree = buildSessionSidebarTree({
      sessions: [session],
      metadata: emptySessionFolderMetadata(),
      view: emptySessionSidebarView(),
      snapshot,
      now,
      query: '',
      showHidden: false
    })
    expect(tree.groups.find((entry) => entry.kind === group)?.rows[0]?.session.rowKey).toBe('row')
    if (state === 'done') {
      expect(tree.groups.some((entry) => entry.kind === 'workspace')).toBe(false)
      const later = buildSessionSidebarTree({
        sessions: [session],
        metadata: emptySessionFolderMetadata(),
        view: emptySessionSidebarView(),
        snapshot,
        now: now + 7 * 24 * 60 * 60 * 1000,
        query: '',
        showHidden: false
      })
      // Why: age never archives by itself; a week later the finished row is still listed under Done.
      expect(later.groups.find((entry) => entry.kind === 'completed')?.rows).toHaveLength(1)
      expect(later.archivedCount).toBe(0)
    }
  }
)
