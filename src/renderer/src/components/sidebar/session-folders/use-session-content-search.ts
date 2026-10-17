import { useEffect, useMemo, useState } from 'react'
import type { SidebarSession } from '@/lib/sidebar-sessions'
import { conversationViewKey } from '@/lib/conversation-view'
import { sessionRowFolderId } from '@/lib/mirrored-conversation-folders'
import type { SessionFolderMetadata } from '@/lib/session-folders'
import type { SessionSidebarTreeRow } from '@/lib/session-sidebar-tree'
import type {
  SessionSearchHit,
  SessionSearchResult
} from '../../../../../shared/session-search-types'
import { sessionManageHostKey } from '../../../../../shared/session-manage-query'
import { rowHoldsSessionReference } from '../../../../../shared/session-reference'
import { sessionSearchPreview } from './session-search-preview'
import { emptySessionSearchPreviews } from './session-search-preview-context'
import {
  exactSearchFolderIds,
  listedSearchRows,
  sessionSearchResultGroups,
  tierSessionSearchResults,
  type SessionSearchResultGroup
} from './session-search-tiers'

const DEBOUNCE_MS = 300
const MIN_QUERY_CHARS = 2
// Why this many: every hit that names a listed row keeps that row in the filtered list.
const HIT_LIMIT = 60

export type SessionContentSearch = {
  query: string
  result: SessionSearchResult | null
  loading: boolean
  /** Sidebar rows whose transcript matched, so the title filter keeps them. */
  matchedRowKeys: ReadonlySet<string>
  /** The matching passage for each of those rows, shown under the row's name. */
  previews: ReadonlyMap<string, string>
  /** Hits of the current query, best first (empty while a newer query is on its way). */
  hits: readonly SessionSearchHit[]
  rowFor: (hit: SessionSearchHit) => SidebarSession | null
}

/** Every sidebar row naming the hit's provider conversation on the hit's host (the CLI's join). */
export function sidebarRowsForHit(
  hit: SessionSearchHit,
  sessions: readonly SidebarSession[]
): SidebarSession[] {
  const hostId = sessionManageHostKey(hit.executionHostId)
  if (!hostId) {
    return []
  }
  return sessions.filter((session) => {
    const provider = session.providerSession
    if (!provider) {
      return false
    }
    // Why `local` for a missing host: the sidebar lists this computer's rows without one.
    return rowHoldsSessionReference(
      { sessionId: hit.sessionId, hostId, transcriptPath: hit.transcriptPath },
      {
        hostId: session.hostId ?? 'local',
        providerSessionId: provider.id,
        transcriptPath: provider.transcriptPath ?? null
      }
    )
  })
}

/** The row a hit opens: its first match, as the sidebar lists that conversation once. */
export function sidebarRowForHit(
  hit: SessionSearchHit,
  sessions: readonly SidebarSession[]
): SidebarSession | null {
  return sidebarRowsForHit(hit, sessions)[0] ?? null
}

export function useSessionContentSearch(
  query: string,
  sessions: readonly SidebarSession[]
): SessionContentSearch {
  const trimmed = query.trim()
  const [result, setResult] = useState<SessionSearchResult | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    const api = window.api?.sessionSearch
    if (!api || trimmed.length < MIN_QUERY_CHARS) {
      setResult(null)
      setLoading(false)
      return
    }
    let current = true
    setLoading(true)
    const timer = setTimeout(() => {
      api
        .query({ query: trimmed, limit: HIT_LIMIT })
        .then((next) => {
          if (current) {
            setResult(next)
          }
        })
        .catch(() => {
          if (current) {
            setResult(null)
          }
        })
        .finally(() => {
          if (current) {
            setLoading(false)
          }
        })
    }, DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [trimmed])
  // Why apart from `loading`: the previews reach every row, so they change only with the hits.
  const matches = useMemo(() => {
    const rowFor = (hit: SessionSearchHit): SidebarSession | null => sidebarRowForHit(hit, sessions)
    const matched = new Set<string>()
    const previews = new Map<string, string>()
    const hits = result?.query === trimmed ? result.hits : []
    for (const hit of hits) {
      const row = rowFor(hit)
      if (row && !matched.has(row.rowKey)) {
        matched.add(row.rowKey)
        const preview = sessionSearchPreview(hit, trimmed)
        if (preview) {
          previews.set(row.rowKey, preview)
        }
      }
    }
    return {
      matchedRowKeys: matched,
      previews: previews.size > 0 ? previews : emptySessionSearchPreviews(),
      hits,
      rowFor
    }
  }, [result, sessions, trimmed])
  return useMemo(
    () => ({ query: trimmed, result, loading, ...matches }),
    [matches, result, loading, trimmed]
  )
}

/**
 * The sidebar's own filter text, extended so a row found by its transcript, or filed in a folder
 * named exactly what was typed, stays visible.
 */
export function withContentMatches(
  searchText: ((session: SidebarSession) => string | null | undefined) | undefined,
  search: SessionContentSearch,
  metadata?: SessionFolderMetadata
): (session: SidebarSession) => string {
  const folderIds = metadata ? exactSearchFolderIds(metadata.folders, search.query) : new Set()
  return (session) => {
    const base = searchText?.(session) ?? ''
    // Why the tree's resolver (C3): a row a paired owner files answers to that folder's name.
    const folderId =
      metadata && folderIds.size > 0
        ? sessionRowFolderId(metadata, session, conversationViewKey(session))
        : null
    // Why: the tree filters by substring; a transcript hit answers to the query that found it.
    return search.matchedRowKeys.has(session.rowKey) || (folderId && folderIds.has(folderId))
      ? `${base} ${search.query.toLowerCase()}`
      : base
  }
}

/** The sidebar filter's conversation search and the filter text that keeps its hits listed. */
export function useSessionSidebarSearch(
  query: string,
  sessions: readonly SidebarSession[],
  tagSearchText: ((session: SidebarSession) => string | null | undefined) | undefined,
  metadata?: SessionFolderMetadata
): { contentSearch: SessionContentSearch; searchText: (session: SidebarSession) => string } {
  const contentSearch = useSessionContentSearch(query, sessions)
  const searchText = useMemo(
    () => withContentMatches(tagSearchText, contentSearch, metadata),
    [tagSearchText, contentSearch, metadata]
  )
  return { contentSearch, searchText }
}

/**
 * While the filter is typed, the list the sidebar draws instead of the tree: the best
 * `SESSION_SEARCH_RESULT_LIMIT` sessions under one heading per kind of match. Null otherwise.
 */
export function useSessionSearchGroups(
  groups: readonly { rows: readonly SessionSidebarTreeRow[] }[],
  metadata: SessionFolderMetadata,
  search: SessionContentSearch,
  rowText?: (session: SidebarSession) => string | null | undefined
): SessionSearchResultGroup[] | null {
  return useMemo(() => {
    if (!search.query) {
      return null
    }
    const sections = tierSessionSearchResults({
      query: search.query,
      rows: listedSearchRows(groups),
      folders: metadata.folders,
      hits: search.hits,
      rowFor: search.rowFor,
      rowText
    })
    return sessionSearchResultGroups(sections)
  }, [groups, metadata.folders, search, rowText])
}
