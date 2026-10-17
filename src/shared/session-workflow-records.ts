/**
 * Controller-owned workflow conversation records on the session-tabs wire (session counts,
 * step 9). A workflow conversation (Council, Discover, Evolve, Build + Review …) is an anchor tab
 * with no pane, so terminal-leaf publication never carried it and a paired computer's group for
 * the owner counted a different population than the owner's own list. The controller publishes
 * its whole set as one ordered value (a `workflowRecords` field on `session.tabs.listAll`, a
 * `workflowRecords` event on `session.tabs.subscribeAll`), negotiated by
 * `session-tabs.workflow-records.v1`; a client that did not ask gets today's projection.
 *
 * A workflow belongs to the window that runs it, not to a workspace's terminal inventory, so its
 * presence and removal are judged from the controller's complete set alone: no process census and
 * no workspace omission is evidence about it. Identity is the anchor tab under its controller (the
 * owner's own row identity); the run address is step 8's controller + run id. Only the controller
 * publishes its own records: a receiver keeps mirrored records outside its tabs, so it can never
 * republish a peer's.
 */

import type { SessionWorkflowAnchorStatus } from './session-workflow-anchor'

export const SESSION_WORKFLOW_OPEN_RPC = 'session.workflows.open'
/** The window → its own main process publication channel (never crosses a paired transport). */
export const SESSION_WORKFLOW_RECORDS_SYNC_CHANNEL = 'runtime:syncSessionWorkflowRecords'
/** The subscribeAll event (and listAll field) carrying the controller's whole set. */
export const SESSION_WORKFLOW_RECORDS_EVENT = 'workflowRecords'

/** The controller cannot open it now (no window, or its window has not published); retryable. */
export const SESSION_WORKFLOW_UNVERIFIABLE_CODE = 'session_workflow_unverifiable'
/** The controller's complete publication has no such workflow conversation. */
export const SESSION_WORKFLOW_NOT_FOUND_CODE = 'session_workflow_not_found'
export const SESSION_WORKFLOW_OPEN_REFUSAL_CODES = [
  SESSION_WORKFLOW_UNVERIFIABLE_CODE,
  SESSION_WORKFLOW_NOT_FOUND_CODE
] as const

const MAX_RECORDS_PER_WORKSPACE = 500
const MAX_WORKSPACES = 2000
/** Why a total cap: bounds every set on the wire; a set over it is truncated and incomplete. */
const MAX_TOTAL_RECORDS = 5000
const MAX_TEXT = 500
const MAX_ID = 200

export const SESSION_WORKFLOW_RECORD_STATUSES = [
  'draft',
  'starting',
  'unknown',
  'running',
  'needs-you',
  'done',
  'failed',
  'stopped',
  'missing',
  'unavailable'
] as const satisfies readonly SessionWorkflowAnchorStatus[]

export type RuntimeSessionWorkflowRecord = {
  /** The anchor tab on its controller: the conversation's identity there. */
  tabId: string
  /** Workflow kind (preset or graph template); a receiver shows an unknown one generically. */
  preset: string
  title: string
  /** Step 8's outcome as the controller's window last read it ("run not found", "status unavailable" …). */
  status: SessionWorkflowAnchorStatus
  /** Step 8's run address; null before the run exists (a draft, or Start in flight). */
  runId: string | null
  phase?: string
  /** The machine the run was placed on, display only. */
  host?: string
  origin?: 'cli' | 'benchmark'
  /** The controller's own archive mark for this conversation (the archive reference). */
  archived?: true
}

/** The controller's whole set, ordered by its own generation and revision. */
export type RuntimeSessionWorkflowRecordSet = {
  /** The controller runtime's incarnation; revisions order only within one. */
  generation: string
  /** Monotonic within the generation: bumps on every change to the set or to its completeness. */
  revision: number
  /**
   * The controller's window published its whole set (and is still attached), so a record the set
   * omits is gone. False at startup, while headless, after its window closed, or when any record
   * was malformed or over the cap: such a set adds and updates but removes nothing.
   */
  complete: boolean
  recordsByWorktree: Record<string, RuntimeSessionWorkflowRecord[]>
}

/**
 * A change to the set a stream already delivered: each changed workspace's whole list (`[]` when
 * none is left). Sent only between complete sets on one stream; it applies to any state at least
 * as new as `baseRevision`, since every workspace it omits is unchanged since then.
 */
export type RuntimeSessionWorkflowRecordDelta = {
  generation: string
  revision: number
  baseRevision: number
  complete: true
  changedByWorktree: Record<string, RuntimeSessionWorkflowRecord[]>
}

/** What the window sends its own main process: every workspace's set, all at once. */
export type SessionWorkflowRecordWindowPublication = {
  /** The renderer generation of the graph main holds; any other is refused. */
  rendererGeneration: string
  recordsByWorktree: Record<string, RuntimeSessionWorkflowRecord[]>
  /** False when the window could not restore its sessions (degraded startup): unknown, not none. */
  complete?: boolean
}

/** The publication as main accepted it. */
export type SessionWorkflowRecordPublication = SessionWorkflowRecordWindowPublication & {
  /** False when main dropped a malformed or over-cap record: never complete with silent drops. */
  complete: boolean
}

/**
 * The anchor tab on its controller, by the owner's raw workspace id. The tab is the conversation,
 * so a newer run started in the same tab still opens there.
 */
export type SessionWorkflowOpenParams = { worktree: string; tabId: string }

