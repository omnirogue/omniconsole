import type { SessionPrepNativeReceipt } from './session-prep-connector-launch'
import type {
  SessionBatchFolderOrigin,
  SessionBatchSessionOrigin
} from '../../shared/session-batch-origin'
import type {
  SessionFolderListResult,
  SessionFolderMutationResult,
  SessionFolderOp,
  SessionFolderRelayRequest
} from '../../shared/session-folder-cli'
import {
  resolveSessionFolderRef,
  SAVED_SESSIONS_LABEL,
  SAVED_SESSIONS_REF_ID,
  sessionFolderRefSegments
} from '../../shared/session-folder-ref'
import { launchFilingReason } from '../../shared/session-organization-change'
import type { OrganizationChangeLedger } from '../session-organization/organization-change-ledger'
import { recordedFolderRelay } from '../session-organization/organization-relayed-mutation'

/**
 * Files a launched session in the Conversations sidebar folder the person named, creating the
 * folder when it does not exist yet. Same operations as `omni folder create` and
 * `omni terminal create --folder`: the runtime relays each one to the window that owns the
 * folders (see shared/session-folder-cli.ts), so a closed window fails here, never the launch.
 */

export type SessionPrepFolderRequest = (request: SessionFolderRelayRequest) => Promise<unknown>

export type SessionPrepFilingRecorder = Pick<OrganizationChangeLedger, 'prepare' | 'settle'>

/** Every folder change filing makes is recorded as launch filing, with the request's words. */
export function recordedSessionPrepRequest(
  request: SessionPrepFolderRequest,
  recorder: SessionPrepFilingRecorder,
  launchRequest?: string
): SessionPrepFolderRequest {
  const words = launchRequest?.trim()
  return recordedFolderRelay(recorder, request, {
    executor: { kind: 'launch', source: 'session-prep' },
    reason: launchFilingReason(words),
    ...(words ? { request: words } : {})
  })
}

/** The sidebar row of a just-launched session. */
export type SessionPrepLaunchedSurface = {
  tabId?: string
  paneKey?: string | null
  nativeReceipt?: SessionPrepNativeReceipt
}

/** How long filing waits for the new session's row to be listed (as the CLI does). */
export const SESSION_PREP_FOLDER_WAIT_MS = 5_000

export type ResolvedFolder = { id: string; path: string }

// Why by message: resolveSessionFolderRef reports "none" and "ambiguous" as text; only "none"
// may be created, an ambiguous path must not add a third look-alike folder.
function isNotFound(error: string): boolean {
  return error.startsWith('No folder matches')
}

async function listFolders(request: SessionPrepFolderRequest) {
  const listed = (await request({ kind: 'list' })) as SessionFolderListResult | undefined
  return listed?.folders ?? []
}

export async function resolveExistingSessionPrepFolder(
  request: SessionPrepFolderRequest,
  id: string
): Promise<ResolvedFolder> {
  const folder = (await listFolders(request)).find((entry) => entry.id === id)
  if (!folder) {
    throw new Error('The project folder no longer exists.')
  }
  return { id: folder.id, path: folder.path }
}

async function mutate(
  request: SessionPrepFolderRequest,
  op: SessionFolderOp
): Promise<SessionFolderMutationResult> {
  return (await request({ kind: 'mutate', op })) as SessionFolderMutationResult
}

/**
 * The folder at `path`, created with any missing trailing segments. A new folder nests under the
 * deepest part of the path that exists (so "OmniRogue / Prototypes" lands under Saved Sessions
 * when "Saved Sessions / OmniRogue" is there); with none, it starts where the path says.
 */
