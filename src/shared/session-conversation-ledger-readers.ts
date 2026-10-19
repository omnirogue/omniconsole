/**
 * Lenient readers for the owner conversation ledger (session-conversation-ledger-contract.ts).
 * Rule 1 on every path: unknown fields are dropped, an unreadable record is dropped rather than
 * trusted, every unknown value degrades to the reading that asserts least, and whatever had to be
 * dropped or cut turns that workspace's coverage incomplete so a set never proves an absence it
 * may have caused itself. No reader looks at `prompt`, `launchConfig`, `agentArgs`, `agentEnv`,
 * `transcriptPath`, `lastAssistantMessage` or project settings: they only ever pick known keys.
 */

import type { AgentProviderSessionKey } from './agent-session-resume'
import {
  SESSION_CONVERSATION_LEDGER_LIMITS,
  SESSION_CONVERSATION_LEDGER_SOURCES,
  SESSION_CONVERSATION_PROVIDER_SESSION_KEYS,
  SESSION_CONVERSATION_RESTS,
  SESSION_CONVERSATION_SURFACES,
  SESSION_CONVERSATION_TITLE_SOURCES,
  isSessionConversationIdentity,
  sessionConversationPaneIdentity,
  sessionConversationRecordIdentity,
  type RuntimeSessionConversationLedger,
  type RuntimeSessionConversationLedgerDelta,
  type RuntimeSessionConversationRecord,
  type SessionConversationArchiveMark,
  type SessionConversationLedgerCoverage,
  type SessionConversationLedgerWindowPublication,
  type SessionConversationProviderSession
} from './session-conversation-ledger-contract'

import {
  readSessionConversationLedgerFolders,
  readSessionConversationLedgerProjects
} from './session-conversation-ledger-catalog-readers'
import {
  asObject,
  boundedText,
  count,
  isRevision,
  oneOf
} from './session-conversation-ledger-read-primitives'
import { readSessionConversationLedgerRemovals } from './session-conversation-ledger-removals'

const {
  recordsPerWorkspace: MAX_RECORDS_PER_WORKSPACE,
  workspaces: MAX_WORKSPACES,
  totalRecords: MAX_TOTAL_RECORDS,
  title: MAX_TITLE,
  id: MAX_ID,
  paneKey: MAX_PANE_KEY,
  worktreeId: MAX_WORKTREE_ID
} = SESSION_CONVERSATION_LEDGER_LIMITS

// Why these fallbacks: each is the reading that asserts least — a rest nobody can act on, a row
// with no pane to join, a title with no claim of being the person's own, a set that never removes.
const readRest = oneOf(SESSION_CONVERSATION_RESTS, 'unknown')
const readSurface = oneOf(SESSION_CONVERSATION_SURFACES, 'record')
const readTitleSource = oneOf(SESSION_CONVERSATION_TITLE_SOURCES, 'generated')
const readSource = oneOf(SESSION_CONVERSATION_LEDGER_SOURCES, 'main')

function readProviderSession(value: unknown): SessionConversationProviderSession | null {
  const raw = asObject(value)
  const id = raw ? boundedText(raw.id, MAX_ID) : null
  const key = raw?.key
  return id && (SESSION_CONVERSATION_PROVIDER_SESSION_KEYS as readonly unknown[]).includes(key)
    ? { key: key as AgentProviderSessionKey, id }
    : null
}

function readArchiveMark(value: unknown): SessionConversationArchiveMark | undefined {
  const raw = asObject(value)
  if (typeof raw?.archived !== 'boolean') {
    return undefined
  }
  return {
    archived: raw.archived,
    ...(typeof raw.byHand === 'boolean' ? { byHand: raw.byHand } : {})
  }
}

/**
 * One record, or null when it names no conversation at all (no digest-shaped `conversation` and no
 * pane): a row nothing can fold onto or be retired against. Every other defect degrades to the
 * reading that asserts least. Why the sent digest is kept as is: it covers the owner's full claim
 * (transcript path included), which the wire fields cannot rebuild; a receiver compares it with
 * digests of its own claim keys and never overwrites it.
 */
