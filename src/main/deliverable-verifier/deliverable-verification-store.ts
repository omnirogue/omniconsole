/**
 * The deliverable check's records on this host (`deliverable-verifications.json`), newest last,
 * capped. Each repair also takes an exclusive claim file before it is queued, so a crash can lose a
 * repair prompt but never send one twice.
 */

import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  DeliverableCheck,
  DeliverableVerificationRecord
} from '../../shared/deliverable-verification-types'
import { DELIVERABLE_SOURCES } from '../../shared/deliverable-verification-types'
import { claimInterruptedTurn } from '../agent-hooks/interrupted-session-continuation'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

export const DELIVERABLE_VERIFICATIONS_FILE = 'deliverable-verifications.json'
export const DELIVERABLE_VERIFICATIONS_MAX = 300
const CLAIMS_DIRECTORY = 'deliverable-repair-claims'
const VERDICTS = new Set(['verified', 'missing', 'unverifiable', 'declined'])
const KINDS = new Set(['file', 'directory', 'artifact', 'url'])
const OVERALLS = new Set(['complete', 'incomplete', 'unverifiable'])

const text = (value: unknown, max = 4_096): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0

function readCheck(raw: unknown): DeliverableCheck | null {
  const value = (raw ?? {}) as Record<string, unknown>
  if (
    !text(value.target) ||
    !KINDS.has(value.kind as string) ||
    !(DELIVERABLE_SOURCES as readonly unknown[]).includes(value.source) ||
    !VERDICTS.has(value.verdict as string) ||
    !text(value.detail, 1_000)
  ) {
    return null
  }
  return value as unknown as DeliverableCheck
}

/** A record read back from disk, or null; one unreadable record never costs the others. */
function readRecord(raw: unknown): DeliverableVerificationRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null
  }
  const value = raw as Record<string, unknown>
  const checks = Array.isArray(value.checks) ? value.checks.map(readCheck) : null
  if (
    !text(value.id, 200) ||
    !text(value.paneKey) ||
    !text(value.conversationKey) ||
    !text(value.requestId, 200) ||
    !text(value.action, 200) ||
    !OVERALLS.has(value.overall as string) ||
    (value.mode !== 'shadow' && value.mode !== 'on') ||
    !count(value.repairsSent) ||
    !count(value.checkedAt) ||
    !checks ||
    checks.some((check) => check === null)
  ) {
    return null
  }
  return value as unknown as DeliverableVerificationRecord
}

export class DeliverableVerificationStore {
  private records: DeliverableVerificationRecord[] = []
  private writeChain: Promise<void> = Promise.resolve()
  private writeQueued = false

  constructor(private readonly options: { directory: string }) {}

  private get path(): string {
    return join(this.options.directory, DELIVERABLE_VERIFICATIONS_FILE)
  }

  load(): void {
    let raw: { records?: unknown } | null
    try {
      raw = JSON.parse(readFileSync(this.path, 'utf8')) as typeof raw
    } catch {
      return
    }
    const records = Array.isArray(raw?.records) ? raw.records : []
    this.records = records
      .map(readRecord)
      .filter((entry): entry is DeliverableVerificationRecord => entry !== null)
      .slice(-DELIVERABLE_VERIFICATIONS_MAX)
  }

  list(): DeliverableVerificationRecord[] {
    return this.records.map((record) => ({ ...record, checks: [...record.checks] }))
  }

  /** One pane's records, newest first. */
  forPane(paneKey: string, limit = 20): DeliverableVerificationRecord[] {
    return this.records
      .filter((record) => record.paneKey === paneKey)
      .slice(-limit)
      .toReversed()
  }

  /** The newest record whose repair prompt carried this marker token. */
  byToken(conversationKey: string, token: string): DeliverableVerificationRecord | null {
    return (
      this.records.findLast(
        (record) => record.conversationKey === conversationKey && record.token === token
      ) ?? null
    )
  }

  /** Repairs already sent for one request, counted from the durable records. */
  repairsSent(conversationKey: string, requestId: string): number {
    return this.records.filter(
      (record) =>
        record.conversationKey === conversationKey &&
        record.requestId === requestId &&
        record.action === 'repair-sent'
    ).length
  }

  add(record: DeliverableVerificationRecord): void {
    this.records = [...this.records.filter((entry) => entry.id !== record.id), record].slice(
      -DELIVERABLE_VERIFICATIONS_MAX
    )
    this.persist()
  }

  /** The person said a missing item here is fine: precision data for turning repairs on. */
  markFalseAlarm(id: string, at: number): DeliverableVerificationRecord | null {
    const record = this.records.find((entry) => entry.id === id)
    if (!record) {
      return null
    }
    const marked = { ...record, falseAlarmAt: at }
    this.records = this.records.map((entry) => (entry.id === id ? marked : entry))
    this.persist()
    return marked
  }

  /** True once, ever, per key: the claim is durable before the repair is queued. */
  claimRepair(key: string): boolean {
    return claimInterruptedTurn(join(this.options.directory, CLAIMS_DIRECTORY), key)
  }

  async flush(): Promise<void> {
    await this.writeChain
  }

  private persist(): void {
    if (this.writeQueued) {
      return
    }
    this.writeQueued = true
    const finalPath = this.path
    this.writeChain = this.writeChain
      .then(async () => {
        this.writeQueued = false
        const payload = JSON.stringify({ version: 1, records: this.records })
        await mkdir(this.options.directory, { recursive: true })
        await writeFileDurable(durableWriteTempPath(finalPath), finalPath, payload)
      })
      .catch((error: unknown) => {
        console.error(`[deliverable-check] saving ${finalPath} failed`, error)
      })
  }
}
