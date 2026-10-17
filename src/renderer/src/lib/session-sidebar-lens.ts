import { translate } from '@/i18n/i18n'
import { KNOWN_COMPANY_FOLDER_NAMES } from '../../../shared/session-project-folder'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { conversationViewKey } from './conversation-view'
import type { SessionBatchOrigins } from './session-batch-origins'
import { sessionFolderRowState } from './session-folder-rollup'
import { SAVED_SESSIONS_FOLDER_ID, type SessionFolder } from './session-folders'
import type {
  SessionSidebarLensGroupKind,
  SessionSidebarTreeRow
} from './session-sidebar-group-model'
import {
  SESSION_LENS_GROUP_PREFIX,
  SESSION_SIDEBAR_LENS_VALUES,
  type SessionSidebarView
} from './session-sidebar-view'
import type { SidebarSession } from './sidebar-sessions'
import { sessionStatusLensClassifier } from './session-sidebar-status-lens'

/**
 * The Group-by views that regroup every row by something other than its folder (Session Focus
 * Plan §11). They only change what this device draws: no folder membership, no record.
 */
export const SESSION_SIDEBAR_LENSES =
  SESSION_SIDEBAR_LENS_VALUES satisfies readonly SessionSidebarLensGroupKind[]
export type SessionSidebarLens = SessionSidebarLensGroupKind

export function sessionSidebarLens(
  view: Pick<SessionSidebarView, 'lens'>
): SessionSidebarLens | null {
  return view.lens ?? null
}

export function sessionLensGroupKey(lens: SessionSidebarLens, id: string): string {
  return `${SESSION_LENS_GROUP_PREFIX}${lens}:${id}`
}

/** The Computer bucket of rows whose host is not known; no execution host id takes this form. */
export const UNKNOWN_COMPUTER_BUCKET_ID = 'unknown'

/** The bucket a Computer lens group lists (a host id, or the unknown bucket); null for any other group. */
export function computerLensBucketId(group: { kind: string; key: string }): string | null {
  const prefix = sessionLensGroupKey('computer', '')
  return group.kind === 'computer' && group.key.startsWith(prefix)
    ? group.key.slice(prefix.length)
    : null
}

/** What the lenses read besides the rows; each part is optional and falls back to "none". */
export type SessionSidebarLensContext = {
  origins?: Pick<SessionBatchOrigins, 'folders' | 'sessions'>
  /** Execution host id → its name and whether it can be reached now. */
  hosts?: ReadonlyMap<string, { label: string; reachable: boolean }>
  /** The company a session is tagged with, chosen or read from its working folder. */
  companyOf?: (session: SidebarSession) => { id: string; label: string } | null
}

/** One lens bucket: `order` sorts buckets, lower first; the fallback bucket sorts last. */
export type SessionLensBucket = { id: string; label: string; order: number }

const LAST = Number.MAX_SAFE_INTEGER

export type SessionLensClassifier = (row: SessionSidebarTreeRow) => SessionLensBucket

type FolderChain = (folderId: string | null) => SessionFolder[]

function folderChains(folders: readonly SessionFolder[]): FolderChain {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  return (folderId) => {
    const chain: SessionFolder[] = []
    let folder = folderId ? byId.get(folderId) : undefined
    while (folder && !chain.includes(folder)) {
      chain.unshift(folder)
      folder = folder.parentId ? byId.get(folder.parentId) : undefined
    }
    return chain
  }
}

const KNOWN_COMPANIES = KNOWN_COMPANY_FOLDER_NAMES

function requestClassifier(context: SessionSidebarLensContext, chainOf: FolderChain) {
  const origins = context.origins ?? { folders: {}, sessions: {} }
  const byBatch = new Map(
    Object.values(origins.folders).map((origin) => [origin.batchId, origin] as const)
  )
  const none: SessionLensBucket = {
    id: 'none',
    label: translate('conversations.groupBy.noRequest', 'Not from a request'),
    order: LAST
  }
  return (row: SessionSidebarTreeRow): SessionLensBucket => {
    const batchId =
      origins.sessions[conversationViewKey(row.session)]?.batchId ??
      chainOf(row.folderId)
        .map((folder) => origins.folders[folder.id]?.batchId)
        .findLast(Boolean)
    if (!batchId) {
      return none
    }
    const origin = byBatch.get(batchId)
    return {
      id: batchId,
      label:
        origin?.requestExcerpt ||
        translate('conversations.groupBy.launchedTogether', 'Launched together'),
      // Why: the newest request first; one this device only knows by id follows the named ones.
      order: origin ? -origin.createdAt : 0
    }
  }
}

/** A top-level folder named after a company holds projects; any other top-level folder is one. */
function companyRoot(chain: readonly SessionFolder[]): SessionFolder | null {
  const root = chain[0]
  return root && KNOWN_COMPANIES.has(root.name.trim().toLowerCase()) ? root : null
}

function projectClassifier(folders: readonly SessionFolder[], chainOf: FolderChain) {
  const index = new Map(folders.map((folder, at) => [folder.id, at]))
  return (row: SessionSidebarTreeRow): SessionLensBucket => {
    const chain = chainOf(row.folderId)
    const project = companyRoot(chain) ? chain[1] : chain[0]
    if (!project) {
      return {
        id: 'none',
        label:
          row.folderId === SAVED_SESSIONS_FOLDER_ID
            ? translate('conversations.savedSessions', 'Saved Sessions')
            : translate('conversations.groupBy.noProject', 'No project'),
        order: row.folderId === SAVED_SESSIONS_FOLDER_ID ? LAST - 1 : LAST
      }
    }
    // Why: saved projects lead, then the working folders, each in the person's folder order.
    const order = (index.get(project.id) ?? 0) + (project.section === 'saved' ? 0 : folders.length)
    return {
      id: project.id === SAVED_SESSIONS_FOLDER_ID ? 'none' : project.id,
      label: project.name,
      order
    }
  }
}

