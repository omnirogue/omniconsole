import { setSessionArchivedAt, type SessionSidebarView } from './session-sidebar-view'

export function manualArchiveView(
  view: SessionSidebarView,
  keys: readonly string[],
  archived: boolean,
  origin: 'account-sync' | 'resume' | undefined,
  now: number
): SessionSidebarView {
  const keep = new Set(view.autoArchiveKeep ?? [])
  const next = new Set(view.archived ?? [])
  for (const key of keys) {
    if (archived) {
      next.add(key)
    } else {
      next.delete(key)
    }
    if (!archived && origin !== 'resume') {
      keep.add(key)
    } else if (archived && origin !== 'account-sync') {
      keep.delete(key)
    }
  }
  return setSessionArchivedAt(
    {
      ...view,
      archived: [...next],
      autoArchiveKeep: [...keep],
      autoArchiveLog: view.autoArchiveLog?.map((entry) =>
        !archived && keys.includes(entry.key) && !entry.restoredAt
          ? { ...entry, restoredAt: now }
          : entry
      )
    },
    keys,
    archived,
    now
  )
}

export function verifiedArchiveView(
  view: SessionSidebarView,
  key: string,
  proof: string,
  now: number
): SessionSidebarView {
  return setSessionArchivedAt(
    {
      ...view,
      archived: [...(view.archived ?? []), key],
      autoArchiveLog: [...(view.autoArchiveLog ?? []), { key, proof, at: now }]
    },
    [key],
    true,
    now
  )
}