export function readSessionConversationRecord(
  value: unknown
): RuntimeSessionConversationRecord | null {
  const raw = asObject(value)
  if (!raw) {
    return null
  }
  const agent = boundedText(raw.agent, MAX_ID) ?? ''
  const providerSession = readProviderSession(raw.providerSession)
  const paneKey = boundedText(raw.paneKey, MAX_PANE_KEY)
  const sentPaneIdentity = boundedText(raw.paneIdentity, MAX_PANE_KEY + 'pane:'.length)
  const paneIdentity = paneKey
    ? sessionConversationPaneIdentity(paneKey)
    : sentPaneIdentity?.startsWith('pane:')
      ? sentPaneIdentity
      : undefined
  const conversation = isSessionConversationIdentity(raw.conversation) ? raw.conversation : null
  if (conversation === null && paneIdentity === undefined) {
    return null
  }
  const tabId = boundedText(raw.tabId, MAX_ID)
  const archived = readArchiveMark(raw.archived)
  // Why three outcomes: `null` is the owner saying "unfiled"; a missing or unreadable value is unknown.
  const folderId = raw.folderId === null ? null : (boundedText(raw.folderId, MAX_ID) ?? undefined)
  return {
    conversation,
    ...(paneIdentity ? { paneIdentity } : {}),
    agent,
    providerSession,
    title: typeof raw.title === 'string' ? raw.title.slice(0, MAX_TITLE) : '',
    titleSource: readTitleSource(raw.titleSource),
    surface: readSurface(raw.surface),
    ...(paneKey ? { paneKey } : {}),
    ...(tabId ? { tabId } : {}),
    rest: readRest(raw.rest),
    ...(raw.interrupted === true ? { interrupted: true as const } : {}),
    ...(archived ? { archived } : {}),
    ...(folderId !== undefined ? { folderId } : {}),
    ...(typeof raw.saved === 'boolean' ? { saved: raw.saved } : {}),
    ...(typeof raw.hidden === 'boolean' ? { hidden: raw.hidden } : {}),
    ...(raw.agentSession === true ? { agentSession: true as const } : {}),
    // Why default listed: an owner that publishes a row lists it unless it says otherwise; a missing
    // flag must not hide a conversation the owner shows.
    listed: raw.listed !== false,
    updatedAt: count(raw.updatedAt)
  }
}

type ReadBuckets = {
  recordsByWorktree: Record<string, RuntimeSessionConversationRecord[]>
  /** Workspaces with a dropped, duplicate or cut record: their coverage is forced incomplete. */
  incomplete: Set<string>
  /** Workspaces cut at the per-workspace, workspace-count or total cap. */
  truncated: string[]
  /** Records of buckets whose key is no readable workspace id; a set counts them as omitted. */
  rejected: number
}

/** Every workspace's records, validated per workspace; nothing dropped is ever silent. */
function readBuckets(value: unknown, keepEmpty: boolean): ReadBuckets | null {
  const raw = asObject(value)
  if (!raw) {
    return null
  }
  const out: ReadBuckets = {
    recordsByWorktree: {},
    incomplete: new Set(),
    truncated: [],
    rejected: 0
  }
  const entries = Object.entries(raw).filter(([worktreeId, list]) => {
    const fits = worktreeId.length > 0 && worktreeId.length <= MAX_WORKTREE_ID
    // Why counted: a workspace whose id cannot cross must not shrink the owner's total silently.
    out.rejected +=
      fits || !Array.isArray(list) ? 0 : Math.min(list.length, MAX_RECORDS_PER_WORKSPACE)
    return fits
  })
  const cut = (worktreeId: string): void => {
    if (!out.truncated.includes(worktreeId)) {
      out.truncated.push(worktreeId)
    }
    out.incomplete.add(worktreeId)
  }
  entries.slice(MAX_WORKSPACES).forEach(([worktreeId]) => cut(worktreeId))
  let total = 0
  for (const [worktreeId, list] of entries.slice(0, MAX_WORKSPACES)) {
    if (!Array.isArray(list)) {
      out.incomplete.add(worktreeId)
      continue
    }
    if (list.length > MAX_RECORDS_PER_WORKSPACE) {
      cut(worktreeId)
    }
    const records: RuntimeSessionConversationRecord[] = []
    const seen = new Set<string>()
    for (const entry of list.slice(0, MAX_RECORDS_PER_WORKSPACE)) {
      if (total >= MAX_TOTAL_RECORDS) {
        cut(worktreeId)
        break
      }
      const record = readSessionConversationRecord(entry)
      const identity = record ? sessionConversationRecordIdentity(record) : ''
      if (!record || seen.has(identity)) {
        out.incomplete.add(worktreeId)
        continue
      }
      seen.add(identity)
      records.push(record)
      total += 1
    }
    if (records.length > 0 || keepEmpty) {
      out.recordsByWorktree[worktreeId] = records
    }
  }
  return out
}

/**
 * The owner's coverage, one entry per workspace, with every bucket named and every workspace
 * whose records were dropped or cut forced to `complete:false`.
 */
function readCoverage(
  value: unknown,
  buckets: ReadBuckets,
  required: readonly string[]
): SessionConversationLedgerCoverage[] {
  const byWorktree = new Map<string, boolean>()
  for (const entry of Array.isArray(value) ? value.slice(0, MAX_WORKSPACES) : []) {
    const raw = asObject(entry)
    const worktreeId = raw ? boundedText(raw.worktreeId, MAX_WORKTREE_ID) : null
    if (worktreeId && !byWorktree.has(worktreeId)) {
      byWorktree.set(worktreeId, raw?.complete === true)
    }
  }
  for (const worktreeId of required) {
    if (!byWorktree.has(worktreeId)) {
      byWorktree.set(worktreeId, false)
    }
  }
  for (const worktreeId of buckets.incomplete) {
    byWorktree.set(worktreeId, false)
  }
  return [...byWorktree].map(([worktreeId, complete]) => ({ worktreeId, complete }))
}

