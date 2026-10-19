/**
 * The repair prompts a finished outcome's missing files earned, per outcome revision and plan
 * version (`session-outcome-deliverable-repair.ts`).
 *
 * Host-local and outside the outcome set: that set's schema is strict, so a field an older paired
 * client or build cannot read would make it refuse the whole plan. Each record is written durably
 * before its prompt is admitted, so a restart counts the same budget and never sends one twice.
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { getAppEnvironment, hasAppEnvironment } from '../../shared/app-environment'
import { durableWriteTempPath, writeFileDurableSync } from '../durable-file-write'

export const SESSION_OUTCOME_DELIVERABLE_REPAIRS_FILE = 'session-outcome-deliverable-repairs.json'
// Why a cap: records outlive their runs; the oldest go first, long after their budget mattered.
const MAX_RECORDS = 500

const id = z.string().min(1).max(200)
const at = z.number().finite().nonnegative()
const diagnostic = z.string().trim().min(1).max(1_000)

const repairSchema = z
  .object({
    chainId: id,
    outcomeId: id,
    outcomeRevision: z.number().int().positive(),
    planVersion: z.number().int().positive(),
    attempt: z.number().int().positive(),
    /** The prompt-queue entry carrying the repair; absent on an `unrepairable` record. */
    promptId: id.optional(),
    /** The finished turn the prompt followed: the NEXT ending is the repair turn ending. */
    turnVersion: z.string().min(1).max(500).optional(),
    /** The file conditions still unproven when the prompt was written. */
    conditionIds: z.array(id).max(64),
    createdAt: at,
    deliveredAt: at.optional(),
    settledAt: at.optional(),
    /** The send's result is unknown: it counts, and is never sent again. */
    failed: diagnostic.optional(),
    /** Nothing can deliver a repair (the conversation is gone): the outcome fails as before. */
    unrepairable: diagnostic.optional()
  })
  .strict()
export type SessionOutcomeDeliverableRepair = z.infer<typeof repairSchema>
export type SessionOutcomeDeliverableRepairKey = Pick<
  SessionOutcomeDeliverableRepair,
  'chainId' | 'outcomeId' | 'outcomeRevision' | 'planVersion'
>

const fileSchema = z.object({ v: z.literal(1), records: z.array(z.unknown()) })

function readRecords(path: string | null): SessionOutcomeDeliverableRepair[] {
  if (!path) {
    return []
  }
  try {
    const parsed = fileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) {
      return []
    }
    // One unreadable record costs itself, never the budget the others hold.
    return parsed.data.records.flatMap((entry) => {
      const record = repairSchema.safeParse(entry)
      return record.success ? [record.data] : []
    })
  } catch {
    return []
  }
}

function sameKey(
  record: SessionOutcomeDeliverableRepairKey,
  key: SessionOutcomeDeliverableRepairKey
): boolean {
  return (
    record.chainId === key.chainId &&
    record.outcomeId === key.outcomeId &&
    record.outcomeRevision === key.outcomeRevision &&
    record.planVersion === key.planVersion
  )
}

export class SessionOutcomeDeliverableRepairStore {
  private records: SessionOutcomeDeliverableRepair[]

  /** `path: null` keeps the records in memory only (tests). */
  constructor(private readonly path: string | null) {
    this.records = readRecords(path)
  }

  list(key: SessionOutcomeDeliverableRepairKey): SessionOutcomeDeliverableRepair[] {
    return this.records.filter((record) => sameKey(record, key))
  }

  /** Durable before it returns: a write that fails throws, and the caller sends nothing. */
  add(record: SessionOutcomeDeliverableRepair): void {
    this.commit([...this.records, repairSchema.parse(record)].slice(-MAX_RECORDS))
  }

  update(promptId: string, patch: Partial<SessionOutcomeDeliverableRepair>): void {
    this.commit(
      this.records.map((record) =>
        record.promptId === promptId ? repairSchema.parse({ ...record, ...patch }) : record
      )
    )
  }

  /** Only for a prompt the send door refused before any byte moved. */
  remove(promptId: string): void {
    this.commit(this.records.filter((record) => record.promptId !== promptId))
  }

  private commit(next: SessionOutcomeDeliverableRepair[]): void {
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileDurableSync(
        durableWriteTempPath(this.path),
        this.path,
        JSON.stringify({ v: 1, records: next })
      )
    }
    this.records = next
  }
}

let installed: SessionOutcomeDeliverableRepairStore | null = null

/** Installed by the host that runs outcomes; without one, a missing file fails as it always did. */
export function installSessionOutcomeDeliverableRepairStore(
  store: SessionOutcomeDeliverableRepairStore | null
): void {
  installed = store
}

export function sessionOutcomeDeliverableRepairStore(): SessionOutcomeDeliverableRepairStore | null {
  return installed
}

/** The profile's own record, opened once by the host that starts running outcomes. */
export function installProfileSessionOutcomeDeliverableRepairs(): void {
  if (installed || !hasAppEnvironment()) {
    return
  }
  installed = new SessionOutcomeDeliverableRepairStore(
    join(getAppEnvironment().getPath('userData'), SESSION_OUTCOME_DELIVERABLE_REPAIRS_FILE)
  )
}
