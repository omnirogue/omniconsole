import { create } from 'zustand'
import { transferFolderPlacement } from '@/lib/session-folder-transfer-receipts'
import { translate } from '@/i18n/i18n'
import {
  claimSessionFolderKey,
  deleteSessionFolder,
  emptySessionFolderMetadata,
  holdsSessionFolderKey,
  migrateSessionFolderKey,
  moveSessionToFolder,
  isSessionSaved,
  parseSessionFolderMetadata,
  SAVED_SESSIONS_FOLDER_ID,
  sessionFolderNameError,
  withProjectSettings,
  type SessionFolderMetadata
} from '@/lib/session-folders'
import { moveSessionFolder } from '@/lib/session-folder-tree'
import {
  createLocalSessionFolderStorage,
  type SessionFolderStorage
} from '@/lib/session-folder-storage'
import { noteSessionFolderEdit } from '@/lib/account-sync/session-organization-intent'
import type { SessionFoldersState } from './session-folders-state'

export function createSessionFoldersStore(storage: SessionFolderStorage) {
  return create<SessionFoldersState>((set, get) => {
    const save = (metadata: SessionFolderMetadata): boolean => {
      if (!get().loaded) {
        return false
      }
      try {
        storage.save(metadata)
        set({ metadata, error: null })
        return true
      } catch {
        set({
          error: translate(
            'auto.components.SessionSidebar.saveFoldersFailed',
            'Could not save session folders on this device. Try again.'
          )
        })
        return false
      }
    }
    /** A change the person made: saved here, then noted for their other computers. */
    const edit = (metadata: SessionFolderMetadata): boolean => {
      const before = get().metadata
      const saved = save(metadata)
      if (saved) {
        noteSessionFolderEdit(before, metadata)
      }
      return saved
    }
    /** A session key move; a coordinator it re-points is noted, or the account's copy puts it back. */
    const moveKey = (metadata: SessionFolderMetadata): boolean => {
      const before = get().metadata
      const saved = save(metadata)
      if (saved && metadata.projects !== before.projects) {
        noteSessionFolderEdit(before, { ...before, projects: metadata.projects })
      }
      return saved
    }
    return {
      metadata: emptySessionFolderMetadata(),
      loaded: false,
      error: null,
      load: () => {
        try {
          set({ metadata: storage.load(), loaded: true, error: null })
        } catch {
          set({
            loaded: false,
            error: translate(
              'auto.components.SessionSidebar.readFoldersFailed',
              'Could not read session folders on this device.'
            )
          })
        }
      },
      createFolder: (name, section, parentId, project) => {
        const { metadata } = get()
        const parent = parentId
          ? metadata.folders.find((folder) => folder.id === parentId)
          : undefined
        if (parentId && (!parent || parent.section !== section)) {
          set({
            error: translate(
              'auto.components.SessionSidebar.parentFolderMissing',
              'This folder no longer exists.'
            )
          })
          return null
        }
        const error = sessionFolderNameError(metadata.folders, name, undefined, parentId ?? null)
        if (error) {
          set({ error })
          return null
        }
        const id = crypto.randomUUID()
        let next: SessionFolderMetadata = {
          ...metadata,
          folders: [
            ...metadata.folders,
            {
              id,
              name: name.trim(),
              ...(section ? { section } : {}),
              ...(parentId ? { parentId } : {})
            }
          ]
        }
        try {
          // Why one edit: a project is never saved half made, a folder without its settings.
          next = project ? withProjectSettings(next, id, project) : next
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
          return null
        }
        return edit(next) ? id : null
      },
      moveFolder: (id, parentId, section) => {
        const { metadata } = get()
        const folder = metadata.folders.find((entry) => entry.id === id)
        if (!folder) {
          return false
        }
        // Why: two siblings may not share a name, so a move into a folder holding one is refused.
        const error = sessionFolderNameError(
          metadata.folders.filter((entry) => entry.id !== id),
          folder.name,
          undefined,
          parentId
        )
        if (error) {
          set({ error })
          return false
        }
        try {
          return edit(moveSessionFolder(metadata, id, parentId, section))
        } catch (moveError) {
          set({
            error:
              moveError instanceof Error
                ? moveError.message
                : translate(
                    'auto.components.SessionSidebar.moveFolderFailed',
                    'Could not move folder.'
                  )
          })
          return false
        }
      },
      saveSession: (sessionKey, folderId) => {
        try {
          const metadata = moveSessionToFolder(get().metadata, sessionKey, folderId)
          const action = metadata.finishActions?.[sessionKey]
          return edit({
            ...metadata,
            ...(action
              ? {
                  finishActions: {
                    ...metadata.finishActions,
                    [sessionKey]: { ...action, applied: true }
                  }
                }
              : {})
          })
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Could not save this session.'
          })
          return false
        }
      },
      finishForMe: (sessionKey, action) => {
        const current = get().metadata
        const metadata = isSessionSaved(current, sessionKey)
          ? moveSessionToFolder(current, sessionKey, null)
          : current
        return edit({
          ...metadata,
          finishActions: {
            ...metadata.finishActions,
            [sessionKey]: {
              ...action,
              action: 'me',
              applied: true,
              completedAt: Date.now()
            }
          }
        })
      },
      setFinishAction: (sessionKey, action) =>
        save({
          ...get().metadata,
          finishActions: {
            ...get().metadata.finishActions,
            [sessionKey]: action
          }
        }),
      clearFinishAction: (sessionKey) => {
        const { [sessionKey]: _removed, ...finishActions } = get().metadata.finishActions ?? {}
        return save({ ...get().metadata, finishActions })
      },
      renameFolder: (id, name) => {
        const { metadata } = get()
        if (!metadata.folders.some((folder) => folder.id === id)) {
          return false
        }
        const error = sessionFolderNameError(metadata.folders, name, id)
        if (error) {
          set({ error })
          return false
        }
        return edit({
          ...metadata,
          folders: metadata.folders.map((folder) =>
            folder.id === id ? { ...folder, name: name.trim() } : folder
          )
        })
      },
      deleteFolder: (id) => {
        return edit(deleteSessionFolder(get().metadata, id))
      },
      setProjectSettings: (folderId, settings) => {
        try {
          return edit(withProjectSettings(get().metadata, folderId, settings))
        } catch (error) {
          set({ error: error instanceof Error ? error.message : String(error) })
          return false
        }
      },
      readTransferReceipt: (operationId) => storage.load().transferReceipts?.[operationId] ?? null,
      moveSessionDurably: (sessionKey, folderId, operationId) => {
        const before = get().metadata
        const after = transferFolderPlacement(before, sessionKey, folderId, operationId)
        return after === before || (after !== null && edit(after))
      },
      moveSession: (sessionKey, folderId) => get().moveSessions([sessionKey], folderId),
      moveSessions: (sessionKeys, folderId) => {
        try {
          return edit(
            sessionKeys.reduce(
              (metadata, sessionKey) => moveSessionToFolder(metadata, sessionKey, folderId),
              get().metadata
            )
          )
        } catch (error) {
          set({
            error:
              error instanceof Error
                ? error.message
                : translate(
                    'auto.components.SessionSidebar.moveSessionFailed',
                    'Could not move session.'
                  )
          })
          return false
        }
      },
      migrateSessionKey: (fromKey, toKey) => {
        const { metadata, loaded } = get()
        if (!loaded || fromKey === toKey || !holdsSessionFolderKey(metadata, fromKey)) {
          return false
        }
        return moveKey(migrateSessionFolderKey(metadata, fromKey, toKey))
      },
      claimSessionKey: (fromKey, toKey, folderId) => {
        const { metadata } = get()
        const live =
          folderId === null ||
          folderId === SAVED_SESSIONS_FOLDER_ID ||
          metadata.folders.some((folder) => folder.id === folderId)
        return moveKey(
          live
            ? claimSessionFolderKey(metadata, fromKey, toKey, folderId)
            : migrateSessionFolderKey(metadata, fromKey, toKey)
        )
      },
      replaceMetadata: (metadata) => {
        let parsed: SessionFolderMetadata
        try {
          parsed = parseSessionFolderMetadata(metadata)
        } catch {
          set({
            error: translate(
              'auto.components.SessionSidebar.restoreFoldersFailed',
              'Could not restore session folders.'
            )
          })
          return false
        }
        return save(parsed)
      }
    }
  })
}

export const useSessionFolders = createSessionFoldersStore(createLocalSessionFolderStorage())