function readTextList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.slice(0, MAX_WORKSPACES).flatMap((entry) => boundedText(entry, MAX_WORKTREE_ID) ?? [])
    : []
}

type LedgerBody = Omit<
  SessionConversationLedgerWindowPublication,
  'rendererGeneration' | 'listedAt'
>

/** The fields a whole set and a window publication share, validated the same way. */
function readLedgerBody(raw: Record<string, unknown>, buckets: ReadBuckets): LedgerBody {
  const truncatedWorktrees = [
    ...new Set([...readTextList(raw.truncatedWorktrees), ...buckets.truncated])
  ]
  truncatedWorktrees.forEach((worktreeId) => buckets.incomplete.add(worktreeId))
  return {
    coverage: readCoverage(raw.coverage, buckets, [
      ...Object.keys(buckets.recordsByWorktree),
      ...truncatedWorktrees
    ]),
    omitted: {
      unknownHost: count(asObject(raw.omitted)?.unknownHost),
      unverified: count(asObject(raw.omitted)?.unverified) + buckets.rejected
    },
    ...(truncatedWorktrees.length > 0 ? { truncatedWorktrees } : {}),
    folders: readSessionConversationLedgerFolders(raw.folders),
    projects: readSessionConversationLedgerProjects(raw.projects),
    recordsByWorktree: buckets.recordsByWorktree
  }
}

/**
 * The set a listAll field or subscribeAll event carries, or undefined when absent or malformed
 * (unknown: nothing is added or removed). Any workspace with a dropped record reads incomplete, so
 * the set never proves an absence there. A new generation only reorders; removal still needs a
 * live `window` set with complete coverage for the workspace, or a tombstone in `removals`
 * (session-conversation-ledger-removals.ts).
 */
export function readSessionConversationLedger(
  value: unknown
): RuntimeSessionConversationLedger | undefined {
  const raw = asObject(value)
  const buckets = raw ? readBuckets(raw.recordsByWorktree, false) : null
  if (!raw || !buckets || !boundedText(raw.generation, MAX_ID) || !isRevision(raw.revision)) {
    return undefined
  }
  return {
    generation: raw.generation as string,
    revision: raw.revision,
    source: readSource(raw.source),
    listedAt: count(raw.listedAt),
    ...readLedgerBody(raw, buckets),
    ...readSessionConversationLedgerRemovals(raw, 'set')
  }
}

/**
 * A streamed delta, or undefined when absent or malformed. Each bucket it carries replaces that
 * workspace whole; a bucket with a dropped or cut record is marked incomplete in `coverage` so a
 * receiver adds and updates from it but removes nothing (the next inventory brings the whole set).
 */
export function readSessionConversationLedgerDelta(
  value: unknown
): RuntimeSessionConversationLedgerDelta | undefined {
  const raw = asObject(value)
  const buckets = raw ? readBuckets(raw.changedByWorktree, true) : null
  if (
    !raw ||
    !buckets ||
    !boundedText(raw.generation, MAX_ID) ||
    !isRevision(raw.revision) ||
    !isRevision(raw.baseRevision)
  ) {
    return undefined
  }
  return {
    generation: raw.generation as string,
    revision: raw.revision,
    baseRevision: raw.baseRevision,
    source: readSource(raw.source),
    coverage: readCoverage(raw.coverage, buckets, Object.keys(buckets.recordsByWorktree)),
    changedByWorktree: buckets.recordsByWorktree,
    // Why only when sent: absent metadata means unchanged; `[]` alone means the owner has none.
    ...(Array.isArray(raw.folders)
      ? { folders: readSessionConversationLedgerFolders(raw.folders) }
      : {}),
    ...(Array.isArray(raw.projects)
      ? { projects: readSessionConversationLedgerProjects(raw.projects) }
      : {}),
    ...readSessionConversationLedgerRemovals(raw, 'delta')
  }
}

/** The window's publication, validated in main; a dropped record makes its workspace incomplete. */
export function readSessionConversationLedgerPublication(
  value: unknown
): SessionConversationLedgerWindowPublication | null {
  const raw = asObject(value)
  const rendererGeneration = raw ? boundedText(raw.rendererGeneration, MAX_ID) : null
  const buckets = raw ? readBuckets(raw.recordsByWorktree, false) : null
  if (!raw || !rendererGeneration || !buckets) {
    return null
  }
  return { rendererGeneration, listedAt: count(raw.listedAt), ...readLedgerBody(raw, buckets) }
}
