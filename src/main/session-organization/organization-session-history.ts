/**
 * A session's history as the readers show it: the entries kept under its sidebar key plus any
 * recorded before its pane or tab resolved to that key, newest first, with what Undo can still
 * put back.
 */

import type {
  OrganizationHistory,
  OrganizationRecord,
  OrganizationRevocation
} from '../../shared/session-organization-change'
import type { OrganizationChangeLedger } from './organization-change-ledger'

type Ledger = Pick<OrganizationChangeLedger, 'history' | 'undoPlan'>

function newestFirst(left: OrganizationRecord, right: OrganizationRecord): number {
  return left.ts < right.ts ? 1 : left.ts > right.ts ? -1 : 0
}

function unique(records: readonly OrganizationRecord[]): OrganizationRecord[] {
  const seen = new Set<string>()
  return records.filter((record) => {
    const id = `${record.opId}:${record.phase}`
    if (seen.has(id)) {
      return false
    }
    seen.add(id)
    return true
  })
}

/** The first key is the session's own: its ownership and revocations are the ones that count. */
export async function readMergedHistory(
  ledger: Ledger,
  keys: readonly string[]
): Promise<OrganizationHistory> {
  const [primary, ...rest] = await Promise.all(keys.map((key) => ledger.history(key)))
  if (!primary) {
    throw new Error('No session history key to read.')
  }
  const revocations: OrganizationHistory['revocations'] = { ...primary.revocations }
  for (const other of rest) {
    for (const [field, revocation] of Object.entries(other.revocations) as [
      keyof OrganizationHistory['revocations'],
      OrganizationRevocation
    ][]) {
      revocations[field] ??= revocation
    }
  }
  return {
    ...primary,
    revocations,
    entries: unique([primary, ...rest].flatMap((history) => history.entries)).sort(newestFirst),
    pending: unique([primary, ...rest].flatMap((history) => history.pending)).sort(newestFirst)
  }
}

/** Applied changes whose Undo would still put at least one target back. */
export async function undoableOpIds(
  ledger: Ledger,
  records: readonly OrganizationRecord[]
): Promise<string[]> {
  const ids: string[] = []
  for (const record of records) {
    if (record.phase !== 'applied' || ids.includes(record.opId)) {
      continue
    }
    try {
      if ((await ledger.undoPlan(record.opId)).inverse) {
        ids.push(record.opId)
      }
    } catch {
      // Why: an interrupted or pruned change simply is not undoable.
    }
  }
  return ids
}
