import { z } from 'zod'
import { withValidParents } from './session-folder-tree'
import {
  parseProjectSettings,
  projectSettingsError,
  type ProjectSettings
} from '../../../shared/project-settings'
import { isProjectFolder } from '../../../shared/session-project-folder'

export const SESSION_FOLDER_NAME_LIMIT = 80
export const SAVED_SESSIONS_FOLDER_ID = 'saved-sessions'

const folderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(SESSION_FOLDER_NAME_LIMIT),
  section: z.literal('saved').optional(),
  /** The folder this one sits inside; absent at the top of its section. */
  parentId: z.string().uuid().optional()
})

const metadataSchema = z.object({
  version: z.literal(1),
  folders: z.array(folderSchema),
  membership: z.record(z.string(), z.string()),
  transferReceipts: z
    .record(
      z.string(),
      z.object({ sessionKey: z.string(), folderId: z.string().nullable(), at: z.number() })
    )
    .optional(),
  finishActions: z
    .record(
      z.string(),
      z.object({
        action: z.enum(['me', 'end', 'save']),
        folderId: z.string().nullable(),
        chainId: z.string().optional(),
        executionOwnerKey: z.string().optional(),
        revision: z.number().int().nonnegative().optional(),
        applied: z.boolean().optional(),
        afterCompletion: z.boolean().optional(),
        completedAt: z.number().finite().optional()
      })
    )
    .optional(),
  /** Project settings by project folder id; each record is checked on its own (project-settings.ts). */
  projects: z.record(z.string(), z.unknown()).optional()
})

export type SessionFolder = z.infer<typeof folderSchema>
export type SessionFolderMetadata = Omit<z.infer<typeof metadataSchema>, 'projects'> & {
  projects?: Record<string, ProjectSettings>
}
export type SessionFinishAction = NonNullable<SessionFolderMetadata['finishActions']>[string]

export function emptySessionFolderMetadata(): SessionFolderMetadata {
  return { version: 1, folders: [], membership: {} }
}

export function parseSessionFolderMetadata(value: unknown): SessionFolderMetadata {
  const parsed = metadataSchema.parse(value)
  const folderIds = new Set(parsed.folders.map((folder) => folder.id))
  if (folderIds.size !== parsed.folders.length) {
    throw new Error('Duplicate session folder identity')
  }
  const projects = Object.entries(parsed.projects ?? {}).flatMap(([id, value]) => {
    const settings = folderIds.has(id) ? parseProjectSettings(value) : null
    return settings ? [[id, settings] as const] : []
  })
  const { projects: _raw, ...rest } = parsed
  return {
    ...rest,
    ...(projects.length ? { projects: Object.fromEntries(projects) } : {}),
    folders: withValidParents(parsed.folders),
    membership: Object.fromEntries(
      Object.entries(parsed.membership).filter(
        ([, folderId]) => folderId === SAVED_SESSIONS_FOLDER_ID || folderIds.has(folderId)
      )
    )
  }
}

/**
 * Names are unique among a folder's siblings, so "Q3" can sit under two clients. Top-level
 * folders stay unique across both sections, as before nesting.
 */
export function sessionFolderNameError(
  folders: readonly SessionFolder[],
  name: string,
  renameId?: string,
  parentId?: string | null
): string | null {
  const trimmed = name.trim()
  if (!trimmed) {
    return 'Enter a folder name.'
  }
  if (trimmed.length > SESSION_FOLDER_NAME_LIMIT) {
    return `Use ${SESSION_FOLDER_NAME_LIMIT} characters or fewer.`
  }
  const siblingOf =
    renameId !== undefined
      ? (folders.find((folder) => folder.id === renameId)?.parentId ?? null)
      : (parentId ?? null)
  if (
    folders.some(
      (folder) =>
        folder.id !== renameId &&
        (folder.parentId ?? null) === siblingOf &&
        folder.name.toLowerCase() === trimmed.toLowerCase()
    )
  ) {
    return 'A folder with that name already exists.'
  }
  return null
}

