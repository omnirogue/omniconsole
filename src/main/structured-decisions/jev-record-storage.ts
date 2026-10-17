import { z } from 'zod'
import type { DecisionRecords } from './decision-records'

/** `pending`: the ledger row was queued but not confirmed in time; a later failure is counted. */
export type JevLedgerStatus = 'saved' | 'failed' | 'pending'
export type JevRecordStorage = (
  | { status: 'saved'; key: string }
  | { status: 'failed'; key: string; reason: 'record_write_failed' }
) & { ledger?: JevLedgerStatus }

/** Reuse the runtime's private atomic record store and report failed persistence to the caller. */
export async function persistJevRecord<T extends object>(
  records: Pick<DecisionRecords, 'write'>,
  key: string,
  record: T,
  ledger?: JevLedgerStatus
): Promise<T & { storage: JevRecordStorage }> {
  const row = ledger ? { ledger } : {}
  const saved = { ...record, storage: { status: 'saved' as const, key, ...row } }
  try {
    await records.write('result', key, saved, z.unknown())
    return saved
  } catch {
    return {
      ...record,
      storage: { status: 'failed', key, reason: 'record_write_failed', ...row }
    }
  }
}
