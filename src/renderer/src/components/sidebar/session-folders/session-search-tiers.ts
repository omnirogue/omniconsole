import { translate } from '@/i18n/i18n'
import type { ConversationFleetSidebarGroup } from '@/lib/conversation-fleet-sidebar'
import type { SessionFolder } from '@/lib/session-folders'
import type { SessionSidebarTreeRow } from '@/lib/session-sidebar-tree'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import type {
  SessionSearchHit,
  SessionSearchMatch
} from '../../../../../shared/session-search-types'

/** The search answers with this many sessions at most; the full tree comes back when it is cleared. */
export const SESSION_SEARCH_RESULT_LIMIT = 10

export type SessionSearchTier = 'folder' | 'title' | 'text' | 'meaning'

/** One heading of results: rows already in the sidebar, then conversations it does not list. */
export type SessionSearchSection = {
  tier: SessionSearchTier
  folder: SessionFolder | null
  rows: SessionSidebarTreeRow[]
  hits: SessionSearchHit[]
}

export type SessionSearchResultGroup = ConversationFleetSidebarGroup & {
  searchHits: SessionSearchHit[]
}

export function normalizedSearchName(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Folders named exactly what was typed, and every folder nested inside them. */
export function exactSearchFolderIds(
  folders: readonly SessionFolder[],
  query: string
): ReadonlySet<string> {
  const typed = normalizedSearchName(query)
  const ids = new Set(
    typed
      ? folders
          .filter((folder) => normalizedSearchName(folder.name) === typed)
          .map((folder) => folder.id)
      : []
  )
  let grew = ids.size > 0
  while (grew) {
    grew = false
    for (const folder of folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        grew = true
      }
    }
  }
  return ids
}

// Why `text` for a missing value: an older host found it by words, never by meaning alone.
function hitMatch(hit: SessionSearchHit): SessionSearchMatch {
  return hit.match ?? 'text'
}

/** Every row the filtered tree lists, once each, in the order it lists them. */
export function listedSearchRows(
  groups: readonly { rows: readonly SessionSidebarTreeRow[] }[]
): SessionSidebarTreeRow[] {
  const seen = new Set<string>()
  const out: SessionSidebarTreeRow[] = []
  const visit = (row: SessionSidebarTreeRow): void => {
    if (!seen.has(row.session.rowKey)) {
      seen.add(row.session.rowKey)
      out.push(row.children ? { ...row, children: undefined } : row)
    }
    row.children?.forEach(visit)
  }
  groups.forEach((group) => group.rows.forEach(visit))
  return out
}

/**
 * What the search shows, strongest evidence first: a folder named exactly what was typed answers
 * alone; otherwise sessions whose title matches, then sessions whose conversation says it; only
 * when no words matched anywhere, sessions about a similar topic. At most `limit` in all.
 */
export function tierSessionSearchResults(input: {
  query: string
  rows: readonly SessionSidebarTreeRow[]
  folders: readonly SessionFolder[]
  hits: readonly SessionSearchHit[]
  rowFor: (hit: SessionSearchHit) => SidebarSession | null
  /** The row's own words besides its title (tags, task name), as the tree filter reads them. */
  rowText?: (session: SidebarSession) => string | null | undefined
  limit?: number
}): SessionSearchSection[] {
  const typed = normalizedSearchName(input.query)
  if (!typed) {
    return []
  }
  const limit = input.limit ?? SESSION_SEARCH_RESULT_LIMIT
  const listed = new Map(input.rows.map((row) => [row.session.rowKey, row]))
  const used = new Set<string>()
  const room = (): boolean => used.size < limit
  const section = (tier: SessionSearchTier, folder: SessionFolder | null = null) => ({
    tier,
    folder,
    rows: [] as SessionSidebarTreeRow[],
    hits: [] as SessionSearchHit[]
  })
  const addRow = (into: SessionSearchSection, row: SessionSidebarTreeRow): void => {
    if (room() && !used.has(row.session.rowKey)) {
      used.add(row.session.rowKey)
      into.rows.push(row)
    }
  }
  const addHit = (into: SessionSearchSection, hit: SessionSearchHit): void => {
    const row = input.rowFor(hit)
    const listedRow = row ? listed.get(row.rowKey) : undefined
    if (listedRow) {
      addRow(into, listedRow)
      return
    }
    const key = row?.rowKey ?? `${hit.executionHostId}:${hit.sessionKey}`
    if (room() && !used.has(key)) {
      used.add(key)
      into.hits.push(hit)
    }
  }

  const folderIds = exactSearchFolderIds(input.folders, typed)
  if (folderIds.size > 0) {
    const named = input.folders.find((folder) => normalizedSearchName(folder.name) === typed)
    const inFolder = section('folder', named ?? null)
    for (const row of input.rows) {
      if (row.folderId && folderIds.has(row.folderId)) {
        addRow(inFolder, row)
      }
    }
    if (inFolder.rows.length > 0) {
      return [inFolder]
    }
  }

  const titles = section('title')
  for (const row of input.rows) {
    const words = [row.session.label, row.session.customTitle, input.rowText?.(row.session)]
    if (words.some((text) => text && normalizedSearchName(text).includes(typed))) {
      addRow(titles, row)
    }
  }
  const text = section('text')
  for (const hit of input.hits) {
    if (hitMatch(hit) === 'title') {
      addHit(titles, hit)
    }
  }
  for (const hit of input.hits) {
    if (hitMatch(hit) === 'text') {
      addHit(text, hit)
    }
  }
  const meaning = section('meaning')
  if (used.size === 0) {
    for (const hit of input.hits) {
      if (hitMatch(hit) === 'meaning') {
        addHit(meaning, hit)
      }
    }
  }
  return [titles, text, meaning].filter((entry) => entry.rows.length > 0 || entry.hits.length > 0)
}

function sectionLabel(entry: SessionSearchSection): string {
  switch (entry.tier) {
    case 'folder':
      return entry.folder?.name ?? translate('sessionContentSearch.tierFolder', 'Folder')
    case 'title':
      return translate('sessionContentSearch.tierTitle', 'Titles')
    case 'text':
      return translate('sessionContentSearch.tierText', 'In conversations')
    case 'meaning':
      return translate('sessionContentSearch.tierMeaning', 'Similar topics')
  }
}

/** Each section as a sidebar group, so a listed session is the same row it is in the tree. */
export function sessionSearchResultGroups(
  sections: readonly SessionSearchSection[]
): SessionSearchResultGroup[] {
  return sections.map((entry) => ({
    key: `search:${entry.tier}`,
    kind: entry.tier === 'folder' && entry.folder ? 'folder' : 'search',
    label: sectionLabel(entry),
    ...(entry.tier === 'folder' && entry.folder ? { folder: entry.folder } : {}),
    rows: entry.rows,
    collapsed: false,
    hidden: false,
    attentionCount: 0,
    canReorder: false,
    canHide: false,
    fleetRows: [],
    searchHits: entry.hits
  }))
}
