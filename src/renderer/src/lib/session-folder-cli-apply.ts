import { translate } from '@/i18n/i18n'
import type {
  SessionFolderMutationResult,
  SessionFolderOp
} from '../../../shared/session-folder-cli'
import { SAVED_SESSIONS_LABEL } from '../../../shared/session-folder-ref'
import { archiveSleepViaOf } from '../../../shared/archive-sleep-contract'
import type { OrganizationExecutor } from '../../../shared/session-organization-change'
import { withArchiveExecutor } from './session-archive-events'
import { sessionFolderEntry, sessionFolderRevealKeys } from './session-folder-cli-list'
import {
  fail,
  OpError,
  resolve,
  resolveFolder,
  targetLabel,
  type OpOutcome,
  type SessionFolderCliSession,
  type SessionFolderCliStores
} from './session-folder-cli-op-helpers'
import { applyDeleteFolder, applyReorderFolder } from './session-folder-cli-folder-ops'
import { applyArchiveSession, applyDeleteSession } from './session-folder-cli-session-ops'
import type { SessionFolderUndo } from './session-folder-cli-undo'
import {
  isSessionFolderColor,
  SESSION_FOLDER_COLORS,
  type SessionFolderColor
} from './session-folder-colors'
import { SAVED_SESSIONS_FOLDER_ID } from './session-folders'
import { sessionFolderGroupKey } from './session-sidebar-view'

export type {
  SessionFolderCliSession,
  SessionFolderCliStores
} from './session-folder-cli-op-helpers'

export type AppliedSessionFolderOp =
  | { ok: true; result: SessionFolderMutationResult; undo: SessionFolderUndo; reveal: string[] }
  | { ok: false; error: string }

/** Names people use for the colors the picker labels differently. */
const COLOR_ALIASES: Record<string, string> = { yellow: 'amber', purple: 'violet', grey: 'gray' }

export function parseSessionFolderColor(color: string | null): SessionFolderColor | null {
  if (color === null || color.toLowerCase() === 'none') {
    return null
  }
  const name = COLOR_ALIASES[color.toLowerCase()] ?? color.toLowerCase()
  return isSessionFolderColor(name)
    ? name
    : fail(`Unknown color "${color}". Use one of: ${SESSION_FOLDER_COLORS.join(', ')}, or none.`)
}

/**
 * Applies one CLI operation through the same store actions the sidebar uses, and returns what
 * changed, how to take it back, and which groups to open so the change is seen. Store refusals
 * (a clashing name, a folder moved into itself) come back as the store's own error text.
 */
export function applySessionFolderOp(
  op: SessionFolderOp,
  stores: SessionFolderCliStores,
  session: SessionFolderCliSession | null = null,
  /** Who asked (the relayed change's executor); a bare CLI request is the plain CLI. */
  executor?: OrganizationExecutor
): AppliedSessionFolderOp {
  const folderState = stores.folders.getState()
  if (!folderState.loaded) {
    folderState.load()
  }
  if (!stores.view.getState().loaded) {
    stores.view.getState().load()
  }
  const before = stores.folders.getState().metadata
  stores.folders.setState({ error: null })
  const storeError = (fallback: string): string => stores.folders.getState().error ?? fallback
  try {
    // Why the scope: a CLI or pane agent's archive only arms the idle timer, never a person's sleep.
    const applied = withArchiveExecutor(executor ? archiveSleepViaOf(executor) : 'cli', () =>
      applyOp(op, stores, session, storeError)
    )
    return {
      ok: true,
      ...applied,
      undo: { ...applied.undo, before, after: stores.folders.getState().metadata }
    }
  } catch (error) {
    if (error instanceof OpError) {
      return { ok: false, error: error.message }
    }
    throw error
  }
}

