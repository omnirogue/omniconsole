import { describe, expect, it } from 'vitest'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import { EMPTY_AGENT_PANE_SNAPSHOT } from '@/components/attention/agent-pane-snapshot'
import type { SidebarSession } from './sidebar-sessions'
import { sortTechnicalSidebarSessions } from './technical-sidebar-sessions'

function session(overrides: Partial<SidebarSession> & { rowKey: string }): SidebarSession {
  return {
    sessionKey: null,
    worktreeId: 'wt-1',
    hostId: null,
    tabId: null,
    paneKey: null,
    kind: 'terminal',
    label: overrides.rowKey,
    workspaceLabel: 'Repo / wt-1',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

function card(overrides: Partial<AgentPaneCard> & { paneKey: string }): AgentPaneCard {
  return {
    worktreeId: 'wt-1',
    tabId: 'tab-1',
    leafId: null,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    unseen: false,
    title: '',
    stateChangedAt: 0,
    repoName: 'Repo',
    worktreeName: 'wt-1',
    ...overrides
  }
}

describe('sortTechnicalSidebarSessions', () => {
  it('puts needs-you first, then working, then the untouched rest — names only break ties', () => {
    const done = session({ rowKey: 'done', paneKey: 'pane-done' })
    const working = session({ rowKey: 'working', paneKey: 'pane-working' })
    const needsYou = session({ rowKey: 'needs-you', paneKey: 'pane-blocked' })
    const idle = session({ rowKey: 'idle', paneKey: 'pane-idle' })

    const snapshot = {
      ...EMPTY_AGENT_PANE_SNAPSHOT,
      cardsByPaneKey: new Map([
        ['pane-done', card({ paneKey: 'pane-done', bucket: 'done', dotState: 'done' })],
        ['pane-working', card({ paneKey: 'pane-working', bucket: 'working', dotState: 'working' })],
        [
          'pane-blocked',
          card({ paneKey: 'pane-blocked', bucket: 'attention', dotState: 'blocked' })
        ],
        ['pane-idle', card({ paneKey: 'pane-idle', bucket: 'idle', dotState: 'idle' })]
      ]),
      attentionByPaneKey: new Map<string, AttentionPane>([
        [
          'pane-blocked',
          {
            ...card({ paneKey: 'pane-blocked', bucket: 'attention', dotState: 'blocked' }),
            cause: 'blocked',
            portalPaneKey: 'pane-blocked'
          }
        ]
      ])
    }

    const sorted = sortTechnicalSidebarSessions(
      [done, working, needsYou, idle],
      snapshot,
      new Map()
    )

    // Why: an idle pane ranks with active (no agent executing); a finished one sorts after it.
    expect(sorted.map((row) => row.rowKey)).toEqual(['needs-you', 'working', 'idle', 'done'])
  })

  it('breaks ties alphabetically by workspace, then label, then row key', () => {
    const b = session({ rowKey: 'b', label: 'Bravo', workspaceLabel: 'Same' })
    const a = session({ rowKey: 'a', label: 'Alpha', workspaceLabel: 'Same' })

    const sorted = sortTechnicalSidebarSessions([b, a], EMPTY_AGENT_PANE_SNAPSHOT, new Map())

    expect(sorted.map((row) => row.rowKey)).toEqual(['a', 'b'])
  })

  it('treats a pane with a pending wait-until as waiting, sorted after the untouched rest', () => {
    const untouched = session({ rowKey: 'untouched', paneKey: 'pane-untouched' })
    const waiting = session({ rowKey: 'waiting', paneKey: 'pane-waiting' })

    const sorted = sortTechnicalSidebarSessions(
      [waiting, untouched],
      EMPTY_AGENT_PANE_SNAPSHOT,
      new Map([['pane-waiting', '2026-09-13T00:00:00.000Z']])
    )

    expect(sorted.map((row) => row.rowKey)).toEqual(['untouched', 'waiting'])
  })
})
