import type { SessionFolder } from '@/lib/session-folders'
import type { SyncedProjects } from '../../../../shared/account-sync-session-docs'
import { sameProjectSettings, type ProjectSettings } from '../../../../shared/project-settings'

/**
 * Project settings follow the account like folders do (plan §8 decision 10): only what the person
 * changed here is published, whole, stamped after anything seen; anything else this computer holds
 * differently is the account's to set.
 */
export function authorProjectEdits(input: {
  merged: SyncedProjects
  local: Readonly<Record<string, ProjectSettings>>
  noted: ReadonlySet<string>
  stamp: () => number
}): SyncedProjects {
  const { merged, local, noted, stamp } = input
  const edits: SyncedProjects = {}
  for (const [id, settings] of Object.entries(local)) {
    const known = merged[id]
    const changed = noted.has(id)
      ? !known?.v || !!known.x || !sameProjectSettings(known.v, settings)
      : !known
    if (changed) {
      edits[id] = { v: settings, t: stamp() }
    }
  }
  // Only settings the person removed are removed everywhere.
  for (const id of noted) {
    const known = merged[id]
    if (!local[id] && known && !known.x) {
      edits[id] = { t: stamp(), x: 1 }
    }
  }
  return edits
}

/** The account's settings for this computer's folders, or null when nothing here changes. */
export function applySyncedProjects(
  folders: readonly SessionFolder[],
  own: Readonly<Record<string, ProjectSettings>> | undefined,
  merged: SyncedProjects
): Record<string, ProjectSettings> | null {
  const ids = new Set(folders.map((folder) => folder.id))
  const next: Record<string, ProjectSettings> = { ...own }
  let changed = false
  for (const [id, remote] of Object.entries(merged)) {
    const held = next[id]
    if (remote.x) {
      if (held) {
        delete next[id]
        changed = true
      }
    } else if (remote.v && ids.has(id) && (!held || !sameProjectSettings(held, remote.v))) {
      next[id] = remote.v
      changed = true
    }
  }
  return changed ? next : null
}

/** Project folders whose settings one edit set, changed or removed. */
export function changedProjectIds(
  before: Readonly<Record<string, ProjectSettings>> | undefined,
  after: Readonly<Record<string, ProjectSettings>> | undefined
): string[] {
  const ids = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return [...ids].filter((id) => {
    const was = before?.[id]
    const is = after?.[id]
    return !was || !is ? was !== is : !sameProjectSettings(was, is)
  })
}
