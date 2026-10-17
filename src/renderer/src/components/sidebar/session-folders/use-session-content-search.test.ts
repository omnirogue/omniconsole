import { describe, expect, it } from 'vitest'
import { emptySessionFolderMetadata } from '@/lib/session-folders'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionSearchHit } from '../../../../../shared/session-search-types'
import {
  sidebarRowForHit,
  sidebarRowsForHit,
  withContentMatches,
  type SessionContentSearch
} from './use-session-content-search'

const session = (rowKey: string, overrides: Partial<SidebarSession> = {}): SidebarSession =>
  ({
    rowKey,
    hostId: null,
    label: rowKey,
    agent: 'claude',
    workspaceLabel: 'w',
    providerSession: { key: 'claude', id: `${rowKey}-id` },
    ...overrides
  }) as SidebarSession

const hit = (sessionId: string, executionHostId = 'local'): SessionSearchHit => ({
  sessionKey: `claude:${sessionId}`,
  sessionId,
  agent: 'claude',
  hostLabel: 'mac-studio',
  executionHostId,
  title: 't',
  cwd: null,
  transcriptPath: `/p/${sessionId}.jsonl`,
  lastActivityAt: null,
  score: 1,
  reasons: [],
  snippets: [],
  summary: null,
  summarySource: null
})

describe('sidebarRowForHit', () => {
  it('matches by provider session id on the same host only', () => {
    const rows = [
      session('a'),
      session('b', { hostId: 'runtime:env-1' as SidebarSession['hostId'] })
    ]
    expect(sidebarRowForHit(hit('a-id'), rows)?.rowKey).toBe('a')
    expect(sidebarRowForHit(hit('b-id'), rows)).toBeNull()
    expect(sidebarRowForHit(hit('b-id', 'runtime:env-1'), rows)?.rowKey).toBe('b')
  })

  it('matches a Claude transcript named with a different UUID than the hook id', () => {
    const row = session('c', {
      providerSession: { key: 'claude', id: 'hook-id', transcriptPath: '/p/file-uuid.jsonl' }
    } as unknown as Partial<SidebarSession>)
    expect(sidebarRowForHit(hit('file-uuid'), [row])?.rowKey).toBe('c')
  })
})

describe('sidebarRowsForHit', () => {
  it('returns every row holding the conversation, so a duplicate pane is never hidden', () => {
    const rows = [
      session('a'),
      session('b', {
        providerSession: { key: 'claude', id: 'a-id' }
      } as unknown as Partial<SidebarSession>),
      session('c')
    ]
    expect(sidebarRowsForHit(hit('a-id'), rows).map((row) => row.rowKey)).toEqual(['a', 'b'])
  })

  it('matches a Codex rollout by the id at the end of its file name', () => {
    const row = session('d', {
      providerSession: {
        key: 'claude',
        id: 'thread-hook',
        transcriptPath:
          '/h/.codex/sessions/2026/09/25/rollout-2026-09-25T10-00-00-2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c.jsonl'
      }
    } as unknown as Partial<SidebarSession>)
    expect(sidebarRowForHit(hit('2f0c9f4e-8d1a-4c7e-9b8e-0e6f3f2a1b7c'), [row])?.rowKey).toBe('d')
  })
})

describe('withContentMatches', () => {
  it('lets a transcript hit pass the title filter without changing other rows', () => {
    const search = {
      query: 'Uma',
      matchedRowKeys: new Set(['a'])
    } as unknown as SessionContentSearch
    const text = withContentMatches(() => 'tag', search)
    expect(text(session('a'))).toBe('tag uma')
    expect(text(session('b'))).toBe('tag')
  })

  it("matches a folder name by where the tree files the row: a paired owner's folder first (C3)", () => {
    const ADS = '00000000-0000-4000-8000-0000000000ad5'
    const OPS = '00000000-0000-4000-8000-0000000000075'
    const metadata = {
      ...emptySessionFolderMetadata(),
      folders: [
        { id: ADS, name: 'Ads' },
        { id: OPS, name: 'Ops' }
      ],
      membership: { 'session-local': OPS, 'session-owner': OPS }
    }
    const search = { query: 'Ads', matchedRowKeys: new Set() } as unknown as SessionContentSearch
    const text = withContentMatches(() => 'tag', search, metadata)
    const vouched = {
      environmentId: 'env-studio',
      conversation: null,
      ownerPaneKey: null,
      ownerTabId: null,
      rest: 'live' as const,
      listed: true,
      stale: false,
      ownerState: 'ready' as const
    }
    // Locally in Ops, filed in Ads by its owner: found by "Ads".
    expect(
      text(
        session('owner', {
          sessionKey: 'session-owner',
          mirroredConversation: { ...vouched, folderIdByOwner: ADS }
        })
      )
    ).toBe('tag ads')
    expect(text(session('local', { sessionKey: 'session-local' }))).toBe('tag')
  })
})
