import { readFileSync } from 'node:fs'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type Database from '../../sqlite/sync-database'
import type { LocalWorkflowRunStatus } from '../../../shared/local-workflow-rpc'

export type DiscoverDeliveryMarker = {
  state: 'prepared' | 'launching' | 'launched' | 'failed' | 'unknown'
  at: string
  operationId: string
  attempts: number
  paneKey?: string | null
  desk?: 'claude' | 'codex'
  error?: string
}

export async function readDiscoverLaunchMarker(
  path: string
): Promise<DiscoverDeliveryMarker | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as DiscoverDeliveryMarker
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export const writeDiscoverLaunchMarker = async (
  path: string,
  marker: DiscoverDeliveryMarker
): Promise<void> => {
  await writeFile(`${path}.tmp`, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 })
  await rename(`${path}.tmp`, path)
}

export type OutboxKind = 'discover' | 'evolve'

export type EvolveDecisionResolution = 'promote_winner' | 'keep_incumbent' | 'rerun_higher_budget'

export type EvolveOutboxDecisionRecord = {
  runId: string
  kind: OutboxKind
  winnerCandidateId: string
  winnerDigest: string
  idempotencyKey: string
  decisionId: string
  state: 'pending' | 'published' | 'promoted' | 'kept' | 'rerun' | 'failed'
  resolution?: EvolveDecisionResolution | null
  resolvedAt?: string | null
  url?: string | null
  baselineScore?: number | null
  challengerScore?: number | null
  heldOutDelta?: number | null
  blindAuditScore?: string | null
  blindAuditPassed?: boolean | null
  creditsSpent?: number | null
  spendUsd?: number | null
  summaryLine?: string
  /** Why the last publish was refused; cleared once OmniOS has the page. */
  error?: string | null
  updatedAt: string
}

export function buildOutboxIdempotencyKey(
  runId: string,
  winnerDigest: string,
  kind: OutboxKind = 'discover'
): string {
  return `${kind}:${runId}:${winnerDigest || 'none'}`
}

const initialized = new WeakSet<Database.Database>()

function ensureOutboxSchema(db: Database.Database): void {
  if (initialized.has(db)) {
    return
  }
  db.exec(`CREATE TABLE IF NOT EXISTS discover_omnios_outbox (
    run_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'discover',
    winner_digest TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT,
    marker_json TEXT,
    decision_json TEXT,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    published_url TEXT
  )`)
  const cols = new Set(
    (
      db.prepare('PRAGMA table_info(discover_omnios_outbox)').all() as {
        name: string
      }[]
    ).map((col) => col.name)
  )
  if (!cols.has('kind')) {
    db.exec("ALTER TABLE discover_omnios_outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'discover'")
  }
  if (!cols.has('winner_digest')) {
    db.exec("ALTER TABLE discover_omnios_outbox ADD COLUMN winner_digest TEXT NOT NULL DEFAULT ''")
  }
  if (!cols.has('idempotency_key')) {
    db.exec('ALTER TABLE discover_omnios_outbox ADD COLUMN idempotency_key TEXT')
  }
  if (!cols.has('decision_json')) {
    db.exec('ALTER TABLE discover_omnios_outbox ADD COLUMN decision_json TEXT')
  }
  initialized.add(db)
}