function companyClassifier(context: SessionSidebarLensContext, chainOf: FolderChain) {
  return (row: SessionSidebarTreeRow): SessionLensBucket => {
    const root = companyRoot(chainOf(row.folderId))
    const tagged = root ? null : context.companyOf?.(row.session)
    const label = root
      ? KNOWN_COMPANIES.get(root.name.trim().toLowerCase())!
      : (tagged?.label ?? null)
    if (!label) {
      return {
        id: 'none',
        label: translate('conversations.groupBy.noCompany', 'No company'),
        order: LAST
      }
    }
    // Why by name: a company folder and a company tag are the same company.
    return { id: label.toLowerCase(), label, order: 0 }
  }
}

function computerClassifier(context: SessionSidebarLensContext) {
  return (row: SessionSidebarTreeRow): SessionLensBucket => {
    const hostId = row.session.displayHostId ?? row.session.hostId
    // Why apart from this computer: a row with no known host may be a paired computer's.
    if (!hostId) {
      return {
        id: UNKNOWN_COMPUTER_BUCKET_ID,
        label: translate('conversations.groupBy.unknownComputer', 'Unknown computer'),
        order: 1
      }
    }
    if (hostId === LOCAL_EXECUTION_HOST_ID) {
      return {
        id: hostId,
        label: translate('conversations.groupBy.thisComputer', 'This computer'),
        order: -1
      }
    }
    const host = context.hosts?.get(hostId)
    const name = host?.label ?? hostId
    return {
      id: hostId,
      // Why: a computer out of reach still lists its sessions, marked so nobody reads them as live.
      label:
        host?.reachable === false
          ? translate('conversations.groupBy.hostCantSee', "{{host}} · can't see", { host: name })
          : name,
      order: 0
    }
  }
}

/** What stands between each session and done, most pressing first ("what's blocking"). */
export const SESSION_BLOCKING_CLASSES = [
  'stalled',
  'cantSee',
  'working',
  'waitingOthers',
  'waitingWork',
  'waitingTime',
  'stopped',
  'idle',
  'finished'
] as const
export type SessionBlockingClass = (typeof SESSION_BLOCKING_CLASSES)[number]

export function sessionBlockingClass(
  row: SessionSidebarTreeRow,
  classification?: string
): SessionBlockingClass {
  const state = sessionFolderRowState(row, classification)
  // Why first: an unreachable row is unknown, so it is never reported as finished or stalled.
  if (state === 'cantSee') {
    return 'cantSee'
  }
  if (row.run?.phase === 'recovering') {
    return 'stalled'
  }
  switch (state) {
    case 'working':
      return 'working'
    case 'stopped':
      return 'stopped'
    case 'done':
      return 'finished'
    case 'waiting':
    case 'needsYou':
      return row.waitingUntil
        ? 'waitingTime'
        : row.state === 'monitoring' || (row.backgroundTaskCount ?? 0) > 0
          ? 'waitingWork'
          : 'waitingOthers'
    case null:
      return 'idle'
  }
}

function blockingLabel(kind: SessionBlockingClass): string {
  switch (kind) {
    case 'stalled':
      return translate('conversations.groupBy.stalled', 'Stalled · retrying')
    case 'cantSee':
      return translate('conversations.groupBy.cantSee', "Can't see")
    case 'working':
      return translate('conversations.groupBy.working', 'Working')
    case 'waitingOthers':
      return translate('conversations.groupBy.waitingOthers', 'Waiting on others')
    case 'waitingWork':
      return translate('conversations.groupBy.waitingWork', 'Waiting on background work')
    case 'waitingTime':
      return translate('conversations.groupBy.waitingTime', 'Waiting until later')
    case 'stopped':
      return translate('conversations.groupBy.stopped', 'Stopped')
    case 'idle':
      return translate('conversations.groupBy.idle', 'Idle')
    case 'finished':
      return translate('conversations.groupBy.finished', 'Finished')
  }
}

/** The bucket each row falls in under `lens`; `classificationOf` reads the tree's own grouping. */
export function sessionLensClassifier(
  lens: SessionSidebarLens,
  args: {
    folders: readonly SessionFolder[]
    context: SessionSidebarLensContext
    classificationOf: (row: SessionSidebarTreeRow) => string | undefined
  }
): SessionLensClassifier {
  const chainOf = folderChains(args.folders)
  switch (lens) {
    case 'state':
      return sessionStatusLensClassifier(args.classificationOf)
    case 'request':
      return requestClassifier(args.context, chainOf)
    case 'project':
      return projectClassifier(args.folders, chainOf)
    case 'company':
      return companyClassifier(args.context, chainOf)
    case 'computer':
      return computerClassifier(args.context)
    case 'blocking':
      return (row) => {
        const kind = sessionBlockingClass(row, args.classificationOf(row))
        return {
          id: kind,
          label: blockingLabel(kind),
          order: SESSION_BLOCKING_CLASSES.indexOf(kind)
        }
      }
  }
}
