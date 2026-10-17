import { sessionOverviewActivities } from './session-overview-activities'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'
import { describe, expect, it } from 'vitest'
import type { SidebarSession } from './sidebar-sessions'
import { sessionActivities } from '@/components/work/work-model'
import type { AgentPaneCard } from '@/components/attention/agent-pane-snapshot'
import { sessionOverviewCounts } from './session-overview-counts'
import { waitLaterKeyForPane } from './wait-later'
const now = new Date(2026, 9, 9, 12).getTime()
const row = (id: string): SidebarSession => ({
  rowKey: id,
  sessionKey: id,
  paneKey: id,
  tabId: id,
  hostId: 'local',
  worktreeId: 'wt',
  kind: 'terminal',
  agent: 'codex',
  label: id,
  workspaceLabel: 'Workspace',
  unavailable: false,
  folderKeyMigration: null
})
const card = (paneKey: string, bucket: AgentPaneCard['bucket'], at: number): AgentPaneCard =>
  ({ paneKey, bucket, stateChangedAt: at }) as AgentPaneCard
describe('session overview counts', () => {
  it('classifies a chat-only row from pushed structured status without changing its placement identity', () => {
    const session = {
      ...row('chat'),
      kind: 'structured' as const,
      paneKey: null,
      tabId: 'structured-agent-session-chat',
      structuredSessionId: 'chat'
    }
    const sourceKey = structuredAgentSessionPaneKey(session.tabId, 'chat')
    const rows = sessionOverviewActivities(
      [session],
      { cardsByPaneKey: new Map([[sourceKey, card(sourceKey, 'working', now)]]) },
      new Set(),
      {},
      new Map()
    )
    expect(rows[0]?.state).toBe('working')
    expect(rows[0]?.session).toBe(session)
    expect(rows[0]?.session.paneKey).toBeNull()
  })
  it('uses the shared activity classification and counts only completions today', () => {
    const sessions = ['needs', 'work', 'wait', 'today', 'yesterday', 'idle'].map(row)
    const snapshot = {
      cardsByPaneKey: new Map(
        [
          card('needs', 'attention', now),
          card('work', 'working', now),
          card('wait', 'working', now),
          card('today', 'done', now - 1000),
          card('yesterday', 'done', now - 86400000)
        ].map((entry) => [entry.paneKey, entry])
      )
    }
    const rows = sessionActivities(
      sessions,
      snapshot,
      new Set([waitLaterKeyForPane('wait')]),
      {},
      new Map()
    )
    expect(sessionOverviewCounts(rows, new Map(), now)).toEqual({
      'needs-you': 1,
      working: 1,
      waiting: 1,
      doneToday: 1,
      idle: 1
    })
  })
  it('honors explicit finished marks and excludes future dates', () => {
    const sessions = ['marked', 'future'].map(row)
    const finished = new Map([
      [waitLaterKeyForPane('marked'), now - 1000],
      [waitLaterKeyForPane('future'), now + 1000]
    ])
    const rows = sessionActivities(sessions, { cardsByPaneKey: new Map() }, new Set(), {}, finished)
    expect(sessionOverviewCounts(rows, finished, now).doneToday).toBe(1)
  })
})