/** Kept beside the workflow journal; old launch.json files are imported on the first retry. */
export function discoverOutbox(db: Database.Database) {
  ensureOutboxSchema(db)
  return {
    enqueue(
      id: string,
      options?: {
        kind?: OutboxKind
        winnerDigest?: string
        decision?: EvolveOutboxDecisionRecord
      }
    ): void {
      const kind = options?.kind ?? 'discover'
      const winnerDigest = options?.winnerDigest ?? ''
      const idempotencyKey = buildOutboxIdempotencyKey(id, winnerDigest, kind)
      const decisionJson = options?.decision ? JSON.stringify(options.decision) : null
      db.prepare(
        `INSERT OR IGNORE INTO discover_omnios_outbox(
          run_id, kind, winner_digest, idempotency_key, decision_json
        ) VALUES (?, ?, ?, ?, ?)`
      ).run(id, kind, winnerDigest, idempotencyKey, decisionJson)
    },
    has(id: string): boolean {
      return !!db.prepare('SELECT run_id FROM discover_omnios_outbox WHERE run_id=?').get(id)
    },
    hasIdempotencyKey(idempotencyKey: string): boolean {
      return !!db
        .prepare('SELECT run_id FROM discover_omnios_outbox WHERE idempotency_key=?')
        .get(idempotencyKey)
    },
    read(id: string): DiscoverDeliveryMarker | null {
      const row = db
        .prepare('SELECT marker_json FROM discover_omnios_outbox WHERE run_id=?')
        .get(id) as { marker_json: string | null } | undefined
      return row?.marker_json ? (JSON.parse(row.marker_json) as DiscoverDeliveryMarker) : null
    },
    write(id: string, marker: DiscoverDeliveryMarker): void {
      db.prepare('UPDATE discover_omnios_outbox SET marker_json=? WHERE run_id=?').run(
        JSON.stringify(marker),
        id
      )
    },
    readDecision(id: string): EvolveOutboxDecisionRecord | null {
      const row = db
        .prepare('SELECT decision_json, published_url FROM discover_omnios_outbox WHERE run_id=?')
        .get(id) as { decision_json: string | null; published_url: string | null } | undefined
      if (!row?.decision_json) {
        return null
      }
      const parsed = JSON.parse(row.decision_json) as EvolveOutboxDecisionRecord
      return row.published_url && !parsed.url
        ? {
            ...parsed,
            url: row.published_url,
            state: parsed.state === 'pending' ? 'published' : parsed.state
          }
        : parsed
    },
    writeDecision(id: string, decision: EvolveOutboxDecisionRecord): void {
      db.prepare(
        `UPDATE discover_omnios_outbox
         SET kind=?, winner_digest=?, idempotency_key=?, decision_json=?, published_url=COALESCE(?, published_url)
         WHERE run_id=?`
      ).run(
        decision.kind,
        decision.winnerDigest,
        decision.idempotencyKey,
        JSON.stringify(decision),
        decision.url ?? null,
        id
      )
    },
    defer(id: string, at: number): void {
      db.prepare('UPDATE discover_omnios_outbox SET next_attempt_at=? WHERE run_id=?').run(at, id)
    },
    published(id: string, url: string): void {
      db.prepare('UPDATE discover_omnios_outbox SET published_url=? WHERE run_id=?').run(url, id)
    },
    due(id: string): boolean {
      const row = db
        .prepare('SELECT next_attempt_at FROM discover_omnios_outbox WHERE run_id=?')
        .get(id) as { next_attempt_at: number } | undefined
      return !row || row.next_attempt_at <= Date.now()
    }
  }
}

function readJson(root: string, id: string, name: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(root, id, name), 'utf8').slice(0, 64 * 1024))
  } catch {
    return null
  }
}

export function discoverPublishedUrl(root: string, id: string): string | undefined {
  const reply = readJson(root, id, 'published.json')
  const url = (reply?.result as { shareUrl?: unknown } | undefined)?.shareUrl
  return reply?.ok === true && typeof url === 'string' && url.startsWith('https://')
    ? url
    : undefined
}

/** A launched session is pending delivery until its publish receipt names a page. */
export function discoverOmniosStatus(
  root: string,
  id: string,
  db?: Database.Database
): LocalWorkflowRunStatus['omnios'] {
  const marker =
    (db ? discoverOutbox(db).read(id) : null) ??
    (readJson(root, id, 'launch.json') as Partial<DiscoverDeliveryMarker> | null)
  const url = discoverPublishedUrl(root, id)
  if (!marker?.state && !url) {
    return db && discoverOutbox(db).has(id) ? { state: 'pending' } : undefined
  }
  return {
    state: url ? 'published' : marker?.state === 'launched' ? 'pending' : marker!.state!,
    ...(typeof marker?.at === 'string' ? { at: marker.at } : {}),
    ...(typeof marker?.attempts === 'number' ? { attempts: marker.attempts } : {}),
    ...(typeof marker?.error === 'string' ? { error: marker.error } : {}),
    ...(url ? { url } : {})
  }
}
