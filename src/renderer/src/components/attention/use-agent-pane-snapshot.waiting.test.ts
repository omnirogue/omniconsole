import { describe, expect, it } from 'vitest'
import type { AgentPaneSnapshot, AttentionPane } from './agent-pane-snapshot'
import { withoutWaitingPanes } from './use-agent-pane-snapshot'

function pane(paneKey: string, stateChangedAt: number): AttentionPane {
  return {
    paneKey,
    portalPaneKey: paneKey,
    worktreeId: 'folder:f1',
    tabId: paneKey.split(':')[0]!,
    leafId: 'leaf',
    agentType: 'claude',
    bucket: 'attention',
    dotState: 'waiting',
    cause: 'waiting',
    unseen: true,
    title: paneKey,
    stateChangedAt,
    repoName: 'W',
    worktreeName: 'main'
  }
}

function snapshot(panes: AttentionPane[]): AgentPaneSnapshot {
  return {
    cards: panes,
    cardsByPaneKey: new Map(panes.map((entry) => [entry.paneKey, entry])),
    cardsByTabId: new Map(),
    attention: panes,
    attentionByPaneKey: new Map(panes.map((entry) => [entry.paneKey, entry])),
    attentionWorktreeIds: new Set(panes.map((entry) => entry.worktreeId))
  }
}

describe('withoutWaitingPanes', () => {
  it('drops waiting panes and finished panes that have not asked again; cards stay', () => {
    const before = snapshot([pane('a:1', 1_000), pane('b:1', 1_000), pane('c:1', 5_000)])
    const after = withoutWaitingPanes(
      before,
      new Set(['pane:a:1']),
      new Map([
        ['pane:b:1', 2_000],
        ['pane:c:1', 2_000]
      ])
    )
    expect(after.attention.map((entry) => entry.paneKey)).toEqual(['c:1'])
    expect([...after.attentionByPaneKey.keys()]).toEqual(['c:1'])
    expect(after.cards).toHaveLength(3)
  })

  it('returns the same snapshot when nothing waits or finished', () => {
    const before = snapshot([pane('a:1', 1)])
    expect(withoutWaitingPanes(before, new Set(), new Map())).toBe(before)
    expect(withoutWaitingPanes(before, new Set(['pane:z']), new Map([['pane:y', 9]]))).toBe(before)
  })
})
