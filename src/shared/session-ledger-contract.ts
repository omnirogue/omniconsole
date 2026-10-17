import { z } from 'zod'

/**
 * Estate session ledger — the IDE side of LEDGER-CONTRACT.md (§3 events, §10 preload API).
 * Types are the renderer's; the zod schemas decode what the console answers.
 */

export const LEDGER_ID_PATTERN = /^als_[a-f0-9]{24}$/
export const ATTEMPT_ID_PATTERN = /^att_[a-f0-9]{16}$/

export const LEDGER_EVENT_KINDS = [
  'session_start',
  'attempt_start',
  'tool_call',
  'file_write',
  'commit',
  'test_run',
  'handoff',
  'stop',
  'error',
  'work_link'
] as const
export type LedgerEventKind = (typeof LEDGER_EVENT_KINDS)[number]

export type LedgerStopReason = 'turn_end' | 'exit' | 'close' | 'quit'

/** Per-kind detail allowlist (§3). Anything else is stripped server-side, so never send it. */
export type LedgerEventDetail =
  | {
      kind: 'session_start'
      detail: { cwd_kind: 'repo' | 'folder'; agent?: string; model?: string }
    }
  | { kind: 'attempt_start'; detail: { reason: 'resume' | 'reconnect' } }
  | { kind: 'tool_call'; detail: { tool: string; target?: string } }
  | { kind: 'file_write'; detail: { path: string; op: 'edit' | 'create' | 'delete' } }
  | { kind: 'commit'; detail: { subject: string; files: number; sha: string } }
  | {
      kind: 'test_run'
      detail: { runner: string; status: 'pass' | 'fail' | 'error'; count: number }
    }
  | { kind: 'handoff'; detail: { to: string; card_id?: string } }
  | { kind: 'stop'; detail: { reason: LedgerStopReason } }
  | { kind: 'error'; detail: { code: string } }
  /** A Slite doc, omnios page or Claude artifact the session named: history for the Work log. */
  | { kind: 'work_link'; detail: { url: string } }

export type LedgerEvent = LedgerEventDetail & {
  /** Client-monotonic per attempt; the idempotency key with (ledger_id, attempt_id). */
  seq: number
  /** Client time, advisory only. */
  at: string
}

/** Row identity the batch carries. `employee_id` is never sent: identity is the principal. */
export type LedgerBatchEnvelope = {
  ledger_id: string
  attempt_id: string
  app: 'omni-ide'
  agent?: string | null
  model?: string | null
  host?: string | null
  native_session_id?: string | null
  repo?: string | null
  branch?: string | null
  company?: string | null
  domain?: string | null
  card_id?: string | null
  card_title?: string | null
  started_at: string
}

export type LedgerEventBatch = LedgerBatchEnvelope & { events: LedgerEvent[] }

export const LEDGER_BATCH_MAX_EVENTS = 200
export const LEDGER_BATCH_MAX_BYTES = 32 * 1024
export const LEDGER_DETAIL_LIMITS = {
  tool: 64,
  target: 160,
  path: 300,
  subject: 80,
  sha: 40,
  runner: 32,
  to: 64,
  code: 64
} as const

export type LedgerState = 'running' | 'idle' | 'waiting' | 'done' | 'abandoned'

export type LedgerPublicRow = {
  ledger_id: string
  employee_id: string
  employee_name?: string | null
  app: string
  agent?: string | null
  model?: string | null
  host?: string | null
  repo?: string | null
  branch?: string | null
  company?: string | null
  domain?: string | null
  card_id?: string | null
  card_title?: string | null
  state: LedgerState
  started_at: string
  last_activity_at: string
  ended_at?: string | null
  files_touched?: string[]
  last_action?: { kind: string; target: string } | null
  activity_summary?: {
    edits?: number
    commits?: number
    tests?: number
    tool_calls?: number
    handoffs?: number
    top_files?: string[]
  }
}

export type LedgerUnavailableReason = 'offline' | 'signed-out' | 'unavailable'

export type LedgerNowResult =
  | { ok: true; rows: LedgerPublicRow[]; overflow: number; server_time: string }
  | { ok: false; reason: LedgerUnavailableReason }

export type LedgerPeer = {
  ledger_id: string
  /** Public per contract §2; lets the renderer exclude itself exactly. */
  employee_id?: string | null
  employee_name?: string | null
  reason: string
  shared_files?: string[]
}

export type LedgerPeersResult = { ok: true; peers: LedgerPeer[] } | { ok: false; reason: string }

export type LedgerLocalSession = {
  paneId: string
  ledgerId: string
  attemptId: string
  repo?: string | null
  branch?: string | null
  cardId?: string | null
}

