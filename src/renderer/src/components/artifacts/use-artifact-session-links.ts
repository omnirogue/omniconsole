import { useEffect, useState } from 'react'
import type { ArtifactListItem } from '../../../../shared/artifacts'
import { buildSidebarSessions } from '@/lib/sidebar-sessions'
import { useAppStore } from '@/store'
import { listSessionArtifactRecords } from '../right-sidebar/session-artifact/session-artifact-client'

/** The pane and sidebar title of the session on this desktop that published a page. */
export type ArtifactSessionLink = { paneKey: string; title: string | null }

const EMPTY_LINKS: ReadonlyMap<string, ArtifactSessionLink> = new Map()

/**
 * Pages this desktop published, by slug, named by their sidebar row. Read only when some row
 * carries a session, so an older server's page makes no extra request.
 */
export function useArtifactSessionLinks(
  items: readonly ArtifactListItem[]
): ReadonlyMap<string, ArtifactSessionLink> {
  const wanted = items.some((item) => Boolean(item.sessionRef))
  // Why keep the failed rows: a read that failed is retried when the rows change (a refresh),
  // never cached as "no sessions".
  const [read, setRead] = useState<
    | { ok: true; links: ReadonlyMap<string, ArtifactSessionLink> }
    | { ok: false; items: readonly ArtifactListItem[] }
    | null
  >(null)
  const due = wanted && (read === null || (!read.ok && read.items !== items))
  // Why: rows arriving while the first read is pending must not restart it; only a retry follows them.
  const retryFor = read !== null && !read.ok ? items : null
  useEffect(() => {
    if (!due) {
      return
    }
    let cancelled = false
    listSessionArtifactRecords().then(
      (records) => {
        if (cancelled) {
          return
        }
        const sessions = buildSidebarSessions(useAppStore.getState())
        const next = new Map<string, ArtifactSessionLink>()
        for (const record of records) {
          const paneKey = record.origin?.paneKey
          if (!paneKey || next.has(record.slug)) {
            continue
          }
          const row = sessions.find((session) => session.paneKey === paneKey)
          next.set(record.slug, { paneKey, title: row ? row.customTitle || row.label : null })
        }
        setRead({ ok: true, links: next })
      },
      () => {
        if (!cancelled) {
          setRead({ ok: false, items })
        }
      }
    )
    return () => {
      cancelled = true
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- `items` is read through `retryFor`
  }, [due, retryFor])
  return read?.ok ? read.links : EMPTY_LINKS
}
