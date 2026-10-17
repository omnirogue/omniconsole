import { describe, expect, it } from 'vitest'
import type { AgentPaneCard } from '@/components/attention/agent-pane-snapshot'
import { emptySessionFolderMetadata } from './session-folders'
import { emptySessionSidebarView } from './session-sidebar-view'
import { buildSessionSidebarTree, type SessionSidebarTreeInput } from './session-sidebar-tree'
import {
  createSessionSidebarRowCache,
  readSessionSidebarRowStats,
  resetSessionSidebarRowStats,
  type SessionSidebarRowCache
} from './session-sidebar-row-cache'
import type { SidebarSession } from './sidebar-sessions'

const NOW = Date.UTC(2026, 8, 15, 12)
const SESSIONS = 500

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
  extra: Partial<SessionSidebarTreeInput> = {}
): SessionSidebarTreeInput {
  return {
    now: NOW,
    sessions,
    metadata: emptySessionFolderMetadata(),
    view: emptySessionSidebarView(),
    snapshot: { cardsByPaneKey: cards, cardsByTabId: new Map(), attentionByPaneKey: new Map() },
    query: '',
    showHidden: false,
    ...extra
  }
}

const sessions = Array.from({ length: SESSIONS }, (_, index) => session(index))

function workingCards(): Map<string, AgentPaneCard> {
  return new Map(sessions.map((entry) => [entry.paneKey!, card(entry.paneKey!, 'working')]))
}

/** Build once so the cache is warm, then measure only what the second build costs. */
function warm(cache: SessionSidebarRowCache, cards: ReadonlyMap<string, AgentPaneCard>): void {
  buildSessionSidebarTree(input(sessions, cards, { rowCache: cache }))
  resetSessionSidebarRowStats()
}

describe('session sidebar row cache at 500 sessions', () => {
  it('classifies every row on the first build and none of them twice', () => {
    const cache = createSessionSidebarRowCache()
    resetSessionSidebarRowStats()
    buildSessionSidebarTree(input(sessions, workingCards(), { rowCache: cache }))
    expect(readSessionSidebarRowStats()).toMatchObject({ computed: SESSIONS, reused: 0 })
  })

  it('classifies only the row whose pane status changed', () => {
    const cache = createSessionSidebarRowCache()
    const cards = workingCards()
    warm(cache, cards)

    const pinged = new Map(cards)
    const target = sessions[499]!.paneKey!
    pinged.set(target, card(target, 'idle'))
    buildSessionSidebarTree(input(sessions, pinged, { rowCache: cache }))

    // Why this and not a render count: structural sharing already hid the cost from React,
    // so the lane's whole point is that 499 rows are never classified again.
    expect(readSessionSidebarRowStats()).toMatchObject({ computed: 1, reused: SESSIONS - 1 })
  })

  it('classifies no row when only the clock moved', () => {
    const cache = createSessionSidebarRowCache()
    const cards = workingCards()
    warm(cache, cards)

    buildSessionSidebarTree(input(sessions, cards, { rowCache: cache, now: NOW + 60_000 }))
    expect(readSessionSidebarRowStats()).toMatchObject({ computed: 0, reused: SESSIONS })
  })

  it('still follows the clock for a row that can wake on it', () => {
    const cache = createSessionSidebarRowCache()
    const cards = workingCards()
    const waiting = new Map([[sessions[7]!.paneKey!, new Date(NOW + 30_000).toISOString()]])
    buildSessionSidebarTree(
      input(sessions, cards, { rowCache: cache, waitingUntilByPaneKey: waiting })
    )
    resetSessionSidebarRowStats()

    buildSessionSidebarTree(
      input(sessions, cards, {
        rowCache: cache,
        waitingUntilByPaneKey: waiting,
        now: NOW + 60_000
      })
    )
    // Why: a snoozed row's group really does change with the clock, so it must recompute.
    expect(readSessionSidebarRowStats()).toMatchObject({ computed: 1, reused: SESSIONS - 1 })
  })

  it('builds exactly the tree an uncached build would', () => {
    const cards = workingCards()
    const pinged = new Map(cards)
    const target = sessions[499]!.paneKey!
    pinged.set(target, card(target, 'done'))
    const cache = createSessionSidebarRowCache()
    buildSessionSidebarTree(input(sessions, cards, { rowCache: cache }))

    const shape = (tree: ReturnType<typeof buildSessionSidebarTree>) =>
      tree.groups.map((group) => [
        group.key,
        group.rows.map((row) => [
          row.session.rowKey,
          row.state,
          row.archived,
          row.completed?.reason
        ])
      ])
    expect(shape(buildSessionSidebarTree(input(sessions, pinged, { rowCache: cache })))).toEqual(
      shape(buildSessionSidebarTree(input(sessions, pinged)))
    )
  })
})
