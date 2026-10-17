import { sha256 } from './sha256'

/** A computer starts with this many session documents and doubles them when one outgrows omnios. */
export const SESSION_SYNC_SHARDS = 16
/** The most documents of one kind a computer writes: 256 × 32 KB. */
export const SESSION_SYNC_MAX_DOCS = 256

export type DeviceDocKind = 'folders' | 'sessions' | 'projects'

const DOC_LETTER: Record<DeviceDocKind, string> = { folders: 'f', sessions: 's', projects: 'p' }
const DOC_KIND: Record<string, DeviceDocKind> = { f: 'folders', s: 'sessions', p: 'projects' }

/**
 * Each computer writes only its own documents, so two computers never overwrite each other's
 * edits; every computer reads and merges all of them, however many each one wrote. A version
 * without projects reads only `f` and `s` documents, so `p` ones pass it by.
 */
export const deviceDocKey = (device: string, kind: DeviceDocKind, index: number) =>
  `omni-ide.sync.d.${device}.${DOC_LETTER[kind]}.${index}`
const DEVICE_DOC = /^omni-ide\.sync\.d\.([0-9a-f]{8})\.([fsp])\.(\d{1,3})$/

export function parseDeviceDocKey(key: string): { device: string; kind: DeviceDocKind } | null {
  const match = DEVICE_DOC.exec(key)
  if (!match || Number(match[3]) >= SESSION_SYNC_MAX_DOCS) {
    return null
  }
  return { device: match[1]!, kind: DOC_KIND[match[2]!]! }
}

/** Folder workspaces by id, to their folder path on the computer that runs them. */
export type FolderPaths = Readonly<Record<string, string>>

/**
 * A workspace as every computer names it: its path, without the repo id one client gave a git
 * worktree or the id a client gave a folder workspace. Null for a folder workspace this computer
 * has not loaded.
 */
function sharedWorkspace(worktreeId: string, folderPaths: FolderPaths): string | null {
  if (worktreeId.startsWith('folder:')) {
    return folderPaths[worktreeId.slice('folder:'.length)] ?? null
  }
  const separator = worktreeId.indexOf('::')
  return separator === -1 ? worktreeId : worktreeId.slice(separator + 2)
}

function parseSessionKey(localKey: string): unknown[] | null {
  try {
    const parsed: unknown = JSON.parse(localKey)
    return Array.isArray(parsed) && parsed.length >= 3 ? parsed : null
  } catch {
    return null
  }
}

/**
 * Whether a key not synced now may be later: a pane until its provider session is known, or a
 * session in a folder workspace this computer has not loaded yet. Other keys never sync.
 */
export function mayBecomeSyncable(localKey: string): boolean {
  const kind = parseSessionKey(localKey)?.[1]
  return kind === 'pane' || kind === 'provider'
}

export const isProvisionalSessionKey = (localKey: string) =>
  parseSessionKey(localKey)?.[1] === 'pane'

/**
 * What every computer calls the same session. Folder, tag and archive keys name a session from
 * the computer showing it (`[hostId, kind, ...]`): a session is `local` on its own computer and
 * `runtime:<id>` on one paired with it, and its workspace carries each client's own id. Without
 * them, a provider session (workspace path, agent, session id) or a structured session's id is
 * the same everywhere. Pane keys are provisional, until the provider session is known, and are
 * not synced.
 */
export function canonicalSessionKey(
  localKey: string,
  folderPaths: FolderPaths = {}
): string | null {
  const parsed = parseSessionKey(localKey)
  if (!parsed) {
    return null
  }
  const [, kind, ...rest] = parsed
  if (
    (kind !== 'provider' && kind !== 'structured') ||
    !rest.every((part) => typeof part === 'string' && part.length > 0)
  ) {
    return null
  }
  if (kind === 'provider') {
    const [worktree, ...claim] = (rest[0] as string).split('\0')
    const workspace = sharedWorkspace(worktree!, folderPaths)
    return workspace === null
      ? null
      : JSON.stringify([kind, [workspace, ...claim].join('\0'), ...rest.slice(1)])
  }
  return JSON.stringify([kind, ...rest])
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

/** A short, fixed-width name for a session in the synced documents: 96 bits of SHA-256. */
export function sessionSyncDigest(canonicalKey: string): string {
  return hex(sha256(new TextEncoder().encode(canonicalKey)).subarray(0, 12))
}

/**
 * The document one entry lives in when a computer writes `count` of them (a power of two, so
 * doubling splits each document in two). Sessions go by their digest, folders by a hash of their id.
 */
export function syncDocIndex(kind: DeviceDocKind, id: string, count: number): number {
  const digest = kind === 'sessions' ? id : sessionSyncDigest(id)
  return Number.parseInt(digest.slice(0, 4), 16) % count
}

/** The digest of a local key, or null for a key that is not synced. */
export function localKeyDigest(localKey: string, folderPaths: FolderPaths = {}): string | null {
  const canonical = canonicalSessionKey(localKey, folderPaths)
  return canonical ? sessionSyncDigest(canonical) : null
}
