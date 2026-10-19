import { describe, expect, it } from 'vitest'
import type { AgentPaneCard, AttentionPane } from '@/components/attention/agent-pane-snapshot'
import {
  emptySessionFolderMetadata,
  migrateSessionFolderKey,
  moveSessionToFolder,
  SAVED_SESSIONS_FOLDER_ID,
  type SessionFolderMetadata
} from './session-folders'
import { isAgentSession } from './agent-session-note'
import { buildSessionSidebarTree } from './session-sidebar-tree'
import { emptySessionSidebarView } from './session-sidebar-view'
import { SESSION_WORKERS_GROUP_KEY } from './session-sidebar-worker-keys'
import type { SidebarSession } from './sidebar-sessions'

// Sal, 2026-10-19: "agent sessions [are] separate from human sessions and human started sessions
// stay open until we close them."

const FOLDER_ID = '00000000-0000-4000-8000-000000000001'
const leaf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function session(key: string, n: number, overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    rowKey: key,
    sessionKey: key,
    worktreeId: 'w1',
    hostId: 'local',
    tabId: `tab-${n}`,
    paneKey: `tab-${n}:${leaf(n)}`,
    kind: 'terminal',
    label: key,
    workspaceLabel: 'Website / main',
    agent: 'claude',
    unavailable: false,
    folderKeyMigration: null,
    ...overrides
  }
}

function card(paneKey: string, bucket: AgentPaneCard['bucket']): AgentPaneCard {
  return {
    paneKey,
    worktreeId: 'w1',
    tabId: paneKey.split(':')[0]!,
    leafId: paneKey.split(':')[1] ?? null,
    agentType: 'claude',
    bucket,
    dotState: bucket === 'attention' ? 'waiting' : 'working',
    unseen: false,
    title: 'task',
    stateChangedAt: 10,
    repoName: 'Website',
    worktreeName: 'main'
  }
}

const mine = session('mine', 1)
const launched = session('launched', 2)
const asking = session('asking', 3)

function withAgents(
  keys: string[],
  metadata: SessionFolderMetadata = emptySessionFolderMetadata()
): SessionFolderMetadata {
  return { ...metadata, agentSessions: Object.fromEntries(keys.map((key) => [key, 1])) }
}

function build(
  metadata: SessionFolderMetadata,
  sessions: SidebarSession[] = [mine, launched],
  attentionKeys: string[] = []
) {
  const attention = new Map<string, AttentionPane>(
    sessions
      .filter((row) => attentionKeys.includes(row.rowKey))
      .map((row) => [
        row.paneKey!,
        { ...card(row.paneKey!, 'attention'), cause: 'waiting', portalPaneKey: row.paneKey! }
      ])
  )
  return buildSessionSidebarTree({
    now: 100,
    sessions,
    metadata,
    view: emptySessionSidebarView(),
    snapshot: {
      cardsByPaneKey: new Map(
        sessions.map((row) => [
          row.paneKey!,
          card(row.paneKey!, attentionKeys.includes(row.rowKey) ? 'attention' : 'working')
        ])
      ),
      cardsByTabId: new Map(),
      attentionByPaneKey: attention
    },
    query: '',
    showHidden: false
  })
}

const rowsOf = (tree: ReturnType<typeof build>, key: string) =>
  tree.groups.find((group) => group.key === key)?.rows.map((row) => row.session.rowKey)

describe('Agent sessions', () => {
  it("lists an agent's session in the folded Agent sessions group, apart from the person's own", () => {
    const tree = build(withAgents(['launched']))
    expect(tree.groups.find((group) => group.kind === 'workspace')?.rows).toHaveLength(1)
    expect(rowsOf(tree, 'workspace:other')).toEqual(['mine'])
    const group = tree.groups.find((entry) => entry.key === SESSION_WORKERS_GROUP_KEY)
    expect(group).toMatchObject({ kind: 'workers', label: 'Agent sessions (1)', collapsed: true })
    expect(rowsOf(tree, SESSION_WORKERS_GROUP_KEY)).toEqual(['launched'])
  })

  it('sits below the person’s own sessions, folders and Saved', () => {
    const metadata = withAgents(
      ['launched'],
      moveSessionToFolder(
        { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_ID, name: 'Clients' }] },
        'mine',
        FOLDER_ID
      )
    )
    const saved = session('saved', 4)
    const tree = build(
      { ...metadata, membership: { ...metadata.membership, saved: SAVED_SESSIONS_FOLDER_ID } },
      [mine, launched, saved]
    )
    const kinds = tree.groups.map((group) => group.kind)
    expect(kinds.indexOf('folder')).toBeLessThan(kinds.indexOf('workers'))
    expect(kinds.indexOf('saved')).toBeLessThan(kinds.indexOf('workers'))
    expect(kinds.indexOf('workers')).toBe(kinds.length - 1)
  })

  it('lists it there even when its launcher filed it in a folder', () => {
    const metadata = withAgents(
      ['launched'],
      moveSessionToFolder(
        { ...emptySessionFolderMetadata(), folders: [{ id: FOLDER_ID, name: 'Ads' }] },
        'launched',
        FOLDER_ID
      )
    )
    const tree = build(metadata)
    expect(rowsOf(tree, SESSION_WORKERS_GROUP_KEY)).toEqual(['launched'])
    expect(tree.groups.find((group) => group.kind === 'folder')?.rows).toEqual([])
  })

  it('brings one that needs the person to Needs you', () => {
    const tree = build(withAgents(['asking']), [mine, asking], ['asking'])
    expect(rowsOf(tree, SESSION_WORKERS_GROUP_KEY)).toBeUndefined()
    expect(tree.groups[0]).toMatchObject({ kind: 'attention' })
    expect(tree.groups[0]!.rows.map((row) => row.session.rowKey)).toEqual(['asking'])
  })

  it('gives one the person saved back to them', () => {
    const metadata = moveSessionToFolder(
      withAgents(['launched']),
      'launched',
      SAVED_SESSIONS_FOLDER_ID
    )
    expect(isAgentSession(metadata, launched)).toBe(false)
    const tree = build(metadata)
    expect(rowsOf(tree, SESSION_WORKERS_GROUP_KEY)).toBeUndefined()
  })

  it("follows the paired owner's word for a row that mirrors its session", () => {
    const mirrored = session('mirrored', 5, {
      hostId: 'runtime:studio',
      mirroredConversation: {
        environmentId: 'studio',
        conversation: null,
        ownerPaneKey: null,
        ownerTabId: null,
        rest: 'live',
        listed: true,
        stale: false,
        ownerState: 'live' as never,
        agentSessionByOwner: true
      }
    })
    expect(isAgentSession(emptySessionFolderMetadata(), mirrored)).toBe(true)
    expect(isAgentSession(emptySessionFolderMetadata(), mine)).toBe(false)
  })

  it('keeps the note when the session key moves from its pane to its conversation', () => {
    const moved = migrateSessionFolderKey(withAgents(['pane:tab-2']), 'pane:tab-2', 'launched')
    expect(moved.agentSessions).toEqual({ launched: 1 })
  })
})
