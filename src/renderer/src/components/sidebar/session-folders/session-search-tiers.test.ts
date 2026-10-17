import { describe, expect, it } from 'vitest'
import type { SessionFolder } from '@/lib/session-folders'
import type { SessionSidebarTreeRow } from '@/lib/session-sidebar-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type { SessionSearchHit } from '../../../../../shared/session-search-types'
import {
  exactSearchFolderIds,
  listedSearchRows,
  sessionSearchResultGroups,
  tierSessionSearchResults
} from './session-search-tiers'

const folder = (id: string, name: string, parentId?: string): SessionFolder =>
  ({ id, name, ...(parentId ? { parentId } : {}) }) as SessionFolder

const row = (
  rowKey: string,
  label: string,
  folderId: string | null = null
): SessionSidebarTreeRow =>
  ({ session: { rowKey, label } as SidebarSession, folderId }) as SessionSidebarTreeRow

const hit = (sessionId: string, match?: SessionSearchHit['match']): SessionSearchHit => ({
  sessionKey: `claude:${sessionId}`,
  sessionId,
  agent: 'claude',
  hostLabel: 'mac-studio',
  executionHostId: 'local',
  title: sessionId,
  cwd: null,
  transcriptPath: `/p/${sessionId}.jsonl`,
  lastActivityAt: null,
  score: 1,
  ...(match ? { match } : {}),
  reasons: [],
  snippets: [],
  summary: null,
  summarySource: null
})

function tiers(input: {
  query: string
  rows?: SessionSidebarTreeRow[]
  folders?: SessionFolder[]
  hits?: SessionSearchHit[]
  rowOf?: Record<string, string>
  limit?: number
}) {
  const rows = input.rows ?? []
  const byKey = new Map(rows.map((entry) => [entry.session.rowKey, entry.session]))
  return tierSessionSearchResults({
    query: input.query,
    rows,
    folders: input.folders ?? [],
    hits: input.hits ?? [],
    rowFor: (found) => byKey.get(input.rowOf?.[found.sessionId] ?? '') ?? null,
    limit: input.limit
  }).map((section) => ({
    tier: section.tier,
    rows: section.rows.map((entry) => entry.session.rowKey),
    hits: section.hits.map((entry) => entry.sessionId)
  }))
}

describe('exactSearchFolderIds', () => {
  it('matches a whole folder name, ignoring case and spacing, with its subfolders', () => {
    const folders = [folder('a', 'Enterprise'), folder('b', 'Q3', 'a'), folder('c', 'Enterprise X')]
    expect([...exactSearchFolderIds(folders, '  enterprise ')]).toEqual(['a', 'b'])
    expect(exactSearchFolderIds(folders, 'enter').size).toBe(0)
  })
})

describe('tierSessionSearchResults', () => {
  it('answers an exact folder name with that folder alone', () => {
    const rows = [
      row('r1', 'Enterprise pricing'),
      row('r2', 'Kickoff', 'f'),
      row('r3', 'Q3', 'sub')
    ]
    const folders = [folder('f', 'Enterprise'), folder('sub', 'Deals', 'f')]
    expect(tiers({ query: 'Enterprise', rows, folders, hits: [hit('x')] })).toEqual([
      { tier: 'folder', rows: ['r2', 'r3'], hits: [] }
    ])
  })

  it('falls through to titles when the named folder holds nothing listed', () => {
    const rows = [row('r1', 'Enterprise pricing')]
    expect(tiers({ query: 'enterprise', rows, folders: [folder('f', 'Enterprise')] })).toEqual([
      { tier: 'title', rows: ['r1'], hits: [] }
    ])
  })

  it('lists title matches, then conversation matches, and never meaning next to words', () => {
    const rows = [row('r1', 'Whitelabel launch'), row('r2', 'Ads check'), row('r3', 'Other')]
    const hits = [hit('meaning', 'meaning'), hit('said', 'text'), hit('off', 'title'), hit('r2')]
    expect(tiers({ query: 'whitelabel', rows, hits, rowOf: { r2: 'r2' } })).toEqual([
      { tier: 'title', rows: ['r1'], hits: ['off'] },
      { tier: 'text', rows: ['r2'], hits: ['said'] }
    ])
  })

  it('shows sessions about a similar topic only when no words matched', () => {
    const rows = [row('r1', 'Ads check')]
    const hits = [hit('m1', 'meaning'), hit('r1', 'meaning')]
    expect(tiers({ query: 'reseller', rows, hits, rowOf: { r1: 'r1' } })).toEqual([
      { tier: 'meaning', rows: ['r1'], hits: ['m1'] }
    ])
  })

  it('stops at the limit and lists each session once', () => {
    const rows = Array.from({ length: 12 }, (_, i) => row(`r${i}`, `Deploy ${i}`))
    const result = tiers({ query: 'deploy', rows, hits: [hit('r0', 'title')], rowOf: { r0: 'r0' } })
    expect(result).toHaveLength(1)
    expect(result[0]!.rows).toHaveLength(10)
    expect(tiers({ query: 'deploy', rows, limit: 3 })[0]!.rows).toEqual(['r0', 'r1', 'r2'])
  })

  it('is empty for a blank query', () => {
    expect(tiers({ query: '  ', rows: [row('r1', 'x')] })).toEqual([])
  })
})

describe('listedSearchRows', () => {
  it('flattens clustered rows once each', () => {
    const child = row('c', 'child')
    const parent = { ...row('p', 'parent'), children: [child] }
    const listed = listedSearchRows([{ rows: [parent] }, { rows: [child] }])
    expect(listed.map((entry) => entry.session.rowKey)).toEqual(['p', 'c'])
    expect(listed[0]!.children).toBeUndefined()
  })
})

describe('sessionSearchResultGroups', () => {
  it('draws a folder match as that folder and other kinds under a search heading', () => {
    const enterprise = folder('f', 'Enterprise')
    const groups = sessionSearchResultGroups([
      { tier: 'folder', folder: enterprise, rows: [], hits: [] },
      { tier: 'text', folder: null, rows: [], hits: [hit('a')] }
    ])
    expect(groups.map((group) => [group.key, group.kind, group.label])).toEqual([
      ['search:folder', 'folder', 'Enterprise'],
      ['search:text', 'search', 'In conversations']
    ])
    expect(groups[1]!.searchHits).toHaveLength(1)
  })
})