export function isSavedSessionFolder(
  metadata: SessionFolderMetadata,
  folderId: string | null
): boolean {
  return (
    folderId === SAVED_SESSIONS_FOLDER_ID ||
    metadata.folders.some((folder) => folder.id === folderId && folder.section === 'saved')
  )
}

/**
 * Removes one folder. Its subfolders move up to its parent, and a saved folder's sessions move
 * to that parent too (or to Saved Sessions at the top) — deleting a folder never unsaves anything.
 */
export function deleteSessionFolder(
  metadata: SessionFolderMetadata,
  folderId: string
): SessionFolderMetadata {
  const deleted = metadata.folders.find((folder) => folder.id === folderId)
  const saved = isSavedSessionFolder(metadata, folderId)
  const heir = deleted?.parentId ?? (saved ? SAVED_SESSIONS_FOLDER_ID : null)
  const { [folderId]: _gone, ...projects } = metadata.projects ?? {}
  return {
    ...metadata,
    ...(metadata.projects ? { projects } : {}),
    folders: metadata.folders
      .filter((folder) => folder.id !== folderId)
      .map((folder) => {
        if (folder.parentId !== folderId) {
          return folder
        }
        const { parentId: _deleted, ...rest } = folder
        return deleted?.parentId ? { ...rest, parentId: deleted.parentId } : rest
      }),
    membership: Object.fromEntries(
      Object.entries(metadata.membership)
        .filter(([, memberFolderId]) => memberFolderId !== folderId || heir !== null)
        .map(([key, memberFolderId]) => [key, memberFolderId === folderId ? heir! : memberFolderId])
    )
  }
}

/**
 * Puts a folder just before or after a sibling (same parent, same section). Siblings are drawn
 * in the order they are stored, so this is where subfolders and Saved Sessions folders get
 * their order; top-level Conversations folders follow the sidebar view's group order instead.
 */
export function reorderSessionFolder(
  metadata: SessionFolderMetadata,
  folderId: string,
  targetId: string,
  position: 'before' | 'after'
): SessionFolderMetadata {
  const folder = metadata.folders.find((entry) => entry.id === folderId)
  const target = metadata.folders.find((entry) => entry.id === targetId)
  if (!folder || !target) {
    throw new Error('This folder no longer exists.')
  }
  if (
    folderId === targetId ||
    (folder.parentId ?? null) !== (target.parentId ?? null) ||
    folder.section !== target.section
  ) {
    throw new Error('A folder can only be put beside another folder in the same place.')
  }
  const folders = metadata.folders.filter((entry) => entry.id !== folderId)
  const index = folders.findIndex((entry) => entry.id === targetId)
  folders.splice(position === 'before' ? index : index + 1, 0, folder)
  return { ...metadata, folders }
}

