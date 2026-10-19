import type { SessionPrepRoutingReceipt } from '../shared/session-prep-types'
/**
 * The invoking computer's durable record of each `omni session launch` operation: written before
 * the first send and before every later send, so a timed-out or killed CLI can retry the same
 * operation with the same bytes instead of starting a second session. See
 * docs/reference/agent-launch.md.
 */

import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  AGENT_LAUNCH_REFUSAL_CODES,
  type AgentLaunchAccountReceipt,
  type AgentLaunchEffectiveModel,
  type AgentLaunchHostId
} from '../shared/agent-launch-account'
import type { LaunchPlacement } from '../shared/agent-launch-placement-types'
import {
  parseAgentSessionOperationTimestamp,
  type RuntimeCreateAgentSessionRequest,
  type RuntimeCreateAgentSessionResult
} from '../shared/agent-session-host-authority'
import type { LaunchManifestReport } from '../shared/launch-manifest'
import type { RuntimeTerminalCreate } from '../shared/runtime-types'
import type { SessionContextAttachment } from '../shared/session-context-attachments'
import { writeDurableSecureJsonFile } from '../shared/secure-file'
import { WORK_CONTRACT_REFUSAL_CODES } from '../shared/work-contract-admission'
import { RuntimeClientError } from './runtime/types'

export const LAUNCH_RECORDS_DIR_NAME = 'agent-launch-operations'
export const LAUNCH_INTENTS_DIR_NAME = 'intents'
// Why: longer than the host ledger's 24 h, so a record outlives every replay it can still answer.
export const LAUNCH_KNOWN_OUTCOME_KEEP_MS = 48 * 60 * 60 * 1000
export const LAUNCH_UNVERIFIABLE_KEEP_MS = 30 * 24 * 60 * 60 * 1000

export type AgentLaunchRoute =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string; name: string }

/** The environment id of a route chosen by a pairing code alone, which has no stored name. */
export const PAIRING_CODE_ROUTE_ID = 'pairing-code'

export type AgentLaunchSendOutcome = 'created' | 'replayed' | 'not-started' | 'unverifiable'

export type AgentLaunchSend = {
  at: number
  /** Null until the send settles; a send left null was interrupted and stays unverifiable. */
  outcome: AgentLaunchSendOutcome | null
  code?: string
  message?: string
}

export type AgentLaunchHostReceipt = {
  route: 'local' | 'paired' | 'ssh'
  name: string
  environmentId?: string
  hostId: AgentLaunchHostId
  runtimeId: string
  appVersion: string | null
  why: string
  alsoReachableAs: string[]
  visibleIn: string
}

export type AgentLaunchWorkspaceReceipt = {
  selector: string
  id?: string
  kind?: 'git' | 'folder'
  hostId: AgentLaunchHostId
}

export type AgentLaunchRecord = {
  v: 1
  operationId: string
  /** False for a caller-supplied --operation-id, which is never superseded automatically. */
  minted: boolean
  intentKey: string | null
  createdAt: number
  route: AgentLaunchRoute
  /** status.get on the routed client, read once; a retry never re-reads it. */
  executingRuntimeId: string
  hostId: AgentLaunchHostId
  hostLabel: string
  /**
   * The exact params sent, prompt included; every retry resends these bytes. Null only while a
   * --project placement still prepares its workspace, before any send.
   */
  request: RuntimeCreateAgentSessionRequest | null
  post: {
    title?: string
    titleOrigin?: string
    folderId?: string | null
    projectItems?: SessionContextAttachment[]
    /** `--contract`: its Acceptance lines, bound to a verify step once the session exists. */
    contract?: { title: string; acceptance: string[]; agent: 'claude' | 'codex' }
    /** `--ephemeral`: arm When finished -> End so the session closes automatically when done (unless a question is open). */
    ephemeral?: boolean
    done: boolean
  }
  sends: AgentLaunchSend[]
  outcome: 'pending' | 'created' | 'refused' | 'unverifiable'
  terminal?: RuntimeTerminalCreate
  account?: AgentLaunchAccountReceipt
  launch?: AgentLaunchEffectiveModel
  routing?: SessionPrepRoutingReceipt
  /** Lets a re-run answer already-launched without contacting the host. */
  summary: {
    host: AgentLaunchHostReceipt
    workspace: AgentLaunchWorkspaceReceipt
    manifest: LaunchManifestReport
    project?: unknown
    warnings: string[]
  }
  supersedes?: string
  supersededBy?: string
  /** --project: frozen before any effect; a retry follows it and never ranks again. */
  placement?: LaunchPlacement
}

export type SendableLaunchRecord = AgentLaunchRecord & {
  request: RuntimeCreateAgentSessionRequest
}

/** Only a record with its exact request may be sent; a placement still preparing has none yet. */
export function requireSendableLaunchRecord(record: AgentLaunchRecord): SendableLaunchRecord {
  if (record.request === null) {
    throw new RuntimeClientError(
      'launch_record_incomplete',
      `Operation ${record.operationId} has no recorded request yet, so nothing was sent. Run the same command again to finish preparing it.`,
      { operationId: record.operationId, outcome: 'not-sent', nextSteps: [] }
    )
  }
  return record as SendableLaunchRecord
}

export type AgentLaunchRecordStore = {
  dir: string
  pathOf(operationId: string): string
  read(operationId: string): AgentLaunchRecord | null
  /** Durable: fsync'd file and directory, so a send never precedes its record. */
  write(record: AgentLaunchRecord): void
}

