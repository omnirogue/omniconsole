import { describe, expect, it } from 'vitest'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import {
  sameSessionSidebarTreeSnapshot,
  type SessionSidebarTreeSnapshot
} from './session-sidebar-tree-snapshot'

function card(overrides: Partial<AgentPaneCard> = {}): AgentPaneCard {
  return {
    paneKey: 'tab-1:leaf',
    worktreeId: 'w1',
    tabId: 'tab-1',
    leafId: 'leaf',
    agentType: 'codex',
    bucket: 'working',
    dotState: 'working',
    unseen: false,
    title: 'Session one',
    stateChangedAt: 1_000,
    repoName: 'Project A',
    worktreeName: 'main',
    ...overrides
  } as AgentPaneCard
}

function snapshot(
  cards: AgentPaneCard[],
  attention: AttentionPane[] = []
): SessionSidebarTreeSnapshot {
  return {
    cardsByPaneKey: new Map(cards.map((entry) => [entry.paneKey, entry])),
    cardsByTabId: new Map(cards.map((entry) => [entry.tabId, [entry]])),
    attentionByPaneKey: new Map(attention.map((pane) => [pane.paneKey, pane]))
  }
}

describe('session sidebar tree snapshot', () => {
  it('ignores pings that only move fields the tree never reads', () => {
    // Why: token counts, unseen flags and titles ping constantly; none of them group a row.
    expect(
      sameSessionSidebarTreeSnapshot(
        snapshot([card()]),
        snapshot([card({ unseen: true, title: 'Renamed' })])
      )
    ).toBe(true)
  })

  it("reports a change when a pane's state, bucket or wait time moves", () => {
    expect(
      sameSessionSidebarTreeSnapshot(snapshot([card()]), snapshot([card({ dotState: 'idle' })]))
    ).toBe(false)
    expect(
      sameSessionSidebarTreeSnapshot(snapshot([card()]), snapshot([card({ bucket: 'done' })]))
    ).toBe(false)
    expect(
      sameSessionSidebarTreeSnapshot(
        snapshot([card()]),
        snapshot([card({ stateChangedAt: 2_000 })])
      )
    ).toBe(false)
  })

  it('reports a change when a pane appears, disappears or starts asking', () => {
    expect(sameSessionSidebarTreeSnapshot(snapshot([card()]), snapshot([]))).toBe(false)
    const asking = { ...card(), cause: 'blocked', portalPaneKey: 'tab-1:leaf' } as AttentionPane
    expect(sameSessionSidebarTreeSnapshot(snapshot([card()]), snapshot([card()], [asking]))).toBe(
      false
    )
    expect(
      sameSessionSidebarTreeSnapshot(snapshot([card()], [asking]), snapshot([card()], [asking]))
    ).toBe(true)
  })
})

it.each([
  { workingMode: 'monitoring' as const },
  { activityUnverifiable: true },
  { stopped: 'failed' as const },
  { unreadCompletion: true }
])('invalidates the tree when execution evidence changes: %j', (patch) => {
  expect(sameSessionSidebarTreeSnapshot(snapshot([card()]), snapshot([card(patch)]))).toBe(false)
})
