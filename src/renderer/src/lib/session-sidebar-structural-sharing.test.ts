import { describe, expect, it } from 'vitest'
import type { AgentPaneCard } from '@/components/attention/agent-pane-snapshot'
import { emptySessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'
import { buildSessionSidebarTree, type SessionSidebarTreeInput } from './session-sidebar-tree'
import {
  shareSessionSidebarGroups,
  shareSidebarSessions
} from './session-sidebar-structural-sharing'
import type { SidebarSession } from './sidebar-sessions'

const NOW = Date.UTC(2026, 8, 15, 12)

function session(index: number): SidebarSession {
  const id = String(index).padStart(3, '0')
  return {
    rowKey: `row-${id}`,
    sessionKey: `session-${id}`,
    worktreeId: 'w1',
    hostId: 'local',
    tabId: `tab-${id}`,
    paneKey: `tab-${id}:leaf`,
    kind: 'terminal',
    label: `Session ${id}`,
    workspaceLabel: 'Website / main',
    agent: 'codex',
    unavailable: false,
    folderKeyMigration: null
  }
}

function card(paneKey: string, bucket: AgentPaneCard['bucket']): AgentPaneCard {
  return {
    paneKey,
    worktreeId: 'w1',
    tabId: paneKey.split(':')[0]!,
    leafId: 'leaf',
    agentType: 'codex',
    bucket,
    dotState: bucket === 'working' ? 'working' : bucket === 'done' ? 'done' : 'idle',
    unseen: false,
    title: 'task',
    stateChangedAt: NOW - 1_000,
    repoName: 'Website',
    worktreeName: 'main'
  }
}

function input(
  sessions: readonly SidebarSession[],
  cards: ReadonlyMap<string, AgentPaneCard>,
  now = NOW
): SessionSidebarTreeInput {
  return {
    now,
    sessions,
    metadata: emptySessionFolderMetadata(),
    view: emptySessionSidebarView(),
    snapshot: { cardsByPaneKey: cards, cardsByTabId: new Map(), attentionByPaneKey: new Map() },
    query: '',
    showHidden: false
  }
}

function allCards(sessions: readonly SidebarSession[]): Map<string, AgentPaneCard> {
  return new Map(sessions.map((entry) => [entry.paneKey!, card(entry.paneKey!, 'working')]))
}

describe('sidebar session sharing', () => {
  it('returns the previous array when a rebuild changed nothing', () => {
    const previous = [session(1), session(2)]
    const rebuilt = [session(1), session(2)]
    expect(shareSidebarSessions(previous, rebuilt)).toBe(previous)
  })

  it('keeps unchanged sessions and swaps only the one whose label changed', () => {
    const previous = [session(1), session(2)]
    const renamed = { ...session(2), label: 'Renamed' }
    const shared = shareSidebarSessions(previous, [session(1), renamed])
    expect(shared).not.toBe(previous)
    expect(shared[0]).toBe(previous[0])
    expect(shared[1]).toBe(renamed)
  })
})

describe('session sidebar tree at scale', () => {
  it('builds 500 rows quickly and a status ping changes exactly one row object', () => {
    const sessions = Array.from({ length: 500 }, (_, index) => session(index))
    const cards = allCards(sessions)
    const started = performance.now()
    const first = buildSessionSidebarTree(input(sessions, cards))
    const elapsed = performance.now() - started
    expect(first.totalRows).toBe(500)
    expect(first.groups.flatMap((group) => group.rows)).toHaveLength(500)
    // Why: generous for a loaded CI box; the build is linear and runs in a few ms locally.
    expect(elapsed).toBeLessThan(1_000)

    const pinged = new Map(cards)
    const target = sessions[499]!.paneKey!
    pinged.set(target, card(target, 'done'))
    const second = shareSessionSidebarGroups(
      first.groups,
      buildSessionSidebarTree(input(sessions, pinged)).groups
    )
    const before = new Map(
      first.groups.flatMap((group) => group.rows).map((row) => [row.session.rowKey, row] as const)
    )
    const changed = second
      .flatMap((group) => group.rows)
      .filter((row) => before.get(row.session.rowKey) !== row)
      .map((row) => row.session.rowKey)
    expect(changed).toEqual(['row-499'])
  })

  it('keeps the whole tree identical across a minute tick that moves no row', () => {
    const sessions = Array.from({ length: 500 }, (_, index) => session(index))
    const cards = allCards(sessions)
    const first = buildSessionSidebarTree(input(sessions, cards)).groups
    const ticked = buildSessionSidebarTree(input(sessions, cards, NOW + 60_000)).groups
    expect(ticked).not.toBe(first)
    expect(shareSessionSidebarGroups(first, ticked)).toBe(first)
  })
})
