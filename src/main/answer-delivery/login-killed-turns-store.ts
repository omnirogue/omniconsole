/**
 * Turns a login failure killed, kept on disk so a restart neither forgets nor repeats one:
 * `<userData>/answer-delivery/login-killed-turns.json`, one record per (conversation, failure).
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

/** The answer-delivery `held_reason` vocabulary this resume can hit. */
export type LoginKilledHeldReason =
  | 'login_failed'
  | 'account_at_limit'
  | 'no_window'
  | 'busy'
  | 'unverifiable'
  | 'not_found'
  | 'protection'
  | 'transcript_gone'
  | 'error'

export type LoginKilledTurnState =
  /** Waiting for the login or the pane; `heldReason` says which. */
  | 'pending'
  /** Its conversation was reopened; the continue prompt goes once it reports in `target`. */
  | 'reopening'
  /** The continue prompt is queued for `target`. */
  | 'queued'
  /** Settled: the continue prompt was delivered. */
  | 'resumed'
  /** Settled without a resume; `heldReason` and `detail` say why. */
  | 'held'
  /** Settled: newer work ran in the conversation, so nothing is cut off any more. */
  | 'superseded'

export type LoginKilledTurn = {
  /** sha256 of (ref, killedAt): the same failure seen twice is one record. */
  id: string
  ref: string
  sessionId: string
  provider: 'claude' | 'codex'
  paneKey: string
  worktreeId: string
  /** CLAUDE_CONFIG_DIR / CODEX_HOME its transcript lives under: the login checked before resuming. */
  home: string | null
  /** The model the cut-off turn ran on, for a resume that starts from the transcript. */
  model?: string
  killedAt: number
  /** What the provider said, bounded. */
  reason: string
  state: LoginKilledTurnState
  heldReason?: LoginKilledHeldReason
  detail?: string
  target?: { paneKey: string; worktreeId?: string }
  promptId?: string
  reopenedAt?: number
  /** When the continue prompt was first seen delivered; `resumed` follows once the agent takes it up. */
  deliveredAt?: number
  /** Resume refusals that changed nothing; bounded so a refusing conversation settles. */
  refusals?: number
  recordedAt: number
  updatedAt: number
  settledAt?: number
}

const SETTLED_STATES = new Set<LoginKilledTurnState>(['resumed', 'held', 'superseded'])
const SETTLED_KEEP_MS = 30 * 24 * 60 * 60_000
const MAX_RECORDS = 500

export const isLoginKilledTurnSettled = (record: LoginKilledTurn): boolean =>
  SETTLED_STATES.has(record.state)

export function loginKilledTurnsPath(userDataPath: string): string {
  return join(userDataPath, 'answer-delivery', 'login-killed-turns.json')
}

function readRecords(path: string): Map<string, LoginKilledTurn> {
  const records = new Map<string, LoginKilledTurn>()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return records
  }
  const list = (parsed as { records?: unknown })?.records
  for (const value of Array.isArray(list) ? list : []) {
    const record = value as LoginKilledTurn
    if (
      typeof record?.id === 'string' &&
      typeof record.ref === 'string' &&
      typeof record.paneKey === 'string' &&
      typeof record.killedAt === 'number' &&
      typeof record.state === 'string'
    ) {
      records.set(record.id, record)
    }
  }
  return records
}

export class LoginKilledTurnStore {
  private records: Map<string, LoginKilledTurn> | null = null

  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now
  ) {}

  private load(): Map<string, LoginKilledTurn> {
    this.records ??= readRecords(this.path)
    return this.records
  }

  private save(): void {
    const records = this.load()
    const now = this.now()
    for (const [id, record] of records) {
      if (record.settledAt !== undefined && now - record.settledAt > SETTLED_KEEP_MS) {
        records.delete(id)
      }
    }
    // Why settled first: an unsettled record is never dropped to make room.
    const overflow = [...records.values()]
      .sort(
        (a, b) =>
          Number(!isLoginKilledTurnSettled(a)) - Number(!isLoginKilledTurnSettled(b)) ||
          a.updatedAt - b.updatedAt
      )
      .slice(0, Math.max(0, records.size - MAX_RECORDS))
    for (const record of overflow) {
      records.delete(record.id)
    }
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileAtomically(
      this.path,
      `${JSON.stringify({ version: 1, records: [...records.values()] }, null, 2)}\n`
    )
  }

  list(): LoginKilledTurn[] {
    return [...this.load().values()].sort((a, b) => a.killedAt - b.killedAt)
  }

  get(id: string): LoginKilledTurn | undefined {
    return this.load().get(id)
  }

  /** Records a newly seen failure; false when this (conversation, failure) is already recorded. */
  add(record: Omit<LoginKilledTurn, 'state' | 'recordedAt' | 'updatedAt'>): boolean {
    const records = this.load()
    if (records.has(record.id)) {
      return false
    }
    const now = this.now()
    records.set(record.id, { ...record, state: 'pending', recordedAt: now, updatedAt: now })
    this.save()
    return true
  }

  /** Moves a record on; a settled record never changes again. */
  update(id: string, patch: Partial<Omit<LoginKilledTurn, 'id' | 'ref'>>): LoginKilledTurn | null {
    const records = this.load()
    const current = records.get(id)
    if (!current || isLoginKilledTurnSettled(current)) {
      return null
    }
    const now = this.now()
    const next: LoginKilledTurn = { ...current, ...patch, updatedAt: now }
    if (isLoginKilledTurnSettled(next)) {
      next.settledAt = now
    }
    records.set(id, next)
    this.save()
    return next
  }
}