export function agentLaunchRecordStore(userDataPath: string): AgentLaunchRecordStore {
  const dir = join(userDataPath, LAUNCH_RECORDS_DIR_NAME)
  const pathOf = (operationId: string): string => {
    if (parseAgentSessionOperationTimestamp(operationId) === null) {
      throw new RuntimeClientError(
        'invalid_argument',
        'A launch record is named by its operation id.'
      )
    }
    return join(dir, `${operationId}.json`)
  }
  return {
    dir,
    pathOf,
    read: (operationId) => readLaunchRecordFile(pathOf(operationId), operationId),
    // Why: the record carries the brief, so it gets the owner-only 0600 file in a 0700 directory.
    write: (record) => writeDurableSecureJsonFile(pathOf(record.operationId), record)
  }
}

function readLaunchRecordFile(path: string, operationId: string): AgentLaunchRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as AgentLaunchRecord | null
    return record?.v === 1 && record.operationId === operationId && Array.isArray(record.sends)
      ? record
      : null
  } catch {
    return null
  }
}

export function mintLaunchOperationId(now = Date.now()): string {
  return `${now}-${randomBytes(16).toString('hex')}`
}

// Why: an allowlist. Each code is thrown before the host spawns anything; any other failure after
// the request left this computer (timeout, lost socket, uncoded error) may have started a session.
const NOT_STARTED_CODES: ReadonlySet<string> = new Set([
  'method_not_found',
  'agent_session_operation_invalid',
  'agent_session_operation_capacity',
  'agent_session_operation_expired',
  'agent_session_operation_conflict',
  'agent_session_legacy_required',
  ...AGENT_LAUNCH_REFUSAL_CODES,
  ...WORK_CONTRACT_REFUSAL_CODES
])

export type SettledLaunchSend = {
  outcome: AgentLaunchSendOutcome
  code?: string
  message?: string
}

export function classifyLaunchSend(error: unknown): SettledLaunchSend {
  const rawCode = (error as { code?: unknown } | null)?.code
  const code = typeof rawCode === 'string' ? rawCode : undefined
  return {
    outcome: code !== undefined && NOT_STARTED_CODES.has(code) ? 'not-started' : 'unverifiable',
    ...(code !== undefined ? { code } : {}),
    message: error instanceof Error ? error.message : String(error)
  }
}

export function appendLaunchSend<T extends AgentLaunchRecord>(record: T, at: number): T {
  return { ...record, sends: [...record.sends, { at, outcome: null }] }
}

/** Settles the send made at `at`; a created outcome recorded by any send is never downgraded. */
export function settleLaunchSend(
  record: AgentLaunchRecord,
  at: number,
  settled: SettledLaunchSend,
  result?: RuntimeCreateAgentSessionResult
): AgentLaunchRecord {
  const sends = record.sends.map((send) =>
    send.at === at && send.outcome === null ? { ...send, ...settled } : send
  )
  if (result) {
    return {
      ...record,
      sends,
      outcome: 'created',
      terminal: result.terminal,
      ...(result.account ? { account: result.account } : {}),
      ...(result.launch ? { launch: result.launch } : {}),
      ...(result.routing ? { routing: result.routing } : {})
    }
  }
  const outcome =
    record.outcome === 'created'
      ? 'created'
      : settled.outcome === 'not-started'
        ? 'refused'
        : 'unverifiable'
  return { ...record, sends, outcome }
}

/** What the record proves about its operation; a send that never settled stays unverifiable. */
export function recordedLaunchOutcome(
  record: AgentLaunchRecord
): 'not-sent' | 'not-started' | 'unverifiable' {
  if (record.sends.length === 0) {
    return 'not-sent'
  }
  return record.sends.every((send) => send.outcome === 'not-started')
    ? 'not-started'
    : 'unverifiable'
}

function lastActivityAt(record: AgentLaunchRecord): number {
  return Math.max(record.createdAt, ...record.sends.map((send) => send.at))
}

function isKnownOutcome(record: AgentLaunchRecord): boolean {
  return (
    record.outcome === 'created' ||
    (record.outcome === 'refused' && record.sends.every((send) => send.outcome === 'not-started'))
  )
}

/**
 * Deletes known outcomes after 48 h and everything else (pending, unverifiable) after 30 days,
 * then intents whose record is gone. Corrupt files are left for a person to inspect.
 */
export function pruneLaunchRecords(store: AgentLaunchRecordStore, now = Date.now()): void {
  let names: string[]
  try {
    names = readdirSync(store.dir)
  } catch {
    return
  }
  for (const name of names) {
    const operationId = name.endsWith('.json') ? name.slice(0, -'.json'.length) : null
    const record =
      operationId && parseAgentSessionOperationTimestamp(operationId) !== null
        ? store.read(operationId)
        : null
    if (!record) {
      continue
    }
    const keepMs = isKnownOutcome(record)
      ? LAUNCH_KNOWN_OUTCOME_KEEP_MS
      : LAUNCH_UNVERIFIABLE_KEEP_MS
    if (now - lastActivityAt(record) > keepMs) {
      rmSync(store.pathOf(record.operationId), { force: true })
    }
  }
  pruneOrphanIntents(store)
}

function pruneOrphanIntents(store: AgentLaunchRecordStore): void {
  const intentsDir = join(store.dir, LAUNCH_INTENTS_DIR_NAME)
  let names: string[]
  try {
    names = readdirSync(intentsDir)
  } catch {
    return
  }
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const path = join(intentsDir, name)
    try {
      const { operationId } = JSON.parse(readFileSync(path, 'utf8')) as { operationId?: unknown }
      if (typeof operationId === 'string' && existsSync(store.pathOf(operationId))) {
        continue
      }
    } catch {
      // Unreadable intent: it can no longer lead a re-run anywhere, so it goes too.
    }
    rmSync(path, { force: true })
  }
}