export async function ensureSessionPrepFolder(
  request: SessionPrepFolderRequest,
  path: string
): Promise<ResolvedFolder> {
  const folders = await listFolders(request)
  const found = resolveSessionFolderRef(folders, path)
  if (found.ok) {
    return found.target.kind === 'folder'
      ? { id: found.target.folder.id, path: found.target.folder.path }
      : { id: SAVED_SESSIONS_REF_ID, path: SAVED_SESSIONS_LABEL }
  }
  if (!isNotFound(found.error)) {
    throw new Error(found.error)
  }
  const names = path
    .split('/')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  const savedRoot =
    sessionFolderRefSegments(names[0] ?? '')[0] === SAVED_SESSIONS_LABEL.toLowerCase()
  const segments = savedRoot ? names.slice(1) : names
  const prefix = savedRoot ? [SAVED_SESSIONS_LABEL] : []
  let parent: ResolvedFolder | null = null
  let start = 0
  for (let depth = segments.length - 1; depth >= 1; depth -= 1) {
    const existing = resolveSessionFolderRef(
      folders,
      [...prefix, ...segments.slice(0, depth)].join(' / ')
    )
    if (existing.ok && existing.target.kind === 'folder') {
      parent = { id: existing.target.folder.id, path: existing.target.folder.path }
      start = depth
      break
    }
    if (!existing.ok && !isNotFound(existing.error)) {
      throw new Error(existing.error)
    }
  }
  for (const name of segments.slice(start)) {
    const created: SessionFolderMutationResult = await mutate(request, {
      kind: 'createFolder',
      name,
      ...(parent ? { parent: parent.id } : savedRoot ? { saved: true } : {})
    })
    if (!created.folder) {
      throw new Error(`Could not create the folder "${name}".`)
    }
    parent = { id: created.folder.id, path: created.folder.path }
  }
  if (!parent) {
    throw new Error('Name a folder by its path.')
  }
  return parent
}

/** How many look-alike names a batch folder tries before it gives up (" · 2" … " · 9"). */
const BATCH_FOLDER_NAME_ATTEMPTS = 9

/**
 * A new top-level Active folder for one launch batch. Never reuses a folder of the same name:
 * a taken name gets the next numbered suffix. Its origin is recorded best-effort; a folder with
 * no recorded origin simply reads as the person's.
 */
export async function createSessionPrepBatchFolder(
  request: SessionPrepFolderRequest,
  args: {
    name: (attempt: number) => string
    origin: Omit<SessionBatchFolderOrigin, 'folderId'>
  }
): Promise<ResolvedFolder> {
  // Why every top-level name: top-level folder names are unique across both sections.
  const taken = new Set(
    (await listFolders(request))
      .filter((folder) => folder.parentId === null)
      .map((folder) => folder.name.trim().toLowerCase())
  )
  let name: string | null = null
  for (let attempt = 1; attempt <= BATCH_FOLDER_NAME_ATTEMPTS && name === null; attempt += 1) {
    const candidate = args.name(attempt)
    if (!taken.has(candidate.toLowerCase())) {
      name = candidate
    }
  }
  if (name === null) {
    throw new Error(`folders named “${args.name(1)}” already exist`)
  }
  const created = await mutate(request, { kind: 'createFolder', name })
  if (!created.folder) {
    throw new Error(`Could not create the folder "${name}".`)
  }
  const folder = { id: created.folder.id, path: created.folder.path }
  await request({
    kind: 'recordBatchFolder',
    origin: { ...args.origin, folderId: folder.id }
  }).catch(() => undefined)
  return folder
}

/** Remembers which batch item a filed session came from; best-effort, like the folder's own. */
export async function recordSessionPrepSessionOrigin(
  request: SessionPrepFolderRequest,
  sessionKey: string | undefined,
  origin: SessionBatchSessionOrigin
): Promise<void> {
  if (sessionKey) {
    await request({ kind: 'recordBatchSession', sessionKey, origin }).catch(() => undefined)
  }
}

/** Files the session and answers with its folder-membership key, when the window gave one. */
export async function moveSessionPrepSession(
  request: SessionPrepFolderRequest,
  surface: SessionPrepLaunchedSurface,
  folder: ResolvedFolder
): Promise<string | undefined> {
  const paneKey = surface.paneKey ?? undefined
  if (!paneKey && !surface.tabId) {
    throw new Error('the new session has no sidebar row yet')
  }
  const target: SessionFolderOp = {
    kind: 'moveSession',
    ...(paneKey ? { paneKey } : {}),
    ...(surface.tabId ? { tabId: surface.tabId } : {}),
    ...(folder.id === SAVED_SESSIONS_REF_ID
      ? { destination: 'saved' as const }
      : { destination: 'folder' as const, folder: folder.id }),
    waitMs: SESSION_PREP_FOLDER_WAIT_MS
  }
  return (await mutate(request, target)).sessionKey
}