function boundedText(value: unknown, max = MAX_TEXT): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null
}

function readStatus(value: unknown): SessionWorkflowAnchorStatus | null {
  return (SESSION_WORKFLOW_RECORD_STATUSES as readonly unknown[]).includes(value)
    ? (value as SessionWorkflowAnchorStatus)
    : null
}

/** One record, or null when any required field is malformed. Unknown extra fields are dropped. */
export function readSessionWorkflowRecord(value: unknown): RuntimeSessionWorkflowRecord | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  const tabId = boundedText(raw.tabId, MAX_ID)
  const preset = boundedText(raw.preset, MAX_ID)
  const status = readStatus(raw.status)
  const hasRun = raw.runId !== null && raw.runId !== undefined
  const runId = hasRun ? boundedText(raw.runId, MAX_ID) : null
  const title = typeof raw.title === 'string' ? raw.title.slice(0, MAX_TEXT) : null
  if (!tabId || !preset || !status || title === null || (hasRun && runId === null)) {
    return null
  }
  const phase = boundedText(raw.phase)
  const host = boundedText(raw.host)
  const origin = raw.origin === 'cli' || raw.origin === 'benchmark' ? raw.origin : null
  return {
    tabId,
    preset,
    title,
    status,
    runId,
    ...(phase ? { phase } : {}),
    ...(host ? { host } : {}),
    ...(origin ? { origin } : {}),
    ...(raw.archived === true ? { archived: true as const } : {})
  }
}

/** Every workspace's records, validated; `complete` is false if anything had to be dropped. */
function readRecordsByWorktree(
  value: unknown,
  keepEmpty = false
): { recordsByWorktree: Record<string, RuntimeSessionWorkflowRecord[]>; complete: boolean } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const entries = Object.entries(value as Record<string, unknown>)
  const recordsByWorktree: Record<string, RuntimeSessionWorkflowRecord[]> = {}
  let total = 0
  let complete = entries.length <= MAX_WORKSPACES
  for (const [worktreeId, list] of entries.slice(0, MAX_WORKSPACES)) {
    if (!worktreeId || !Array.isArray(list)) {
      complete = false
      continue
    }
    const records: RuntimeSessionWorkflowRecord[] = []
    const seen = new Set<string>()
    complete &&= list.length <= MAX_RECORDS_PER_WORKSPACE
    for (const entry of list.slice(0, MAX_RECORDS_PER_WORKSPACE)) {
      const record = readSessionWorkflowRecord(entry)
      if (!record || seen.has(record.tabId) || total >= MAX_TOTAL_RECORDS) {
        complete = false
        continue
      }
      seen.add(record.tabId)
      records.push(record)
      total += 1
    }
    if (records.length > 0 || keepEmpty) {
      recordsByWorktree[worktreeId] = records
    }
  }
  return { recordsByWorktree, complete }
}

/**
 * The set a listAll field or subscribeAll event carries, or undefined when absent or malformed
 * (unknown: nothing is added or removed). A set with any dropped record reads as incomplete, so it
 * never proves absence.
 */
export function readSessionWorkflowRecordSet(
  value: unknown
): RuntimeSessionWorkflowRecordSet | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const records = readRecordsByWorktree(raw.recordsByWorktree)
  if (
    typeof raw.generation !== 'string' ||
    raw.generation.length === 0 ||
    typeof raw.revision !== 'number' ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 0 ||
    !records
  ) {
    return undefined
  }
  return {
    generation: raw.generation,
    revision: raw.revision,
    complete: raw.complete === true && records.complete,
    recordsByWorktree: records.recordsByWorktree
  }
}

/**
 * A streamed delta, or undefined when absent or malformed. Why all-or-nothing: a dropped record
 * would read as a removal, so a delta that is not exactly well formed is ignored (the stream's
 * next inventory brings the whole set).
 */
export function readSessionWorkflowRecordDelta(
  value: unknown
): RuntimeSessionWorkflowRecordDelta | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const changed = readRecordsByWorktree(raw.changedByWorktree, true)
  const isRevision = (entry: unknown): entry is number =>
    typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0
  if (
    typeof raw.generation !== 'string' ||
    raw.generation.length === 0 ||
    !isRevision(raw.revision) ||
    !isRevision(raw.baseRevision) ||
    raw.complete !== true ||
    !changed?.complete
  ) {
    return undefined
  }
  return {
    generation: raw.generation,
    revision: raw.revision,
    baseRevision: raw.baseRevision,
    complete: true,
    changedByWorktree: changed.recordsByWorktree
  }
}

/** The renderer's publication, validated in main; a dropped record makes it incomplete. */
export function readSessionWorkflowRecordPublication(
  value: unknown
): SessionWorkflowRecordPublication | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const raw = value as Record<string, unknown>
  const generation = boundedText(raw.rendererGeneration, MAX_ID)
  const records = readRecordsByWorktree(raw.recordsByWorktree)
  return generation && records
    ? {
        rendererGeneration: generation,
        recordsByWorktree: records.recordsByWorktree,
        complete: records.complete && raw.complete !== false
      }
    : null
}

/**
 * The workflow conversation every computer calls the same: its workspace and the anchor tab on
 * the controller. The controller's own row and a receiver's mirrored row both carry it.
 */
export function sessionWorkflowConversationIdentity(worktreeId: string, tabId: string): string {
  return JSON.stringify(['workflow', worktreeId, tabId])
}