export function moveSessionToFolder(
  metadata: SessionFolderMetadata,
  sessionKey: string,
  folderId: string | null
): SessionFolderMetadata {
  if (!sessionKey) {
    throw new Error('Session identity is unavailable.')
  }
  if (
    folderId !== null &&
    folderId !== SAVED_SESSIONS_FOLDER_ID &&
    !metadata.folders.some((folder) => folder.id === folderId)
  ) {
    throw new Error('This folder no longer exists.')
  }
  const membership = { ...metadata.membership }
  if (folderId === null) {
    delete membership[sessionKey]
  } else {
    Object.defineProperty(membership, sessionKey, {
      value: folderId,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return { ...metadata, membership }
}

export function getSessionFolderId(
  metadata: SessionFolderMetadata,
  sessionKey: string | null
): string | null {
  if (!sessionKey || !Object.hasOwn(metadata.membership, sessionKey)) {
    return null
  }
  const id = metadata.membership[sessionKey]
  return id === SAVED_SESSIONS_FOLDER_ID || metadata.folders.some((folder) => folder.id === id)
    ? id
    : null
}

/**
 * Fold a provisional session identity onto the durable one that replaces it
 * (e.g. a terminal pane's provisional key once its provider session is
 * known). `fromKey`'s membership always moves off; it lands on `toKey` only
 * when `toKey` has no assignment of its own, so a manual choice already made
 * under the durable key wins. Dropping `fromKey` unconditionally is what
 * keeps this safe to call every time the row renders: if the same pane later
 * hosts an unrelated session, there is nothing left under `fromKey` for it to
 * inherit.
 */
export function migrateSessionFolderKey(
  metadata: SessionFolderMetadata,
  fromKey: string,
  toKey: string
): SessionFolderMetadata {
  if (fromKey === toKey || !holdsSessionFolderKey(metadata, fromKey)) {
    return metadata
  }
  const fromFolderId = getSessionFolderId(metadata, fromKey)
  const toFolderId = getSessionFolderId(metadata, toKey)
  const membership = { ...metadata.membership }
  delete membership[fromKey]
  if (fromFolderId !== null && toFolderId === null) {
    membership[toKey] = fromFolderId
  }
  const finishActions = { ...metadata.finishActions }
  if (Object.hasOwn(finishActions, fromKey)) {
    finishActions[toKey] ??= finishActions[fromKey]!
    delete finishActions[fromKey]
  }
  // Why here: a project's coordinator is bound by the key its folder membership moves under.
  const projects = { ...metadata.projects }
  let coordinatorMoved = false
  for (const [id, project] of Object.entries(projects)) {
    if (project.coordinator?.sessionKey === fromKey) {
      projects[id] = { ...project, coordinator: { ...project.coordinator, sessionKey: toKey } }
      coordinatorMoved = true
    }
  }
  return {
    ...metadata,
    membership,
    ...(metadata.finishActions ? { finishActions } : {}),
    ...(coordinatorMoved ? { projects } : {})
  }
}

/** Whether a filing, a finish action or a project's coordinator is held under this session key. */
export function holdsSessionFolderKey(metadata: SessionFolderMetadata, key: string): boolean {
  return (
    Object.hasOwn(metadata.membership, key) ||
    Object.hasOwn(metadata.finishActions ?? {}, key) ||
    Object.values(metadata.projects ?? {}).some(
      (project) => project.coordinator?.sessionKey === key
    )
  )
}

/**
 * `migrateSessionFolderKey` for a pane the person filed or unfiled themselves while it waited:
 * their choice lands on `toKey` over any assignment it had, in the same change.
 */
export function claimSessionFolderKey(
  metadata: SessionFolderMetadata,
  fromKey: string,
  toKey: string,
  folderId: string | null
): SessionFolderMetadata {
  const migrated = migrateSessionFolderKey(metadata, fromKey, toKey)
  const membership = { ...migrated.membership }
  if (folderId === null) {
    delete membership[toKey]
  } else {
    membership[toKey] = folderId
  }
  return { ...migrated, membership }
}

export function isSessionSaved(metadata: SessionFolderMetadata, sessionKey: string): boolean {
  return isSavedSessionFolder(metadata, getSessionFolderId(metadata, sessionKey))
}

/** Sets or removes one project folder's settings; throws the reason a record is refused. */
export function withProjectSettings(
  metadata: SessionFolderMetadata,
  folderId: string,
  settings: ProjectSettings | null
): SessionFolderMetadata {
  const { [folderId]: _previous, ...others } = metadata.projects ?? {}
  if (!settings) {
    return { ...metadata, projects: others }
  }
  if (!isProjectFolder(metadata.folders, folderId)) {
    throw new Error('Only a top-level folder, or a folder inside a company folder, is a project.')
  }
  const error = projectSettingsError(settings)
  if (error) {
    throw new Error(error)
  }
  return { ...metadata, projects: { ...others, [folderId]: settings } }
}

export function projectSettingsFor(
  metadata: SessionFolderMetadata,
  folderId: string | null | undefined
): ProjectSettings | null {
  return folderId ? (metadata.projects?.[folderId] ?? null) : null
}
