import type { SessionFolderEntry } from './session-folder-cli'
import { resolveSessionFolderRef } from './session-folder-ref'
import { parseProjectSettings, type ProjectSettings } from './project-settings'
import { projectFolderFor } from './session-project-folder'
import type { SessionProjectReadResult } from './session-project-cli'

/**
 * The folders and project settings main keeps so a project can be read with no window open
 * (backend plan §6, upgrade plan decision 1). The window pushes it on each change; main answers
 * `readProject` from it only when no window does. Read-only: nothing here changes a project.
 */
export type SessionProjectMirror = {
  folders: Pick<SessionFolderEntry, 'id' | 'name' | 'path' | 'section' | 'parentId'>[]
  projects: Record<string, ProjectSettings>
  savedAt: number
}

type MirrorFolder = SessionProjectMirror['folders'][number]

const projectNode = (folder: MirrorFolder) => ({
  id: folder.id,
  name: folder.name,
  ...(folder.parentId ? { parentId: folder.parentId } : {}),
  ...(folder.section === 'saved' ? { section: 'saved' as const } : {})
})

/** A folder by id or path and the project it is in, as the window's own `readProject` reads it. */
export function readProjectFromFolders(
  folders: readonly MirrorFolder[],
  projects: Readonly<Record<string, ProjectSettings>>,
  ref: string
): SessionProjectReadResult {
  const resolved = resolveSessionFolderRef(folders, ref)
  if (!resolved.ok) {
    throw new Error(resolved.error)
  }
  if (resolved.target.kind !== 'folder') {
    throw new Error('Saved Sessions is not a project. Name a folder inside it or elsewhere.')
  }
  const entry = resolved.target.folder
  const project = projectFolderFor(folders.map(projectNode), entry.id)
  const projectEntry = project ? folders.find((candidate) => candidate.id === project.id) : null
  return {
    folder: { id: entry.id, name: entry.name, path: entry.path },
    project: projectEntry
      ? {
          folderId: projectEntry.id,
          name: projectEntry.name,
          path: projectEntry.path,
          settings: projects[projectEntry.id] ?? null
        }
      : null
  }
}

/** A mirror read back from disk or the wire; a malformed project is left out, never trusted. */
export function parseSessionProjectMirror(value: unknown): SessionProjectMirror | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const { folders, projects, savedAt } = value as Partial<SessionProjectMirror>
  if (!Array.isArray(folders) || !projects || typeof projects !== 'object') {
    return null
  }
  const listed = folders.filter(
    (folder): folder is MirrorFolder =>
      !!folder &&
      typeof folder.id === 'string' &&
      typeof folder.name === 'string' &&
      typeof folder.path === 'string'
  )
  const kept = Object.entries(projects).flatMap(([id, settings]) => {
    const parsed = parseProjectSettings(settings)
    return parsed ? [[id, parsed] as const] : []
  })
  return {
    folders: listed.map(({ id, name, path, section, parentId }) => ({
      id,
      name,
      path,
      section,
      parentId: parentId ?? null
    })),
    projects: Object.fromEntries(kept),
    savedAt: typeof savedAt === 'number' ? savedAt : 0
  }
}