export type SessionLedgerApi = {
  /** Historical task binding, without a claim that the pane's process is live. */
  taskLink?(paneKey: string): Promise<LedgerTaskLink | null>
  now(scope: 'live' | 'today'): Promise<LedgerNowResult>
  peers(ledgerId: string): Promise<LedgerPeersResult>
  /** The live local panes and their ledger ids. */
  localSessions(): Promise<LedgerLocalSession[]>
  /** ⏳ mark → register({waiting}). */
  setWaiting(ledgerId: string, waiting: boolean): Promise<void>
  /**
   * "Add to a task" → register({card_id, card_title}) on this pane's row. `paneId` is the pane
   * key or the ledger id; answers false when this desktop holds no row for it.
   */
  linkCard(
    paneId: string,
    card: { cardId: string | null; cardTitle: string | null }
  ): Promise<boolean>
  /** Banner mute, persisted per profile. */
  muteRepo(repo: string, muted: boolean): Promise<void>
  mutedRepos(): Promise<string[]>
  onLocalSessionsChanged(cb: (rows: LedgerLocalSession[]) => void): () => void
}

export type LedgerTaskLink = { ledgerId: string; cardId: string; cardTitle: string | null }

export const SESSION_LEDGER_IPC_PREFIX = 'session-ledger:'

// ── Console response schemas ──────────────────────────────────────────────────

const nullableText = z.string().nullable().optional()
const ledgerState = z.enum(['running', 'idle', 'waiting', 'done', 'abandoned'])

export const ledgerPublicRowSchema = z
  .object({
    ledger_id: z.string(),
    employee_id: z.string(),
    employee_name: nullableText,
    app: z.string(),
    agent: nullableText,
    model: nullableText,
    host: nullableText,
    repo: nullableText,
    branch: nullableText,
    company: nullableText,
    domain: nullableText,
    card_id: nullableText,
    card_title: nullableText,
    state: ledgerState,
    started_at: z.string(),
    last_activity_at: z.string(),
    ended_at: nullableText,
    files_touched: z.array(z.string()).optional(),
    last_action: z.object({ kind: z.string(), target: z.string() }).nullable().optional(),
    activity_summary: z
      .object({
        edits: z.number().optional(),
        commits: z.number().optional(),
        tests: z.number().optional(),
        tool_calls: z.number().optional(),
        handoffs: z.number().optional(),
        top_files: z.array(z.string()).optional()
      })
      .optional()
  })
  // Why: a row that fails one optional field must not blank the whole view; unknown keys pass.
  .passthrough()

/** Rows are validated one by one: a malformed row is dropped (one warning), the rest stay. */
const ledgerPublicRowsSchema = z.array(z.unknown()).transform((rows): LedgerPublicRow[] => {
  const kept: LedgerPublicRow[] = []
  let dropped = 0
  for (const row of rows) {
    const parsed = ledgerPublicRowSchema.safeParse(row)
    if (parsed.success) {
      kept.push(parsed.data as LedgerPublicRow)
    } else {
      dropped += 1
    }
  }
  if (dropped > 0) {
    console.warn(`[session-ledger] dropped ${dropped} malformed row(s) from the console answer`)
  }
  return kept
})

export const ledgerNowResponseSchema = z
  .object({
    ok: z.literal(true).optional(),
    rows: ledgerPublicRowsSchema,
    overflow: z.number().int().nonnegative().default(0),
    server_time: z.string()
  })
  .passthrough()

export const ledgerPeersResponseSchema = z
  .object({
    peers: z.array(
      z
        .object({
          ledger_id: z.string(),
          employee_id: nullableText,
          employee_name: nullableText,
          reason: z.string(),
          shared_files: z.array(z.string()).optional()
        })
        .passthrough()
    )
  })
  .passthrough()

export const ledgerEventsAcceptedSchema = z
  .object({
    ok: z.literal(true).optional(),
    accepted: z.number().int().nonnegative().default(0),
    duplicates: z.number().int().nonnegative().default(0),
    rejected: z.array(z.object({ seq: z.number(), reason: z.string() }).passthrough()).default([]),
    state: ledgerState.optional()
  })
  .passthrough()

export const ledgerRegisterResponseSchema = z.object({}).passthrough()

export type LedgerEventsAccepted = z.infer<typeof ledgerEventsAcceptedSchema>

/** Enrichment body for `POST /api/agent-sessions/{ledger_id}/register` (§5). */
export type LedgerRegisterBody = {
  repo?: string | null
  branch?: string | null
  company?: string | null
  domain?: string | null
  card_id?: string | null
  card_title?: string | null
  waiting?: boolean
  files_touched?: string[]
}