function applyOp(
  op: SessionFolderOp,
  stores: SessionFolderCliStores,
  session: SessionFolderCliSession | null,
  storeError: (fallback: string) => string
): OpOutcome {
  const store = stores.folders.getState()
  const { folders } = store.metadata
  const entry = (id: string): SessionFolderMutationResult['folder'] => {
    const metadata = stores.folders.getState().metadata
    const folder = metadata.folders.find((candidate) => candidate.id === id)
    return folder ? sessionFolderEntry(metadata, stores.view.getState().view, folder) : undefined
  }
  const reveal = (folderId: string | null, saved: boolean): string[] =>
    sessionFolderRevealKeys(stores.folders.getState().metadata, folderId, saved)
  switch (op.kind) {
    case 'reorderFolder':
      return applyReorderFolder(op, stores, storeError)
    case 'deleteFolder':
      return applyDeleteFolder(op, stores, storeError)
    case 'archiveSession':
      return applyArchiveSession(op, stores, session)
    case 'deleteSession':
      return applyDeleteSession(op, stores, session)
    case 'createFolder': {
      const parent = op.parent ? resolve(folders, op.parent) : null
      const parentFolder = parent?.kind === 'folder' ? parent.folder : undefined
      const saved = parent
        ? parent.kind === 'saved-root' || parentFolder?.section === 'saved'
        : op.saved === true
      const id =
        store.createFolder(op.name, saved ? 'saved' : undefined, parentFolder?.id) ??
        fail(storeError('Could not create the folder.'))
      const created = entry(id)
      return {
        result: {
          summary: translate('conversations.cliFolders.created', 'Created folder “{{path}}”', {
            path: created?.path ?? op.name
          }),
          folder: created
        },
        undo: {},
        reveal: reveal(id, saved)
      }
    }
    case 'moveFolder': {
      const folder = resolveFolder(folders, op.folder)
      const into = op.into ? resolve(folders, op.into) : null
      const parentId = into?.kind === 'folder' ? into.folder.id : null
      const section = into?.kind === 'saved-root' ? 'saved' : into ? undefined : op.section
      if (!store.moveFolder(folder.id, parentId, section)) {
        fail(storeError('Could not move the folder.'))
      }
      const saved = entry(folder.id)?.section === 'saved'
      const destination = into
        ? targetLabel(folders, into)
        : saved
          ? SAVED_SESSIONS_LABEL
          : translate('conversations.cliFolders.topOfConversations', 'the top of Conversations')
      return {
        result: {
          summary: translate(
            'conversations.cliFolders.movedFolder',
            'Moved folder “{{name}}” into {{destination}}',
            {
              name: folder.name,
              destination: into ? `“${destination}”` : destination
            }
          ),
          folder: entry(folder.id)
        },
        undo: {},
        reveal: reveal(parentId, saved)
      }
    }
    case 'renameFolder': {
      const folder = resolveFolder(folders, op.folder)
      if (!store.renameFolder(folder.id, op.name)) {
        fail(storeError('Could not rename the folder.'))
      }
      return {
        result: {
          summary: translate(
            'conversations.cliFolders.renamed',
            'Renamed folder “{{from}}” to “{{to}}”',
            {
              from: folder.name,
              to: op.name.trim()
            }
          ),
          folder: entry(folder.id)
        },
        undo: {},
        reveal: reveal(folder.parentId ?? null, folder.section === 'saved')
      }
    }
    case 'colorFolder': {
      const target = resolve(folders, op.folder)
      const color = parseSessionFolderColor(op.color)
      const key =
        target.kind === 'folder'
          ? sessionFolderGroupKey(target.folder.id)
          : SAVED_SESSIONS_FOLDER_ID
      const previous = stores.view.getState().view.colors?.[key] ?? null
      stores.view.getState().setGroupColor(key, color)
      const name = targetLabel(folders, target)
      return {
        result: {
          summary: color
            ? translate('conversations.cliFolders.colored', 'Colored folder “{{name}}” {{color}}', {
                name,
                color
              })
            : translate(
                'conversations.cliFolders.uncolored',
                'Cleared the color of folder “{{name}}”',
                { name }
              ),
          ...(target.kind === 'folder' ? { folder: entry(target.folder.id) } : {})
        },
        undo: { color: { key, before: previous, after: color } },
        reveal: []
      }
    }
    case 'moveSession': {
      const moving = session ?? fail('That conversation is not in the sidebar.')
      const target =
        op.destination === 'folder'
          ? resolve(folders, op.folder ?? '')
          : op.destination === 'saved'
            ? ({ kind: 'saved-root' } as const)
            : null
      const folderId = target
        ? target.kind === 'folder'
          ? target.folder.id
          : SAVED_SESSIONS_FOLDER_ID
        : null
      if (!store.moveSessions([moving.key], folderId)) {
        fail(storeError('Could not move the conversation.'))
      }
      return {
        result: {
          summary: target
            ? translate(
                'conversations.cliFolders.movedSession',
                'Moved “{{session}}” into “{{destination}}”',
                {
                  session: moving.label,
                  destination: targetLabel(folders, target)
                }
              )
            : translate(
                'conversations.cliFolders.unfiledSession',
                'Took “{{session}}” out of its folder',
                {
                  session: moving.label
                }
              ),
          sessionKey: moving.key,
          ...(target?.kind === 'folder' ? { folder: entry(target.folder.id) } : {})
        },
        undo: {},
        reveal: target ? reveal(target.kind === 'folder' ? target.folder.id : null, true) : []
      }
    }
  }
}
