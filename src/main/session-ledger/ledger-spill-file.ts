import type {
  LedgerEvent,
  LedgerEventBatch,
  LedgerEventKind
} from '../../shared/session-ledger-contract'

export const LEDGER_SPILL_MAX_BYTES = 1024 * 1024
export const SPILL_VERSION = 2

/** Dropped last when a cap is hit; a lost tool call is a count, a lost stop is a ghost row. */
export const PRESERVED_KINDS: ReadonlySet<LedgerEventKind> = new Set([
  'session_start',
  'attempt_start',
  'stop'
])

/** The disk spill: pending batches that outlive the process, flushed at next start. */
export type LedgerSpillStore = {
  read(): unknown
  write(value: unknown): void
  remove(): void
  /** Set the file aside (never delete it) when it cannot be read or understood. */
  quarantine(reason: string): void
}

/** What the spill holds: the batch, the account it belongs to, and — ownerless — since when. */
export type SpilledBatch = { account: string | null; batch: LedgerEventBatch; heldSince?: string }
export type SpillFile = { version: number; batches: SpilledBatch[] }

export function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

function isLedgerEvent(value: unknown): value is LedgerEvent {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Partial<LedgerEvent>
  return (
    typeof record.seq === 'number' &&
    typeof record.kind === 'string' &&
    typeof record.at === 'string' &&
    typeof record.detail === 'object' &&
    record.detail !== null
  )
}

function isLedgerBatch(value: unknown): value is LedgerEventBatch {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Partial<LedgerEventBatch>
  return (
    typeof record.ledger_id === 'string' &&
    typeof record.attempt_id === 'string' &&
    typeof record.started_at === 'string' &&
    Array.isArray(record.events) &&
    record.events.every(isLedgerEvent)
  )
}

function isSpilledBatch(value: unknown): value is SpilledBatch {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Partial<SpilledBatch>
  return (
    (record.account === null || typeof record.account === 'string') &&
    (record.heldSince === undefined || typeof record.heldSince === 'string') &&
    isLedgerBatch(record.batch)
  )
}

/** The spill's batches, or null when the value is not a spill file this version can read. */
export function readSpillFile(value: unknown): SpilledBatch[] | null {
  const record = value as Partial<SpillFile> | null
  if (
    !record ||
    typeof record !== 'object' ||
    record.version !== SPILL_VERSION ||
    !Array.isArray(record.batches)
  ) {
    return null
  }
  return record.batches.filter(isSpilledBatch)
}

/**
 * Drop from the oldest event forward — expendable kinds first — until the file fits. The
 * signed-in account's own batches give way first; a held batch of another person (or one
 * still ownerless) is only cut once nothing of the current account's is left to cut.
 */
export function boundSpill(
  batches: SpilledBatch[],
  maxBytes = LEDGER_SPILL_MAX_BYTES,
  current: string | null = null
): SpilledBatch[] {
  const bounded = batches.map((entry) => ({
    ...entry,
    batch: { ...entry.batch, events: [...entry.batch.events] }
  }))
  const dropOne = (preservedToo: boolean, ownedByCurrent: boolean): boolean => {
    for (const { account, batch } of bounded) {
      if ((account === current) !== ownedByCurrent) {
        continue
      }
      const index = batch.events.findIndex(
        (event) => preservedToo || !PRESERVED_KINDS.has(event.kind)
      )
      if (index !== -1) {
        batch.events.splice(index, 1)
        return true
      }
    }
    return false
  }
  const kept = (): SpilledBatch[] => bounded.filter((entry) => entry.batch.events.length > 0)
  const fits = (): boolean => byteLength({ version: SPILL_VERSION, batches: kept() }) <= maxBytes
  while (
    !fits() &&
    (dropOne(false, true) || dropOne(true, true) || dropOne(false, false) || dropOne(true, false))
  ) {
    // shrinking
  }
  return kept()
}
